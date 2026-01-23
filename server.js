require('dotenv').config();

const express = require('express');
const fetch = require('node-fetch'); // v2
const { parseStringPromise } = require('xml2js');
const { Pool } = require('pg');
const path = require('path');
const nodemailer = require('nodemailer');

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

/* Ensure tank_sites table exists
   Columns:
     - terminal_id: optional link to a terminal id (text)
     - site: textual site name
     - location: textual field to store google map link (or any URL)
     - latitude: numeric
     - longitude: numeric
*/
async function createSitesTableIfNeeded() {
  const createSql = `
    CREATE TABLE IF NOT EXISTS tank_sites (
      id SERIAL PRIMARY KEY,
      terminal_id TEXT UNIQUE,
      site TEXT,
      location TEXT,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS tank_sites_terminal_idx ON tank_sites (terminal_id);
  `;
  try {
    const client = await pool.connect();
    try {
      await client.query(createSql);
      console.log('Ensured tank_sites table exists');
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('Failed to create tank_sites table:', err && err.message);
  }
}

/* Ensure tank_titles table exists (used elsewhere) */
async function createTitlesTableIfNeeded() {
  const createSql = `
    CREATE TABLE IF NOT EXISTS tank_titles (
      no SERIAL PRIMARY KEY,
      terminal_id TEXT UNIQUE,
      sn TEXT,
      tank_title TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS tank_titles_terminal_idx ON tank_titles (terminal_id);
  `;
  try {
    const client = await pool.connect();
    try {
      await client.query(createSql);
      console.log('Ensured tank_titles table exists');
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('Failed to create tank_titles table:', err && err.message);
  }
}

/* Ensure tank_info table exists
   Columns for device information collected via the new UI:
     - terminal_id (unique)
     - building_name
     - address
     - afg_bld_code
     - client_bld_code
     - lpg_tank_capacity
     - lpg_tank_details
     - lpg_tank_type
     - lpg_installation_type
     - notes (TEXT)
     - lpg_min_level (DOUBLE PRECISION)
     - lpg_max_level (DOUBLE PRECISION)
     - alarm_email (TEXT)                       <-- NEW
     - last_min_alarm_sent_at (TIMESTAMPTZ)     <-- NEW
     - last_max_alarm_sent_at (TIMESTAMPTZ)     <-- NEW
*/
async function createTankInfoTableIfNeeded() {
  const createSql = `
    CREATE TABLE IF NOT EXISTS tank_info (
      id SERIAL PRIMARY KEY,
      terminal_id TEXT UNIQUE,
      building_name TEXT,
      address TEXT,
      afg_bld_code TEXT,
      client_bld_code TEXT,
      lpg_tank_capacity TEXT,
      lpg_tank_details TEXT,
      lpg_tank_type TEXT,
      lpg_installation_type TEXT,
      notes TEXT,
      lpg_min_level DOUBLE PRECISION,
      lpg_max_level DOUBLE PRECISION,
      alarm_email TEXT,
      last_min_alarm_sent_at TIMESTAMPTZ,
      last_max_alarm_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS tank_info_terminal_idx ON tank_info (terminal_id);
  `;
  try {
    const client = await pool.connect();
    try {
      await client.query(createSql);
      console.log('Ensured tank_info table exists');
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('Failed to create tank_info table:', err && err.message);
  }
}

// attempt to create the table on startup (non-blocking)
createLoginAttemptsTableIfNeeded().catch(e => console.warn('Create table error', e && e.message));
createSitesTableIfNeeded().catch(e => console.warn('Create sites table error', e && e.message));
createTitlesTableIfNeeded().catch(e => console.warn('Create titles table error', e && e.message));
createTankInfoTableIfNeeded().catch(e => console.warn('Create tank_info table error', e && e.message));

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
   Accepts optional variableName (default 'LIVELLO').
   Returns:
   {
     idVal, snVal, numericLevelVal, timestampVal, rawValue, timestampRaw, percent (for BATT if computed)
   }
*/
async function getTankReading(terminalId, variableName = 'LIVELLO') {
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

  const desiredName = (variableName || 'LIVELLO').toString().trim().toUpperCase();

  const target = items.find(item => {
    const type = item && item['$'] && item['$']['xsi:type'];
    const name = item && (item['Name'] || item['name']);
    const nameText = nodeText(name) || '';
    return type === 'ns1:InfoVariable' && nameText.trim().toUpperCase() === desiredName;
  });

  if (!target) {
    const err = new Error(`Device Offline or ${desiredName} not found`);
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

  // If variable is BATT and numericValue present, compute a rounded percent using linear map 3.35->0, 3.55->100
  let computedPercent = null;
  try {
    if (desiredName === 'BATT' && numericValue != null && !isNaN(numericValue)) {
      const vMin = parseFloat(process.env.BATT_MIN_V || '3.35');
      const vMax = parseFloat(process.env.BATT_MAX_V || '3.55');
      if (!isNaN(vMin) && !isNaN(vMax) && vMax > vMin) {
        if (numericValue <= vMin) computedPercent = 0;
        else if (numericValue >= vMax) computedPercent = 100;
        else {
          const pct = ((numericValue - vMin) / (vMax - vMin)) * 100.0;
          computedPercent = Math.round(pct); // rounding per preference
        }
      }
    }
  } catch (e) {
    computedPercent = null;
  }

  return {
    idVal: idField,
    snVal: snField,
    numericLevelVal: numericValue,
    timestampVal: timestampIso,
    rawValue,
    timestampRaw,
    percent: computedPercent
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

/* Email helper (nodemailer) */
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  try {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: (process.env.SMTP_SECURE === 'true') || false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
    // verify connection (non-blocking)
    transporter.verify().then(() => console.log('SMTP transporter ready')).catch(() => {/* ignore verification errors at startup */});
  } catch (e) {
    console.warn('Failed to create SMTP transporter', e && e.message);
    transporter = null;
  }
} else {
  console.log('SMTP not configured; email alarms will be disabled until SMTP_* env vars are provided.');
}

async function sendAlarmEmail(to, subject, text, html) {
  if (!transporter) throw new Error('SMTP transporter not configured');
  if (!to) throw new Error('no recipient');
  const from = process.env.ALARM_FROM_EMAIL || process.env.SMTP_USER;
  const fromName = process.env.ALARM_FROM_NAME || 'Tank Alarms';
  const mail = {
    from: `"${fromName}" <${from}>`,
    to,
    subject,
    text,
    html
  };
  return transporter.sendMail(mail);
}

/* maybeSendAlarms: check tank_info for this terminal and send alarm emails if needed.
   Uses same client passed to pollTerminalsAndSave to avoid extra connections.
*/
async function maybeSendAlarms(client, reading) {
  try {
    if (!reading || !reading.idVal) return;
    const tid = String(reading.idVal);

    // fetch tank_info for this terminal
    const q = `
      SELECT terminal_id, lpg_min_level, lpg_max_level, alarm_email, last_min_alarm_sent_at, last_max_alarm_sent_at
      FROM tank_info WHERE terminal_id = $1 LIMIT 1
    `;
    const r = await client.query(q, [tid]);
    if (!r.rows || r.rows.length === 0) return;
    const info = r.rows[0];
    const email = info.alarm_email ? String(info.alarm_email).trim() : null;
    if (!email) return; // nothing to do

    const val = (reading.numericLevelVal === null || reading.numericLevelVal === undefined) ? null : Number(reading.numericLevelVal);
    if (val == null || isNaN(val)) return;

    const now = new Date();
    const throttleMinutes = Math.max(0, parseInt(process.env.ALARM_THROTTLE_MINUTES || '60', 10));

    function shouldSend(lastSent) {
      if (!lastSent) return true;
      const last = new Date(lastSent);
      if (isNaN(last.getTime())) return true;
      return (now.getTime() - last.getTime()) >= (throttleMinutes * 60 * 1000);
    }

    const min = (info.lpg_min_level === null || info.lpg_min_level === undefined) ? null : Number(info.lpg_min_level);
    const max = (info.lpg_max_level === null || info.lpg_max_level === undefined) ? null : Number(info.lpg_max_level);

    // BELOW MIN
    if (min !== null && !isNaN(min) && val < min) {
      // send only if throttling allows
      if (shouldSend(info.last_min_alarm_sent_at)) {
        if (transporter) {
          try {
            const subject = `ALARM: Terminal ${tid} below minimum (${val}% < ${min}%)`;
            const text = `Terminal ${tid} reported a level of ${val}%, which is below the configured minimum of ${min}%.\n\nTime: ${now.toISOString()}\n\nThis is an automated alarm.`;
            await sendAlarmEmail(email, subject, text, `<p>${text.replace(/\n/g,'<br>')}</p>`);
            // update last_min_alarm_sent_at
            await client.query(`UPDATE tank_info SET last_min_alarm_sent_at = now() WHERE terminal_id = $1`, [tid]).catch(()=>{});
          } catch (err) {
            console.warn('Failed to send min alarm', err && err.message);
          }
        } else {
          console.warn('Cannot send min alarm: SMTP not configured.');
        }
      }
    }

    // ABOVE MAX
    if (max !== null && !isNaN(max) && val > max) {
      if (shouldSend(info.last_max_alarm_sent_at)) {
        if (transporter) {
          try {
            const subject = `ALARM: Terminal ${tid} above maximum (${val}% > ${max}%)`;
            const text = `Terminal ${tid} reported a level of ${val}%, which is above the configured maximum of ${max}%.\n\nTime: ${now.toISOString()}\n\nThis is an automated alarm.`;
            await sendAlarmEmail(email, subject, text, `<p>${text.replace(/\n/g,'<br>')}</p>`);
            // update last_max_alarm_sent_at
            await client.query(`UPDATE tank_info SET last_max_alarm_sent_at = now() WHERE terminal_id = $1`, [tid]).catch(()=>{});
          } catch (err) {
            console.warn('Failed to send max alarm', err && err.message);
          }
        } else {
          console.warn('Cannot send max alarm: SMTP not configured.');
        }
      }
    }

    // If the value is back in range, optionally clear last_* timestamps so future crossings trigger immediately.
    // We'll clear only when value is strictly between min and max (if both defined). If only min or max defined,
    // clear the opposite timestamp when inside bounds.
    try {
      let clearMin = false;
      let clearMax = false;
      if ((min !== null && !isNaN(min)) && (max !== null && !isNaN(max))) {
        if (val >= min && val <= max) {
          clearMin = true; clearMax = true;
        }
      } else if (min !== null && !isNaN(min) && (max === null || isNaN(max))) {
        if (val >= min) clearMin = true;
      } else if (max !== null && !isNaN(max) && (min === null || isNaN(min))) {
        if (val <= max) clearMax = true;
      }
      if (clearMin) {
        await client.query(`UPDATE tank_info SET last_min_alarm_sent_at = NULL WHERE terminal_id = $1`, [tid]).catch(()=>{});
      }
      if (clearMax) {
        await client.query(`UPDATE tank_info SET last_max_alarm_sent_at = NULL WHERE terminal_id = $1`, [tid]).catch(()=>{});
      }
    } catch (err) {
      // non-fatal
    }
  } catch (err) {
    console.warn('maybeSendAlarms error', err && err.message);
  }
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
        // Insert reading
        await insertReading(client, reading);
        console.log(`Inserted reading for terminal ${reading.idVal} (sn=${reading.snVal})`);
        // Possibly send alarms (uses same client)
        await maybeSendAlarms(client, reading).catch(e => console.warn('Alarm check failed', e && e.message));
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
// Accepts optional `variable` query parameter (default: LIVELLO). When `variable=BATT`
// the response will include a computed `percent` field (rounded) if a numeric voltage is available.
app.get('/api/tank', async (req, res) => {
  try {
    const terminalId = req.query.terminalId;
    if (!terminalId) return res.status(400).json({ error: 'terminalId query parameter is required' });

    const variable = req.query.variable ? String(req.query.variable).trim() : 'LIVELLO';

    try {
      const reading = await getTankReading(terminalId, variable);
      const out = { value: reading.rawValue, timestamp: reading.timestampVal, id: reading.idVal, sn: reading.snVal };
      // include percent if computed (used for BATT)
      if (reading.percent !== undefined && reading.percent !== null) out.percent = reading.percent;
      return res.json(out);
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

/* NEW: Tank info endpoints
   GET /api/tank-info?terminalId=... -> returns single record for terminalId (or 404)
   GET /api/tank-info -> returns all records {count, rows}
   POST /api/tank-info -> upsert by terminal_id and return saved row
*/

app.get('/api/tank-info', async (req, res) => {
  try {
    const terminalId = req.query.terminalId;
    const client = await pool.connect();
    try {
      if (terminalId) {
        const q = `SELECT terminal_id, building_name, address, afg_bld_code, client_bld_code, lpg_tank_capacity, lpg_tank_details, lpg_tank_type, lpg_installation_type, notes, lpg_min_level, lpg_max_level, alarm_email, created_at FROM tank_info WHERE terminal_id = $1 LIMIT 1`;
        const r = await client.query(q, [String(terminalId)]);
        if (!r.rows || r.rows.length === 0) {
          return res.status(404).json({ error: 'not found' });
        }
        const row = r.rows[0];
        return res.json({
          terminal_id: row.terminal_id,
          building_name: row.building_name,
          address: row.address,
          afg_bld_code: row.afg_bld_code,
          client_bld_code: row.client_bld_code,
          lpg_tank_capacity: row.lpg_tank_capacity,
          lpg_tank_details: row.lpg_tank_details,
          lpg_tank_type: row.lpg_tank_type,
          lpg_installation_type: row.lpg_installation_type,
          notes: row.notes || null,
          lpg_min_level: row.lpg_min_level === null || row.lpg_min_level === undefined ? null : Number(row.lpg_min_level),
          lpg_max_level: row.lpg_max_level === null || row.lpg_max_level === undefined ? null : Number(row.lpg_max_level),
          alarm_email: row.alarm_email || null,
          created_at: normalizeDbTimestampToIso(row.created_at)
        });
      } else {
        const q = `SELECT terminal_id, building_name, address, afg_bld_code, client_bld_code, lpg_tank_capacity, lpg_tank_details, lpg_tank_type, lpg_installation_type, notes, lpg_min_level, lpg_max_level, alarm_email, created_at FROM tank_info ORDER BY created_at DESC`;
        const r = await client.query(q);
        const rows = (r.rows || []).map(row => ({
          terminal_id: row.terminal_id,
          building_name: row.building_name,
          address: row.address,
          afg_bld_code: row.afg_bld_code,
          client_bld_code: row.client_bld_code,
          lpg_tank_capacity: row.lpg_tank_capacity,
          lpg_tank_details: row.lpg_tank_details,
          lpg_tank_type: row.lpg_tank_type,
          lpg_installation_type: row.lpg_installation_type,
          notes: row.notes || null,
          lpg_min_level: row.lpg_min_level === null || row.lpg_min_level === undefined ? null : Number(row.lpg_min_level),
          lpg_max_level: row.lpg_max_level === null || row.lpg_max_level === undefined ? null : Number(row.lpg_max_level),
          alarm_email: row.alarm_email || null,
          created_at: normalizeDbTimestampToIso(row.created_at)
        }));
        return res.json({ count: rows.length, rows });
      }
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('GET /api/tank-info failed:', err && err.message);
    res.status(500).json({ error: 'failed to fetch tank info' });
  }
});

app.post('/api/tank-info', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const terminalId = body.terminalId ? String(body.terminalId).trim() : null;
    if (!terminalId) {
      return res.status(400).json({ error: 'terminalId is required' });
    }

    const building_name = body.building_name !== undefined ? String(body.building_name).trim() : null;
    const address = body.address !== undefined ? String(body.address).trim() : null;
    const afg_bld_code = body.afg_bld_code !== undefined ? String(body.afg_bld_code).trim() : null;
    const client_bld_code = body.client_bld_code !== undefined ? String(body.client_bld_code).trim() : null;
    const lpg_tank_capacity = body.lpg_tank_capacity !== undefined ? String(body.lpg_tank_capacity).trim() : null;
    const lpg_tank_details = body.lpg_tank_details !== undefined ? String(body.lpg_tank_details).trim() : null;
    const lpg_tank_type = body.lpg_tank_type !== undefined ? String(body.lpg_tank_type).trim() : null;
    const lpg_installation_type = body.lpg_installation_type !== undefined ? String(body.lpg_installation_type).trim() : null;
    const notes = body.notes !== undefined && body.notes !== null ? String(body.notes).trim() : null;

    const alarm_email = body.alarm_email !== undefined && body.alarm_email !== null && String(body.alarm_email).trim() !== '' ? String(body.alarm_email).trim().slice(0, 254) : null;

    // Parse thresholds defensively: accept numeric or numeric-string; store null for invalid/empty
    let lpg_min_level = (body.lpg_min_level !== undefined && body.lpg_min_level !== null && body.lpg_min_level !== '') ? Number(body.lpg_min_level) : null;
    if (lpg_min_level !== null && isNaN(lpg_min_level)) lpg_min_level = null;
    let lpg_max_level = (body.lpg_max_level !== undefined && body.lpg_max_level !== null && body.lpg_max_level !== '') ? Number(body.lpg_max_level) : null;
    if (lpg_max_level !== null && isNaN(lpg_max_level)) lpg_max_level = null;

    const client = await pool.connect();
    try {
      const q = `
        INSERT INTO tank_info (terminal_id, building_name, address, afg_bld_code, client_bld_code, lpg_tank_capacity, lpg_tank_details, lpg_tank_type, lpg_installation_type, notes, lpg_min_level, lpg_max_level, alarm_email)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (terminal_id) DO UPDATE SET
          building_name = EXCLUDED.building_name,
          address = EXCLUDED.address,
          afg_bld_code = EXCLUDED.afg_bld_code,
          client_bld_code = EXCLUDED.client_bld_code,
          lpg_tank_capacity = EXCLUDED.lpg_tank_capacity,
          lpg_tank_details = EXCLUDED.lpg_tank_details,
          lpg_tank_type = EXCLUDED.lpg_tank_type,
          lpg_installation_type = EXCLUDED.lpg_installation_type,
          notes = EXCLUDED.notes,
          lpg_min_level = EXCLUDED.lpg_min_level,
          lpg_max_level = EXCLUDED.lpg_max_level,
          alarm_email = EXCLUDED.alarm_email
        RETURNING terminal_id, building_name, address, afg_bld_code, client_bld_code, lpg_tank_capacity, lpg_tank_details, lpg_tank_type, lpg_installation_type, notes, lpg_min_level, lpg_max_level, alarm_email, created_at;
      `;
      const params = [terminalId, building_name, address, afg_bld_code, client_bld_code, lpg_tank_capacity, lpg_tank_details, lpg_tank_type, lpg_installation_type, notes, lpg_min_level, lpg_max_level, alarm_email];
      const r = await client.query(q, params);
      const row = r.rows && r.rows[0] ? r.rows[0] : null;
      if (!row) return res.status(500).json({ error: 'failed to save' });
      return res.status(201).json({
        terminal_id: row.terminal_id,
        building_name: row.building_name,
        address: row.address,
        afg_bld_code: row.afg_bld_code,
        client_bld_code: row.client_bld_code,
        lpg_tank_capacity: row.lpg_tank_capacity,
        lpg_tank_details: row.lpg_tank_details,
        lpg_tank_type: row.lpg_tank_type,
        lpg_installation_type: row.lpg_installation_type,
        notes: row.notes || null,
        lpg_min_level: row.lpg_min_level === null || row.lpg_min_level === undefined ? null : Number(row.lpg_min_level),
        lpg_max_level: row.lpg_max_level === null || row.lpg_max_level === undefined ? null : Number(row.lpg_max_level),
        alarm_email: row.alarm_email || null,
        created_at: normalizeDbTimestampToIso(row.created_at)
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('POST /api/tank-info failed:', err && err.message);
    res.status(500).json({ error: 'failed to save tank info' });
  }
});

/* NEW: Sites endpoints (GET and POST)
   GET /api/sites -> { count, rows } (each row: terminal_id, site, location, latitude, longitude, created_at)
   POST /api/sites -> upsert by terminal_id and return saved row
*/
app.get('/api/sites', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const q = `SELECT terminal_id, site, location, latitude, longitude, created_at FROM tank_sites ORDER BY created_at DESC`;
      const r = await client.query(q);
      const rows = (r.rows || []).map(row => ({
        terminal_id: row.terminal_id,
        site: row.site,
        location: row.location,
        latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
        longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
        created_at: normalizeDbTimestampToIso(row.created_at)
      }));
      return res.json({ count: rows.length, rows });
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('GET /api/sites failed:', err && err.message);
    return res.status(500).json({ error: 'failed to fetch sites' });
  }
});

app.post('/api/sites', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const terminalId = body.terminalId ? String(body.terminalId).trim() : null;
    if (!terminalId) {
      return res.status(400).json({ error: 'terminalId is required' });
    }
    const site = body.site !== undefined ? String(body.site).trim() : null;
    const location = body.location !== undefined ? String(body.location).trim() : null;
    const latitude = (body.latitude !== undefined && body.latitude !== null && body.latitude !== '') ? Number(body.latitude) : null;
    const longitude = (body.longitude !== undefined && body.longitude !== null && body.longitude !== '') ? Number(body.longitude) : null;

    const client = await pool.connect();
    try {
      const q = `
        INSERT INTO tank_sites (terminal_id, site, location, latitude, longitude)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (terminal_id) DO UPDATE SET
          site = EXCLUDED.site,
          location = EXCLUDED.location,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude
        RETURNING terminal_id, site, location, latitude, longitude, created_at;
      `;
      const params = [terminalId, site, location, latitude, longitude];
      const r = await client.query(q, params);
      const row = r.rows && r.rows[0] ? r.rows[0] : null;
      if (!row) return res.status(500).json({ error: 'failed to save' });
      return res.status(201).json({
        terminal_id: row.terminal_id,
        site: row.site,
        location: row.location,
        latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
        longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
        created_at: normalizeDbTimestampToIso(row.created_at)
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('POST /api/sites failed:', err && err.message);
    return res.status(500).json({ error: 'failed to save site' });
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
