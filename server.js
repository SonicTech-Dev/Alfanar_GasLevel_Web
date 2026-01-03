// server.js
// Updated: always INSERT a new row for each reading (log-style).
// - Removed the UPDATE-then-INSERT behavior; now every call inserts a new row.
// - Keeps using terminal-level Id/Name from the InfoTerminal ("return") section
//   for the id and sn columns.
// - The DB 'no' column is assumed to be handled server-side by Postgres default/sequence.

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

/* NEW: find the InfoTerminal (the "return") node in the parsed SOAP response */
function findInfoTerminal(obj) {
  if (!obj || typeof obj !== 'object') return null;
  // If this object looks like an InfoTerminal (has Id and Name), return it
  if ((('Id' in obj) || ('id' in obj)) && (('Name' in obj) || ('name' in obj))) {
    const idTxt = nodeText(obj.Id || obj.id);
    const nameTxt = nodeText(obj.Name || obj.name);
    if ((idTxt != null && String(idTxt).trim() !== '') || (nameTxt != null && String(nameTxt).trim() !== '')) {
      return obj;
    }
  }
  // Recurse into children
  for (const v of Object.values(obj)) {
    if (typeof v === 'object') {
      const found = findInfoTerminal(v);
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

/* DB write: always INSERT a new row (log-style) */
async function upsertTankLevel({ idVal, snVal, numericLevelVal, timestampVal }) {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    // Always insert a new row; do not attempt to update existing rows.
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
      const name = item && (item['Name'] || item['name']);
      const nameText = nodeText(name) || '';
      return type === 'ns1:InfoVariable' && nameText.trim().toUpperCase() === 'LIVELLO';
    });

    if (!target) {
      console.warn('No valid LIVELLO InfoVariable found for terminal:', terminalId);
      return res.status(404).json({ error: 'Device Offline' });
    }

    // Find top-level InfoTerminal ("return") node and extract its Id/Name
    const infoTerminal = findInfoTerminal(parsed);
    const terminalTopId = infoTerminal ? nodeText(infoTerminal.Id || infoTerminal.id) : null;
    const terminalTopName = infoTerminal ? nodeText(infoTerminal.Name || infoTerminal.name) : null;

    const valueKeys = ['Value','value'];
    const timeKeys = ['Timestamp','timestamp'];

    // Extract fields from the filtered InfoVariable (LIVELLO)
    const rawValue = extractField(target, valueKeys);
    const timestampRaw = extractField(target, timeKeys);
    const timestampIso = validateTimestamp(timestampRaw);

    // IMPORTANT: use terminal (InfoTerminal) Id/Name for id/sn columns
    const idField = terminalTopId || terminalId;
    const snField = terminalTopName || extractField(target, ['SerialNumber','Serial','Name','NAME']);

    const numericValue = parseNumericValue(rawValue);

    // Persist to your existing table (id, sn, tank_level, timestamp) - always insert new row
    try {
      const result = await upsertTankLevel({
        idVal: idField,
        snVal: snField,
        numericLevelVal: numericValue,
        timestampVal: timestampIso
      });
      if (result && result.action) {
        console.log(`Inserted new reading for terminal ${idField} (${snField})`);
      }
    } catch (dbErr) {
      console.warn('Failed to write to tank_level table:', dbErr && dbErr.message);
      return res.status(500).json({ error: 'DB insert failed', details: dbErr && dbErr.message });
    }

    return res.json({ value: rawValue, timestamp: timestampRaw, id: idField, sn: snField });
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
