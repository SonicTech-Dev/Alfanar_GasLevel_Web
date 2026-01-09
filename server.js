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

// parse JSON bodies (used by several endpoints including login-attempt)
app.use(express.json());

/* Ensure login_attempts table exists */
async function createLoginAttemptsTableIfNeeded() {
  const createSql = `
    CREATE TABLE IF NOT EXISTS login_attempts (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      is_admin_attempt BOOLEAN NOT NULL DEFAULT FALSE,
      success BOOLEAN NOT NULL DEFAULT FALSE,
      user_agent TEXT,
      ip TEXT,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS login_attempts_created_idx ON login_attempts (created_at DESC);
  `;
  try {
    const client = await pool.connect();
    try {
      await client.query(createSql);
      console.log('Ensured login_attempts table exists');
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('Failed to create login_attempts table:', err && err.message);
  }
}

// attempt to create the table on startup (non-blocking)
createLoginAttemptsTableIfNeeded().catch(e => console.warn('Create table error', e && e.message));

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

// Normalize DB timestamp values to an unambiguous UTC ISO string.
function normalizeDbTimestampToIso(val) {
  if (val == null) return null;
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? null : val.toISOString();
  }
  const s = String(val).trim();
  if (!s) return null;
  if (/[Zz]|[+\-]\d{2}(:?\d{2})?$/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s + 'Z');
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/* New: perform a SOAP fetch and return a normalized reading object.
   Returns:
   {
     idVal, snVal, numericLevelVal, timestampVal, rawValue, timestampRaw
   }
*/
async function getTankReading(terminalId) {
  const soapBody = buildSoapBody(terminalId);
  const headers = { 'Content-Type': 'text/xml; charset=utf-8' };
  if (SOAP_ACTION) headers['SOAPAction'] = SOAP_ACTION;
  if (SOAP_USERNAME) headers['Authorization'] = 'Basic ' + Buffer.from(`${SOAP_USERNAME}:${SOAP_PASSWORD}`).toString('base64');

  const response = await fetch(SOAP_URL, { method: 'POST', headers, body: soapBody });
  const respText = await response.text().catch(() => '');

  if (!response.ok) {
    const msg = `Bad response from SOAP service: status=${response.status}`;
    const err = new Error(msg);
    err.detail = respText.slice(0, 1500);
    err.status = response.status;
    throw err;
  }

  let parsed;
  try {
    parsed = await parseStringPromise(respText, { explicitArray: false, ignoreAttrs: false });
  } catch (parseErr) {
    const err = new Error('Failed to parse SOAP XML');
    err.detail = parseErr && parseErr.message;
    throw err;
  }

  const items = collectItems(parsed);

  const target = items.find(item => {
    const type = item && item['$'] && item['$']['xsi:type'];
    const name = item && (item['Name'] || item['name']);
    const nameText = nodeText(name) || '';
    return type === 'ns1:InfoVariable' && nameText.trim().toUpperCase() === 'LIVELLO';
  });

  if (!target) {
    const err = new Error('Device Offline or LIVELLO not found');
    err.status = 404;
    throw err;
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

  return {
    idVal: idField,
    snVal: snField,
    numericLevelVal: numericValue,
    timestampVal: timestampIso,
    rawValue,
    timestampRaw,
  };
}

/* Insert a single reading into the DB using the same column layout as before.
   This is safe from SQL injection because parameterized queries are used.
*/
async function insertReading(client, reading) {
  const query = `
    INSERT INTO tank_level (id, sn, tank_level, timestamp, "current_timestamp")
    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP);
  `;
  await client.query(query, [
    reading.idVal,
    reading.snVal,
    reading.numericLevelVal,
    reading.timestampVal,
  ]);
}

/* Poll a list of terminal IDs (from TERMINAL_IDS env var) and save their readings.
   Behavior:
   - TERMINAL_IDS should be a comma-separated list of terminal IDs (strings).
   - The job will attempt to read each terminal and write an INSERT for each successful read.
   - Errors for individual terminals are logged and do not stop the loop; the job will attempt all terminals each run.
*/
async function pollTerminalsAndSave() {
  const terminalsEnv = process.env.TERMINAL_IDS || '';
  const terminalIds = terminalsEnv.split(',').map(s => s.trim()).filter(Boolean);

  if (terminalIds.length === 0) {
    console.warn('No TERMINAL_IDS configured; skipping scheduled poll. Set TERMINAL_IDS env var to a comma-separated list of IDs.');
    return;
  }

  const client = await pool.connect();
  try {
    for (const tid of terminalIds) {
      try {
        const reading = await getTankReading(tid);
        await insertReading(client, reading);
        console.log(`Inserted reading for terminal ${reading.idVal} (sn=${reading.snVal})`);
      } catch (err) {
        // Individual terminal failure should not stop others
        console.warn(`Failed to fetch/insert reading for terminal ${tid}:`, err && (err.message || err.status), err && err.detail ? `detail=${err.detail}` : '');
      }
    }
  } catch (outerErr) {
    console.warn('Error during pollTerminalsAndSave:', outerErr && outerErr.message);
  } finally {
    client.release();
  }
}

// Schedule polling every hour (3600000 ms)
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '3600000', 10);
setInterval(() => {
  pollTerminalsAndSave().catch(e => console.warn('Scheduled poll error', e && e.message));
}, POLL_INTERVAL_MS);

// Optionally run once on startup (default true). Set POLL_ON_STARTUP=false to disable.
const pollOnStartup = (process.env.POLL_ON_STARTUP || 'true').toLowerCase() !== 'false';
if (pollOnStartup) {
  pollTerminalsAndSave().catch(e => console.warn('Initial poll error', e && e.message));
}

/* -------------------------
   NEW: Login attempt endpoints
   ------------------------- */

// Helper to get client IP (respect x-forwarded-for if behind proxy)
function getRequestIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf && typeof xf === 'string') {
    return xf.split(',')[0].trim();
  }
  if (req.ip) return req.ip;
  if (req.connection && req.connection.remoteAddress) return req.connection.remoteAddress;
  return null;
}

// POST /api/login-attempt
// Expected JSON body: { username: string, isAdminAttempt: boolean, success: boolean, note?: string }
app.post('/api/login-attempt', async (req, res) => {
  try {
    const body = req.body || {};
    const username = body.username ? String(body.username).trim() : '';
    const isAdminAttempt = !!body.isAdminAttempt;
    const success = !!body.success;
    const note = body.note ? String(body.note).trim().slice(0, 1000) : null;

    if (!username) {
      return res.status(400).json({ error: 'username is required' });
    }

    const ip = getRequestIp(req) || null;
    const userAgent = req.get('user-agent') || null;

    const insertSql = `
      INSERT INTO login_attempts (username, is_admin_attempt, success, user_agent, ip, note)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, created_at;
    `;
    const params = [username, isAdminAttempt, success, userAgent, ip, note];

    const client = await pool.connect();
    try {
      const r = await client.query(insertSql, params);
      const inserted = r.rows && r.rows[0] ? r.rows[0] : null;
      const created_at = inserted && inserted.created_at ? normalizeDbTimestampToIso(inserted.created_at) : new Date().toISOString();
      return res.status(201).json({ ok: true, id: inserted && inserted.id, created_at });
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('POST /api/login-attempt failed:', err && err.message);
    return res.status(500).json({ error: 'failed to record login attempt' });
  }
});

// GET /api/login-attempts
// Query params: limit, offset, isAdmin (1/0), success(1/0), username (partial), since (ISO), until (ISO)
// If LOGIN_ATTEMPTS_READ_KEY is set, require header X-ADMIN-KEY to match.
app.get('/api/login-attempts', async (req, res) => {
  try {
    const requiredKey = process.env.LOGIN_ATTEMPTS_READ_KEY || '';
    if (requiredKey) {
      const got = req.get('x-admin-key') || '';
      if (got !== requiredKey) {
        return res.status(403).json({ error: 'forbidden' });
      }
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10) || 1, 1), 5000);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);

    const filters = [];
    const params = [];

    if (req.query.isAdmin !== undefined && (req.query.isAdmin === '1' || req.query.isAdmin === '0')) {
      params.push(req.query.isAdmin === '1');
      filters.push(`is_admin_attempt = $${params.length}`);
    }
    if (req.query.success !== undefined && (req.query.success === '1' || req.query.success === '0')) {
      params.push(req.query.success === '1');
      filters.push(`success = $${params.length}`);
    }
    if (req.query.username) {
      params.push(`%${req.query.username}%`);
      filters.push(`username ILIKE $${params.length}`);
    }
    if (req.query.since) {
      const since = new Date(req.query.since);
      if (!isNaN(since.getTime())) {
        params.push(since.toISOString());
        filters.push(`created_at >= $${params.length}`);
      }
    }
    if (req.query.until) {
      const until = new Date(req.query.until);
      if (!isNaN(until.getTime())) {
        params.push(until.toISOString());
        filters.push(`created_at <= $${params.length}`);
      }
    }

    const where = filters.length ? ('WHERE ' + filters.join(' AND ')) : '';

    // limit and offset are always appended as the last two parameters
    params.push(limit, offset);
    const q = `
      SELECT id, username, is_admin_attempt, success, user_agent, ip, note, created_at
      FROM login_attempts
      ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const client = await pool.connect();
    try {
      const result = await client.query(q, params);
      const rows = (result.rows || []).map(r => ({
        id: r.id,
        username: r.username,
        is_admin_attempt: !!r.is_admin_attempt,
        success: !!r.success,
        user_agent: r.user_agent || null,
        ip: r.ip || null,
        note: r.note || null,
        created_at: normalizeDbTimestampToIso(r.created_at),
      }));
      return res.json({ count: rows.length, rows });
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('GET /api/login-attempts failed:', err && err.message);
    return res.status(500).json({ error: 'failed to fetch login attempts' });
  }
});

/* API endpoints (existing) */

// Return a live reading for a single terminal (no DB write here).
app.get('/api/tank', async (req, res) => {
  try {
    const terminalId = req.query.terminalId;
    if (!terminalId) return res.status(400).json({ error: 'terminalId query parameter is required' });

    try {
      const reading = await getTankReading(terminalId);
      return res.json({ value: reading.rawValue, timestamp: reading.timestampRaw, id: reading.idVal, sn: reading.snVal });
    } catch (err) {
      if (err && err.status === 404) return res.status(404).json({ error: 'Device Offline' });
      return res.status(502).json({ error: 'Failed to fetch SOAP data', message: err && err.message });
    }
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

// Fetch titles for all terminals
app.get('/api/titles', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const query = `SELECT "no", "terminal_id", "sn", "tank_title" FROM tank_titles ORDER BY "no" ASC`;
      const result = await client.query(query);
      res.json(result.rows);
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('Failed to fetch titles:', err);
    res.status(500).json({ error: 'Failed to fetch titles' });
  }
});

// Update or insert a title for a specific terminal
app.post('/api/titles', express.json(), async (req, res) => {
  const { terminalId, sn, title } = req.body;

  if (!terminalId || !title) {
    return res.status(400).json({ error: 'Missing terminalId or title' });
  }

  try {
    const client = await pool.connect();
    try {
      const query = `
        INSERT INTO tank_titles (terminal_id, sn, tank_title)
        VALUES ($1, $2, $3)
        ON CONFLICT (terminal_id) DO UPDATE SET tank_title = $3
        RETURNING *;
      `;
      const result = await client.query(query, [terminalId, sn, title]);
      res.json(result.rows[0]);
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('Failed to save title:', err);
    res.status(500).json({ error: 'Failed to save title' });
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
