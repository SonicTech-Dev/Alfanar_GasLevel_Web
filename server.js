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
let cachedReadings = []; // Store the readings for periodic saving

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

function findInfoTerminal(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if ((('Id' in obj) || ('id' in obj)) && (('Name' in obj) || ('name' in obj))) {
    const idTxt = nodeText(obj.Id || obj.id);
    const nameTxt = nodeText(obj.Name || obj.name);
    if ((idTxt != null && String(idTxt).trim() !== '') || (nameTxt != null && String(nameTxt).trim() !== '')) {
      return obj;
    }
  }
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
  const parsed = new Date(String(ts));
  if (!isNaN(parsed.getTime())) return parsed.toISOString();
  const isoLike = String(ts).match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  if (isoLike) return new Date(isoLike[0]).toISOString();
  return null;
}

// New helper: normalize DB timestamp values to an unambiguous UTC ISO string.
// This avoids relying on the DB column type and ensures the frontend receives
// a proper ISO timestamp that the browser will convert to local time correctly.
function normalizeDbTimestampToIso(val) {
  if (val == null) return null;
  // If it's already a Date object, use toISOString()
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? null : val.toISOString();
  }
  const s = String(val).trim();
  if (!s) return null;
  // If it already includes timezone info (Z or +hh:mm or -hh:mm), parse directly.
  if (/[Zz]|[+\-]\d{2}(:?\d{2})?$/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  // Otherwise treat the timestamp as UTC by appending 'Z' and parse.
  // Example: "2026-01-05 12:34:56" -> "2026-01-05 12:34:56Z"
  const d = new Date(s + 'Z');
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function saveReadingsToDatabase() {
  if (cachedReadings.length === 0) return; // No data to save

  // Deduplicate so we only insert one reading per terminal (the last reading seen for each id)
  const latestById = new Map();
  for (const reading of cachedReadings) {
    // For simplicity we take the last occurrence for each id (overwrites previous),
    // which corresponds to the most recent check for that terminal in the cached array.
    latestById.set(reading.idVal, reading);
  }

  const toInsert = Array.from(latestById.values());
  if (toInsert.length === 0) {
    cachedReadings = [];
    return;
  }

  const client = await pool.connect();
  try {
    const query = `
      INSERT INTO tank_level (id, sn, tank_level, timestamp, "current_timestamp")
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP);
    `;

    for (let reading of toInsert) {
      await client.query(query, [
        reading.idVal,
        reading.snVal,
        reading.numericLevelVal,
        reading.timestampVal,
      ]);
    }

    console.log(`Saved ${toInsert.length} readings to the database (one per terminal)`);
    cachedReadings = []; // Clear the cache after successful save
  } catch (err) {
    console.warn('Failed to write periodic readings to tank_level table:', err.message);
  } finally {
    client.release();
  }
}

setInterval(saveReadingsToDatabase, 3600000); // Save every 1 hour

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
      return res.status(502).json({ error: 'Bad response from SOAP service', status: response.status, body: respText.slice(0, 1500) });
    }

    let parsed;
    try {
      parsed = await parseStringPromise(respText, { explicitArray: false, ignoreAttrs: false });
    } catch (parseErr) {
      return res.status(500).json({ error: 'Failed to parse SOAP XML', details: parseErr && parseErr.message });
    }

    const items = collectItems(parsed);

    const target = items.find(item => {
      const type = item && item['$'] && item['$']['xsi:type'];
      const name = item && (item['Name'] || item['name']);
      const nameText = nodeText(name) || '';
      return type === 'ns1:InfoVariable' && nameText.trim().toUpperCase() === 'LIVELLO';
    });

    if (!target) {
      return res.status(404).json({ error: 'Device Offline' });
    }

    const infoTerminal = findInfoTerminal(parsed);
    const terminalTopId = infoTerminal ? nodeText(infoTerminal.Id || infoTerminal.id) : null;
    const terminalTopName = infoTerminal ? nodeText(infoTerminal.Name || infoTerminal.name) : null;

    const valueKeys = ['Value','value'];
    const timeKeys = ['Timestamp','timestamp'];

    const rawValue = extractField(target, valueKeys);
    const timestampRaw = extractField(target, timeKeys);
    const timestampIso = validateTimestamp(timestampRaw);

    const idField = terminalTopId || terminalId;
    const snField = terminalTopName || extractField(target, ['SerialNumber','Serial','Name','NAME']);
    const numericValue = parseNumericValue(rawValue);

    cachedReadings.push({ idVal: idField, snVal: snField, numericLevelVal: numericValue, timestampVal: timestampIso });

    return res.json({ value: rawValue, timestamp: timestampRaw, id: idField, sn: snField });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    const terminalId = req.query.terminalId;
    if (!terminalId) return res.status(400).json({ error: 'terminalId query parameter is required' });

    const limit = Math.min(Math.max(parseInt(req.query.limit || '1000', 10) || 1, 1), 50000);

    const client = await pool.connect();
    try {
      // IMPORTANT: select the table column named "current_timestamp" (not the SQL CURRENT_TIMESTAMP value).
      // We alias it to inserted_at and then normalize it to an ISO string in JS below.
      const query = `
        SELECT "current_timestamp" AS inserted_at, tank_level
        FROM tank_level
        WHERE id = $1
        ORDER BY "current_timestamp" ASC
        LIMIT $2
      `;
      const result = await client.query(query, [terminalId, limit]);
      const rows = result.rows.map(r => ({
        // Normalize the DB value to an unambiguous UTC ISO string for the frontend.
        timestamp: normalizeDbTimestampToIso(r.inserted_at),
        tank_level: (r.tank_level === null || r.tank_level === undefined) ? null : Number(r.tank_level),
      }));
      res.json({ id: terminalId, count: rows.length, rows });
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('History endpoint error', err && err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), dbAvailable });
});

app.get('/internal/dbstatus', (req, res) => {
  res.json({ dbAvailable, lastDbError });
});

const server = app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

async function shutdown() {
  console.log('Shutting down server...');
  try { await server.close(); } catch (e) { /* ignore */ }
  try { await pool.end(); } catch (e) { /* ignore */ }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
