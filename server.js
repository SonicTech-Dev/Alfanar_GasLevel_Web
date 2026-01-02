// server.js
// Express server that calls the SOAP TerminalGetInfo method,
// extracts exactly these fields from the SOAP response:
//   - id  (terminal identifier, integer)
//   - sn  (serial number / Name)
//   - tank_level (numeric percent)
//   - timestamp (ISO string from LastContact)
// Then saves them into your existing "tank_level" table (columns: id, sn, tank_level, timestamp).
//
// Fixes applied in this version:
// - Avoids using ON CONFLICT (id) which failed when no unique constraint existed.
//   Instead it performs an UPDATE ... RETURNING; if no row updated, it INSERTs.
// - Validates/parses timestamp before writing; invalid timestamps are written as NULL
//   to prevent "invalid input syntax for type timestamp" errors.
// - Ensures tank_level receives a numeric value (or NULL when unparsable).
//
// Requirements:
//   npm install express node-fetch@2 xml2js pg dotenv
//
// Environment variables:
//   DATABASE_URL, SOAP_URL, SOAP_ACTION, SOAP_USERNAME, SOAP_PASSWORD, PORT

require('dotenv').config();

const express = require('express');
const fetch = require('node-fetch'); // v2
const { parseStringPromise } = require('xml2js');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3007;

const SOAP_URL = process.env.SOAP_URL || 'https://webvision.digimatic.it/api/2/service.php';
const SOAP_ACTION = process.env.SOAP_ACTION || 'https://webvision.digimatic.it/api/2/TerminalGetInfo';
const SOAP_USERNAME = process.env.SOAP_USERNAME || '';
const SOAP_PASSWORD = process.env.SOAP_PASSWORD || '';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

let dbAvailable = false;
let lastDbError = null;

async function testDb() {
  try {
    const client = await pool.connect();
    client.release();
    dbAvailable = true;
    console.log('Postgres: connected successfully');
  } catch (err) {
    dbAvailable = false;
    lastDbError = err && err.message;
    console.warn('Postgres: connection failed at startup:', lastDbError);
  }
}
testDb().catch(e => console.warn('DB test error', e && e.message));

app.use(express.static(path.join(__dirname, 'public')));

/* XML helpers */
function nodeText(v) {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v) && v.length > 0) return nodeText(v[0]);
  if (typeof v === 'object') {
    if (typeof v._ === 'string') return v._;
    if (typeof v['#text'] === 'string') return v['#text'];
    for (const val of Object.values(v)) {
      const t = nodeText(val);
      if (t) return t;
    }
  }
  return null;
}

function collectItems(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'item') {
      if (Array.isArray(v)) out.push(...v);
      else out.push(v);
    } else if (typeof v === 'object') {
      collectItems(v, out);
    }
  }
  return out;
}

function extractField(target, keys) {
  if (!target || typeof target !== 'object') return null;
  for (const k of keys) {
    if (k in target) {
      const t = nodeText(target[k]);
      if (t != null && String(t).trim() !== '') return String(t).trim();
    }
  }
  for (const v of Object.values(target)) {
    const t = nodeText(v);
    if (t != null && String(t).trim() !== '') return String(t).trim();
  }
  return null;
}

function findLivelloItem(items) {
  if (!Array.isArray(items)) return null;
  const candidateNameKeys = ['Name','name','Nome','nome','Key','key','Description','description','Descrizione','descrizione','Label','label'];
  for (const it of items) {
    for (const k of candidateNameKeys) {
      if (k in it) {
        const txt = nodeText(it[k]);
        if (!txt) continue;
        const u = txt.toString().trim().toUpperCase();
        if (u === 'LIVELLO' || u === 'LEVEL' || u === 'TANK LEVEL') return it;
      }
    }
  }
  for (const it of items) {
    for (const v of Object.values(it)) {
      const txt = nodeText(v);
      if (txt) {
        const u = txt.toString().trim().toUpperCase();
        if (u.includes('LIVELLO') || u.includes('LEVEL') || u.includes('TANK LEVEL')) return it;
      }
    }
  }
  const numericCandidates = items.filter(it => {
    const v = nodeText(it.Value) || nodeText(it.Valore) || nodeText(it.value) || nodeText(it.valore);
    if (!v) return false;
    return /-?\d+([.,]\d+)?\s*%?$/.test(String(v).trim());
  });
  if (numericCandidates.length === 1) return numericCandidates[0];
  return null;
}

function findFirstKeyAnywhere(obj, candidateKeys = []) {
  if (!obj || typeof obj !== 'object') return null;
  const lc = candidateKeys.map(k => k.toLowerCase());
  for (const [k, v] of Object.entries(obj)) {
    if (lc.includes(k.toLowerCase())) {
      const t = nodeText(v);
      if (t != null && String(t).trim() !== '') return String(t).trim();
    }
  }
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const el of v) {
        const found = findFirstKeyAnywhere(el, candidateKeys);
        if (found) return found;
      }
    } else if (typeof v === 'object') {
      const found = findFirstKeyAnywhere(v, candidateKeys);
      if (found) return found;
    }
  }
  return null;
}

function buildSoapBody(terminalId) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:api="http://webservice.api.shitek.it/">
  <soap:Body>
    <TerminalGetInfo>
      <TerminalId>${terminalId}</TerminalId>
    </TerminalGetInfo>
  </soap:Body>
</soap:Envelope>`;
}

function parseNumericValue(text) {
  if (text == null) return null;
  try {
    const s = String(text).trim().replace(',', '.').replace('%', '').replace(/\s+/g,'');
    const m = s.match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  } catch (e) {
    return null;
  }
}

function validateTimestamp(ts) {
  if (!ts) return null;
  // Accept ISO-like timestamps or RFC-like; try Date parsing
  const parsed = new Date(String(ts));
  if (!isNaN(parsed.getTime())) return parsed.toISOString();
  // fallback: look for common datetime pattern YYYY-MM-DD
  const isoLike = String(ts).match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  if (isoLike) return new Date(isoLike[0]).toISOString();
  return null;
}

/* DB write: UPDATE then INSERT (avoids requiring a UNIQUE/PK on id for ON CONFLICT) */
async function upsertTankLevel({ idVal, snVal, numericLevelVal, timestampVal }) {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    // try to UPDATE first
    const updateSql = `UPDATE tank_level SET sn = $2, tank_level = $3, timestamp = $4 WHERE id = $1 RETURNING id;`;
    const upd = await client.query(updateSql, [
      idVal != null ? parseInt(idVal, 10) : null,
      snVal || null,
      numericLevelVal != null ? numericLevelVal : null,
      timestampVal || null
    ]);
    if (upd.rowCount && upd.rowCount > 0) {
      // updated existing row
      return { action: 'updated' };
    }
    // else INSERT
    const insertSql = `INSERT INTO tank_level (id, sn, tank_level, timestamp) VALUES ($1, $2, $3, $4);`;
    await client.query(insertSql, [
      idVal != null ? parseInt(idVal, 10) : null,
      snVal || null,
      numericLevelVal != null ? numericLevelVal : null,
      timestampVal || null
    ]);
    return { action: 'inserted' };
  } finally {
    client.release();
  }
}

/* API: /api/tank?terminalId=... */
app.get('/api/tank', async (req, res) => {
  try {
    const terminalId = req.query.terminalId;
    if (!terminalId) return res.status(400).json({ error: 'terminalId query parameter is required' });

    const soapBody = buildSoapBody(terminalId);
    const headers = { 'Content-Type': 'text/xml; charset=utf-8' };
    if (SOAP_ACTION) headers['SOAPAction'] = SOAP_ACTION;
    if (SOAP_USERNAME) headers['Authorization'] = 'Basic ' + Buffer.from(`${SOAP_USERNAME}:${SOAP_PASSWORD}`).toString('base64');

    const response = await fetch(SOAP_URL, { method: 'POST', headers, body: soapBody });
    const respText = await response.text().catch(() => '');

    if (!response.ok) {
      console.warn(`SOAP endpoint returned ${response.status} ${response.statusText} for terminal ${terminalId}`);
      console.warn('SOAP response (truncated):', respText && respText.substring(0, 2000));
      return res.status(502).json({ error: 'Bad response from SOAP service', status: response.status, body: respText.slice(0, 1500) });
    }

    let parsed;
    try {
      parsed = await parseStringPromise(respText, { explicitArray: false, ignoreAttrs: false });
    } catch (parseErr) {
      console.warn('Failed to parse SOAP XML response:', parseErr && parseErr.message);
      return res.status(500).json({ error: 'Failed to parse SOAP XML', details: parseErr && parseErr.message });
    }

    const items = collectItems(parsed);

    // Filter only items of type "InfoVariable" and Name as "LIVELLO"
    const target = items.find(item => {
      const type = item && item['$'] && item['$']['xsi:type'];
      const name = item && item['Name'];
      return type === 'ns1:InfoVariable' && nodeText(name).trim().toUpperCase() === 'LIVELLO';
    });

    if (!target) {
      console.warn('No valid LIVELLO InfoVariable found for terminal:', terminalId);
      return res.status(404).json({ error: 'Device Offline' });
    }

    const valueKeys = ['Value','value'];
    const timeKeys = ['Timestamp','timestamp'];
    const idKeys = ['Id','ID'];
    const snKeys = ['Name','NAME'];

    // Extract fields from the filtered InfoVariable
    const rawValue = extractField(target, valueKeys);
    const timestampRaw = extractField(target, timeKeys);
    const timestampIso = validateTimestamp(timestampRaw);

    const idField = extractField(target, idKeys) || terminalId;
    const snField = extractField(target, snKeys);

    const numericValue = parseNumericValue(rawValue);

    // Persist to your existing table (id, sn, tank_level, timestamp)
    try {
      const result = await upsertTankLevel({
        idVal: idField,
        snVal: snField,
        numericLevelVal: numericValue,
        timestampVal: timestampIso
      });
      // log action for visibility
      if (result && result.action) {
        console.log(`Saved terminal ${idField} -> ${result.action}`);
      }
    } catch (dbErr) {
      console.warn('Failed to write to tank_level table:', dbErr && dbErr.message);
      return res.status(500).json({ error: 'DB insert/update failed', details: dbErr && dbErr.message });
    }

    return res.json({ value: rawValue, timestamp: timestampRaw });
  } catch (err) {
    console.error('Error in /api/tank', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* Minimal diagnostics */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), dbAvailable });
});

app.get('/internal/dbstatus', (req, res) => {
  res.json({ dbAvailable, lastDbError });
});

/* Start server */
const server = app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

/* Graceful shutdown */
async function shutdown() {
  console.log('Shutting down server...');
  try { await server.close(); } catch (e) { /* ignore */ }
  try { await pool.end(); } catch (e) { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
