require('dotenv').config();

const express = require('express');
const fetch = require('node-fetch'); // v2
const { parseStringPromise } = require('xml2js');
const { Pool } = require('pg');
const path = require('path');
const nodemailer = require('nodemailer');

// New deps for MQTT, ping and socket.io
const mqtt = require('mqtt');
const ping = require('ping');
// Replace raw ws with socket.io
const { Server: SocketIO } = require('socket.io');

// NEW: bcryptjs for credential hashing/verification (portable)
const bcrypt = require('bcryptjs');

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

/* Serve Document.html when visiting /Document-Tracker */
app.get('/Document-Tracker', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'Document.html'));
});

/* Optional: redirect old URL to new path */
app.get('/Document.html', (req, res) => {
  res.redirect(301, '/Document-Tracker');
});

/* Serve Dashboard at /dashboard */
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

/* Optional: redirect old filename to the friendly path */
app.get('/dashboard.html', (req, res) => {
  res.redirect(301, '/dashboard');
});

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
     - project_code (TEXT)                      <-- NEW
     - emirate (TEXT)                           <-- NEW
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
      project_code TEXT,
      emirate TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS tank_info_terminal_idx ON tank_info (terminal_id);
  `;
  try {
    const client = await pool.connect();
    try {
      await client.query(createSql);
      console.log('Ensured tank_info table exists (schema includes project_code & emirate)');
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('Failed to create tank_info table:', err && err.message);
  }
}

/* NEW: Ensure tank_documents table exists (Document Tracker data) */
async function createTankDocumentsTableIfNeeded() {
  const createSql = `
    CREATE TABLE IF NOT EXISTS tank_documents (
      id SERIAL PRIMARY KEY,
      sn TEXT NOT NULL,
      building_type TEXT,
      building_code TEXT,
      building_name TEXT,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      istifaa_expiry_date DATE,
      amc_expiry_date DATE,
      doe_noc_expiry_date DATE,
      coc_expiry_date DATE,
      tpi_expiry_date DATE,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT uniq_sn_building UNIQUE (sn, building_code)
    );
    CREATE INDEX IF NOT EXISTS tank_documents_sn_idx ON tank_documents (sn);
    CREATE INDEX IF NOT EXISTS tank_documents_building_code_idx ON tank_documents (building_code);
  `;
  try {
    const client = await pool.connect();
    try {
      await client.query(createSql);
      console.log('Ensured tank_documents table exists');
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('Failed to create tank_documents table:', err && err.message);
  }
}

/* NEW: Ensure tank_credentials table exists (username/password/role) and seed users */
async function createTankCredentialsTableIfNeeded() {
  const createSql = `
    CREATE TABLE IF NOT EXISTS tank_credentials (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
      disabled BOOLEAN NOT NULL DEFAULT FALSE,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS tank_credentials_username_idx ON tank_credentials (username);
  `;
  try {
    const client = await pool.connect();
    try {
      await client.query(createSql);
      console.log('Ensured tank_credentials table exists');
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('Failed to create tank_credentials table:', err && err.message);
  }
}

/* Seed default credentials if missing.
   Users:
   - Sonic (admin) / password: Sonic@123
   - Alfanar_Admin1 (editor) / password: Admin_Alfanar1
   - Alfanar_GasLevel1 (viewer) / password: GasLevel_Alfanar1
*/
async function seedDefaultCredentialsIfMissing() {
  const defaults = [
    { username: 'Sonic', role: 'admin', password: 'Sonic@123' },
    { username: 'Alfanar_Admin1', role: 'editor', password: 'Admin_Alfanar1' },
    { username: 'Alfanar_GasLevel1', role: 'viewer', password: 'GasLevel_Alfanar1' },
  ];
  const saltRounds = Math.max(8, parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10));
  const client = await pool.connect();
  try {
    for (const u of defaults) {
      try {
        const exists = await client.query(`SELECT id FROM tank_credentials WHERE username = $1 LIMIT 1`, [u.username]);
        if (exists.rows && exists.rows.length > 0) {
          continue;
        }
        const hash = await bcrypt.hash(u.password, saltRounds);
        await client.query(
          `INSERT INTO tank_credentials (username, password_hash, role) VALUES ($1, $2, $3)`,
          [u.username, hash, u.role]
        );
        console.log(`Seeded credential for ${u.username} (${u.role})`);
      } catch (err) {
        console.warn('Seed credential error', u.username, err && err.message);
      }
    }
  } finally {
    client.release();
  }
}

// attempt to create the table on startup (non-blocking)
createLoginAttemptsTableIfNeeded().catch(e => console.warn('Create table error', e && e.message));
createSitesTableIfNeeded().catch(e => console.warn('Create sites table error', e && e.message));
createTitlesTableIfNeeded().catch(e => console.warn('Create tank_titles table error', e && e.message));
createTankInfoTableIfNeeded().catch(e => console.warn('Create tank_info table error', e && e.message));
createTankDocumentsTableIfNeeded().catch(e => console.warn('Create tank_documents table error', e && e.message));
createTankCredentialsTableIfNeeded().then(seedDefaultCredentialsIfMissing).catch(e => console.warn('Create/seed tank_credentials error', e && e.message));

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

/* Helper: Normalize serial number (SN) to ensure it always starts with uppercase "ZN".
   Examples:
   - "000000096233" => "ZN000000096233"
   - "zn000000096233" => "ZN000000096233"
   - "ZN000000096233" => "ZN000000096233"
*/
function normalizeSn(sn) {
  const raw = String(sn || '').trim();
  if (!raw) return null;
  if (raw.toUpperCase().startsWith('ZN')) {
    return 'ZN' + raw.slice(2);
  }
  return 'ZN' + raw;
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
  const snField = infoTerminal ? nodeText(infoTerminal.Name || infoTerminal.name) : extractField(target, ['SerialNumber','Serial','Name','NAME']);

  // Normalize SN to always include "ZN" prefix (uppercase)
  const snNormalized = normalizeSn(snField);

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
    snVal: snNormalized, // normalized SN
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
    reading.snVal, // already normalized to include "ZN"
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
            const text = `Terminal ${tid} reported a level of ${val}%, which is above the configured maximum of ${max}%).\n\nTime: ${now.toISOString()}\n\nThis is an automated alarm.`;
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
        await client.query(`UPDATE tank_info SET last_max_alarm_sent_at = NULL WHERE terminal_id = $1`).catch(()=>{});
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
   NEW: Login (DB-backed) endpoint
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

// POST /api/login
// Body: { username, password }
// Returns: { ok: true, username, role }
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const u = (username || '').trim();
    const p = String(password || '');

    if (!u || !p) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    const client = await pool.connect();
    try {
      const r = await client.query(
        `SELECT id, username, password_hash, role, disabled FROM tank_credentials WHERE username = $1 LIMIT 1`,
        [u]
      );
      if (!r.rows || r.rows.length === 0) {
        // log failure
        try {
          const ip = getRequestIp(req) || null;
          const userAgent = req.get('user-agent') || null;
          await client.query(
            `INSERT INTO login_attempts (username, is_admin_attempt, success, user_agent, ip, note) VALUES ($1, $2, $3, $4, $5, $6)`,
            [u, false, false, userAgent, ip, 'invalid username/password']
          );
        } catch (e) { /* ignore logging errors */ }
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      const row = r.rows[0];
      if (row.disabled) {
        try {
          const ip = getRequestIp(req) || null;
          const userAgent = req.get('user-agent') || null;
          await client.query(
            `INSERT INTO login_attempts (username, is_admin_attempt, success, user_agent, ip, note) VALUES ($1, $2, $3, $4, $5, $6)`,
            [u, row.role === 'admin', false, userAgent, ip, 'account disabled']
          );
        } catch (e) { /* ignore */ }
        return res.status(403).json({ error: 'Account disabled' });
      }

      const ok = await bcrypt.compare(p, row.password_hash);
      const isAdminRole = row.role === 'admin';

      // log attempt
      try {
        const ip = getRequestIp(req) || null;
        const userAgent = req.get('user-agent') || null;
        await client.query(
          `INSERT INTO login_attempts (username, is_admin_attempt, success, user_agent, ip, note) VALUES ($1, $2, $3, $4, $5, $6)`,
          [u, isAdminRole, !!ok, userAgent, ip, ok ? 'user login success' : 'invalid username/password']
        );
      } catch (e) { /* ignore logging errors */ }

      if (!ok) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      // update last_login_at
      try {
        await client.query(`UPDATE tank_credentials SET last_login_at = now() WHERE id = $1`, [row.id]);
      } catch (e) { /* ignore */ }

      return res.json({ ok: true, username: row.username, role: row.role });
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('POST /api/login failed:', err && err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/* -------------------------
   NEW/EXISTING: Login attempt endpoints (unchanged)
   ------------------------- */

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
        const q = `SELECT terminal_id, building_name, address, afg_bld_code, client_bld_code, lpg_tank_capacity, lpg_tank_details, lpg_tank_type, lpg_installation_type, notes, lpg_min_level, lpg_max_level, alarm_email, project_code, emirate, created_at FROM tank_info WHERE terminal_id = $1 LIMIT 1`;
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
          project_code: row.project_code || null,
          emirate: row.emirate || null,
          created_at: normalizeDbTimestampToIso(row.created_at)
        });
      } else {
        const q = `SELECT terminal_id, building_name, address, afg_bld_code, client_bld_code, lpg_tank_capacity, lpg_tank_details, lpg_tank_type, lpg_installation_type, notes, lpg_min_level, lpg_max_level, alarm_email, project_code, emirate, created_at FROM tank_info ORDER BY created_at DESC`;
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
          project_code: row.project_code || null,
          emirate: row.emirate || null,
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

    // NEW: project_code and emirate
    const project_code = body.project_code !== undefined && body.project_code !== null && String(body.project_code).trim() !== '' ? String(body.project_code).trim().slice(0, 200) : null;
    const emirate = body.emirate !== undefined && body.emirate !== null && String(body.emirate).trim() !== '' ? String(body.emirate).trim().slice(0, 80) : null;

    const client = await pool.connect();
    try {
      const q = `
        INSERT INTO tank_info (terminal_id, building_name, address, afg_bld_code, client_bld_code, lpg_tank_capacity, lpg_tank_details, lpg_tank_type, lpg_installation_type, notes, lpg_min_level, lpg_max_level, alarm_email, project_code, emirate)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
          alarm_email = EXCLUDED.alarm_email,
          project_code = EXCLUDED.project_code,
          emirate = EXCLUDED.emirate
        RETURNING terminal_id, building_name, address, afg_bld_code, client_bld_code, lpg_tank_capacity, lpg_tank_details, lpg_tank_type, lpg_tank_installation, notes, lpg_min_level, lpg_max_level, alarm_email, project_code, emirate, created_at;
      `;
      const params = [terminalId, building_name, address, afg_bld_code, client_bld_code, lpg_tank_capacity, lpg_tank_details, lpg_tank_type, lpg_installation_type, notes, lpg_min_level, lpg_max_level, alarm_email, project_code, emirate];
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
        lpg_tank_installation: row.lpg_tank_installation || row.lpg_installation_type,
        notes: row.notes || null,
        lpg_min_level: row.lpg_min_level === null || row.lpg_min_level === undefined ? null : Number(row.lpg_min_level),
        lpg_max_level: row.lpg_max_level === null || row.lpg_max_level === undefined ? null : Number(row.lpg_max_level),
        alarm_email: row.alarm_email || null,
        project_code: row.project_code || null,
        emirate: row.emirate || null,
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

/* NEW: Provide serial numbers (SN) to clients and mapping SN -> terminal_id
   GET /api/tank-sns -> returns { count, rows: [{ sn }, ... ] }
   GET /api/tank-by-sn?sn=... -> returns { terminal_id, sn } or 404

   NOTE: To avoid exposing terminal IDs in the dropdown label we return only the SN values.
         Additionally, we now:
         - filter to SNs that start with "ZN" (case-insensitive)
         - normalize to uppercase (ZN…) and deduplicate via DISTINCT ON (UPPER(sn))
*/
app.get('/api/tank-sns', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      // Return only ZN-prefixed SNs, normalize to uppercase, and deduplicate
      const q = `
        SELECT DISTINCT ON (UPPER(sn)) UPPER(sn) AS sn
        FROM tank_level
        WHERE sn IS NOT NULL AND sn <> '' AND sn ILIKE 'ZN%'
        ORDER BY UPPER(sn), "current_timestamp" DESC
      `;
      const r = await client.query(q);
      const rows = (r.rows || []).map(row => ({
        sn: row.sn
      }));
      return res.json({ count: rows.length, rows });
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('GET /api/tank-sns failed:', err && err.message);
    return res.status(500).json({ error: 'failed to fetch tank serials' });
  }
});

app.get('/api/tank-by-sn', async (req, res) => {
  try {
    const sn = req.query.sn ? String(req.query.sn).trim() : '';
    if (!sn) return res.status(400).json({ error: 'sn query parameter is required' });

    const client = await pool.connect();
    try {
      // Find the most recent entry for this SN to determine the terminal id.
      // Normalize incoming sn to uppercase to match the /api/tank-sns output.
      const normalizedSn = (sn.toUpperCase().startsWith('ZN') ? ('ZN' + sn.slice(2)) : ('ZN' + sn.toUpperCase()));
      const q = `
        SELECT id AS terminal_id, sn, "current_timestamp" AS ts
        FROM tank_level
        WHERE UPPER(sn) = UPPER($1)
        ORDER BY "current_timestamp" DESC
        LIMIT 1
      `;
      const r = await client.query(q, [normalizedSn]);
      if (!r.rows || r.rows.length === 0) {
        return res.status(404).json({ error: 'not found' });
      }
      const row = r.rows[0];
      return res.json({ terminal_id: row.terminal_id, sn: row.sn });
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('GET /api/tank-by-sn failed:', err && err.message);
    return res.status(500).json({ error: 'failed to fetch terminal by sn' });
  }
});

/* -------------------------
   NEW: Document Tracker API (tank_documents)
   ------------------------- */

function parseDateOrNull(s) {
  if (s == null || String(s).trim() === '') return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
function computeStatusForDate(isoDate) {
  if (!isoDate) return 'unknown';
  const today = new Date();
  const d = new Date(isoDate + 'T00:00:00Z');
  const diffDays = Math.ceil((d.getTime() - today.getTime()) / 86400000);
  if (diffDays < 0) return 'expired';
  if (diffDays <= 30) return 'renewal';
  return 'valid';
}
function rowWithStatuses(r) {
  return {
    id: r.id,
    sn: r.sn,
    building_type: r.building_type,
    building_code: r.building_code,
    building_name: r.building_name,
    latitude: r.latitude === null || r.latitude === undefined ? null : Number(r.latitude),
    longitude: r.longitude === null || r.longitude === undefined ? null : Number(r.longitude),
    istifaa_expiry_date: r.istifaa_expiry_date,
    amc_expiry_date: r.amc_expiry_date,
    doe_noc_expiry_date: r.doe_noc_expiry_date,
    coc_expiry_date: r.coc_expiry_date,
    tpi_expiry_date: r.tpi_expiry_date,
    notes: r.notes || null,
    created_at: normalizeDbTimestampToIso(r.created_at),
    updated_at: normalizeDbTimestampToIso(r.updated_at),
    statuses: {
      istifaa: computeStatusForDate(r.istifaa_expiry_date),
      amc: computeStatusForDate(r.amc_expiry_date),
      doe_noc: computeStatusForDate(r.doe_noc_expiry_date),
      coc: computeStatusForDate(r.coc_expiry_date),
      tpi: computeStatusForDate(r.tpi_expiry_date),
    }
  };
}

// LIST with optional search
app.get('/api/tank-documents', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10) || 1, 1), 2000);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
    const q = (req.query.q || '').toString().trim();

    const client = await pool.connect();
    try {
      let sql = `
        SELECT id, sn, building_type, building_code, building_name, latitude, longitude,
               istifaa_expiry_date, amc_expiry_date, doe_noc_expiry_date, coc_expiry_date, tpi_expiry_date,
               notes, created_at, updated_at
        FROM tank_documents
      `;
      const params = [];
      if (q) {
        sql += ` WHERE sn ILIKE $1 OR building_code ILIKE $1 OR building_name ILIKE $1 `;
        params.push(`%${q}%`);
      }
      sql += ` ORDER BY updated_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`;
      const r = await client.query(sql, params);
      const rows = (r.rows || []).map(rowWithStatuses);
      res.json({ count: rows.length, rows });
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('GET /api/tank-documents failed:', err && err.message);
    res.status(500).json({ error: 'failed to fetch tank documents' });
  }
});

app.get('/api/tank-documents/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    const client = await pool.connect();
    try {
      const r = await client.query(
        `SELECT id, sn, building_type, building_code, building_name, latitude, longitude,
                istifaa_expiry_date, amc_expiry_date, doe_noc_expiry_date, coc_expiry_date, tpi_expiry_date,
                notes, created_at, updated_at
         FROM tank_documents WHERE id = $1 LIMIT 1`, [id]
      );
      if (!r.rows || r.rows.length === 0) return res.status(404).json({ error: 'not found' });
      res.json(rowWithStatuses(r.rows[0]));
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('GET /api/tank-documents/:id failed:', err && err.message);
    res.status(500).json({ error: 'failed to fetch tank document' });
  }
});

app.post('/api/tank-documents', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    // SN is now auto-generated server-side; ignore any client-sent sn

    const building_type = b.building_type == null ? null : String(b.building_type).trim();
    const building_code = b.building_code == null ? null : String(b.building_code).trim();
    const building_name = b.building_name == null ? null : String(b.building_name).trim();
    const latitude = b.latitude == null || b.latitude === '' ? null : Number(b.latitude);
    const longitude = b.longitude == null || b.longitude === '' ? null : Number(b.longitude);
    const istifaa_expiry_date = parseDateOrNull(b.istifaa_expiry_date);
    const amc_expiry_date = parseDateOrNull(b.amc_expiry_date);
    const doe_noc_expiry_date = parseDateOrNull(b.doe_noc_expiry_date);
    const coc_expiry_date = parseDateOrNull(b.coc_expiry_date);
    const tpi_expiry_date = parseDateOrNull(b.tpi_expiry_date);
    const notes = b.notes == null ? null : String(b.notes).trim();

    const client = await pool.connect();
    try {
      // Auto-generate SN: next integer starting at 1.
      // We extract digits from existing sn values to be tolerant if any legacy non-numeric sn exist.
      const q = `
        INSERT INTO tank_documents
          (sn, building_type, building_code, building_name, latitude, longitude,
           istifaa_expiry_date, amc_expiry_date, doe_noc_expiry_date, coc_expiry_date, tpi_expiry_date,
           notes, created_at, updated_at)
        VALUES (
          (SELECT COALESCE(MAX(CAST(regexp_replace(sn, '\\D', '', 'g') AS INTEGER)), 0) + 1 FROM tank_documents),
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), now()
        )
        ON CONFLICT (sn, building_code) DO UPDATE SET
          building_type = EXCLUDED.building_type,
          building_name = EXCLUDED.building_name,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          istifaa_expiry_date = EXCLUDED.istifaa_expiry_date,
          amc_expiry_date = EXCLUDED.amc_expiry_date,
          doe_noc_expiry_date = EXCLUDED.doe_noc_expiry_date,
          coc_expiry_date = EXCLUDED.coc_expiry_date,
          tpi_expiry_date = EXCLUDED.tpi_expiry_date,
          notes = EXCLUDED.notes,
          updated_at = now()
        RETURNING id, sn, building_type, building_code, building_name, latitude, longitude,
                  istifaa_expiry_date, amc_expiry_date, doe_noc_expiry_date, coc_expiry_date, tpi_expiry_date,
                  notes, created_at, updated_at;
      `;
      const params = [building_type, building_code, building_name, latitude, longitude,
        istifaa_expiry_date, amc_expiry_date, doe_noc_expiry_date, coc_expiry_date, tpi_expiry_date, notes];
      const r = await client.query(q, params);
      res.status(201).json(rowWithStatuses(r.rows[0]));
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('POST /api/tank-documents failed:', err && err.message);
    res.status(500).json({ error: 'failed to save tank document' });
  }
});

app.put('/api/tank-documents/:id', express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    const b = req.body || {};

    // Do not allow updating SN via this endpoint
    const fields = {
      building_type: b.building_type,
      building_code: b.building_code,
      building_name: b.building_name,
      latitude: b.latitude == null || b.latitude === '' ? null : Number(b.latitude),
      longitude: b.longitude == null || b.longitude === '' ? null : Number(b.longitude),
      istifaa_expiry_date: parseDateOrNull(b.istifaa_expiry_date),
      amc_expiry_date: parseDateOrNull(b.amc_expiry_date),
      doe_noc_expiry_date: parseDateOrNull(b.doe_noc_expiry_date),
      coc_expiry_date: parseDateOrNull(b.coc_expiry_date),
      tpi_expiry_date: parseDateOrNull(b.tpi_expiry_date),
      notes: b.notes == null ? null : String(b.notes).trim()
    };

    const columns = [];
    const params = [];
    let idx = 1;
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) {
        columns.push(`${k} = $${idx++}`);
        params.push(v);
      }
    }
    if (!columns.length) return res.status(400).json({ error: 'no fields to update' });
    params.push(id);

    const client = await pool.connect();
    try {
      const r = await client.query(
        `UPDATE tank_documents SET ${columns.join(', ')}, updated_at = now()
         WHERE id = $${idx} RETURNING id, sn, building_type, building_code, building_name, latitude, longitude,
           istifaa_expiry_date, amc_expiry_date, doe_noc_expiry_date, coc_expiry_date, tpi_expiry_date, notes, created_at, updated_at`,
        params
      );
      if (!r.rows || r.rows.length === 0) return res.status(404).json({ error: 'not found' });
      res.json(rowWithStatuses(r.rows[0]));
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('PUT /api/tank-documents/:id failed:', err && err.message);
    res.status(500).json({ error: 'failed to update tank document' });
  }
});

app.delete('/api/tank-documents/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    const client = await pool.connect();
    try {
      const r = await client.query(`DELETE FROM tank_documents WHERE id = $1`, [id]);
      res.json({ ok: true, deleted: r.rowCount || 0 });
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('DELETE /api/tank-documents/:id failed:', err && err.message);
    res.status(500).json({ error: 'failed to delete tank document' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), dbAvailable });
});

app.get('/internal/dbstatus', (req, res) => {
  res.json({ dbAvailable, lastDbError });
});

/* -------------------------
   REAL-TIME DEVICE STATUS (MQTT + Ping + socket.io)
   - Subscribes to MQTT topic for the configured terminal (default 230346).
   - Pings the provided VPN IP periodically to determine panel online/offline.
   - Keeps in-memory deviceStatus map and broadcasts updates to Socket.IO clients.
   - Also exposes GET /api/device-status?terminalId=... for clients that prefer polling.
*/

/* Configuration (add to .env as requested):
   MQTT_HOST (default 3.227.99.254)
   MQTT_PORT (default 1883)
   MQTT_TERMINAL_ID (default 230346)
   MQTT_TOPIC_230346 (default BivicomData6)
   PING_IP_230346 (default 10.0.0.47)
   PING_INTERVAL_MS (default 10000)
*/

const MQTT_HOST = process.env.MQTT_HOST || '3.227.99.254';
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883', 10);
const MQTT_TERMINAL_ID = process.env.MQTT_TERMINAL_ID || (process.env.MQTT_TERMINAL || '230346');
const MQTT_TOPIC_230346 = process.env.MQTT_TOPIC_230346 || 'BivicomData6';

const PING_IP_230346 = process.env.PING_IP_230346 || '10.0.0.47';
const PING_INTERVAL = Math.max(1000, parseInt(process.env.PING_INTERVAL_MS || '10000', 10));

const WS_PATH = process.env.WS_PATH || '/ws';

// In-memory status map: terminalId -> { lel: number|null, lastLelAt: iso|null, panelOnline: boolean, lastPingAt: iso|null, topic }
const deviceStatus = {};

// Initialize entry for our main device
deviceStatus[String(MQTT_TERMINAL_ID)] = {
  terminal_id: String(MQTT_TERMINAL_ID),
  lel: null,
  lastLelAt: null,
  panelOnline: false,
  lastPingAt: null,
  topic: MQTT_TOPIC_230346
};

// Helper: broadcast function (populated after socket.io server created)
let io = null;
// --- socket.io broadcastStatusUpdate ---
function broadcastStatusUpdate(payload) {
  try {
    if (!io) {
      console.debug('[io] broadcast skipped: io not initialized', payload);
      return;
    }
    // Emit using event name present in payload.type or fallback to 'status_update'
    if (payload && payload.type && typeof payload.type === 'string') {
      io.emit(payload.type, payload);
    } else {
      io.emit('status_update', payload);
    }
    console.debug('[io] broadcasted:', payload && payload.type ? payload.type : 'status_update');
  } catch (e) {
    console.warn('[io] broadcastStatusUpdate error', e && e.message);
  }
}
// MQTT client connect and subscription
try {
  const mqttUrl = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;
  const mqttClient = mqtt.connect(mqttUrl);

  mqttClient.on('connect', () => {
    console.log('MQTT: connected to', mqttUrl);
    try {
      mqttClient.subscribe(MQTT_TOPIC_230346, (err) => {
        if (err) console.warn('MQTT subscribe error', err && err.message);
        else console.log('MQTT: subscribed to', MQTT_TOPIC_230346);
      });
    } catch (e) {
      console.warn('MQTT subscribe exception', e && e.message);
    }
  });

// --- REPLACE the mqttClient.on('message', ...) handler with the following block ---

  mqttClient.on('message', (topic, messageBuf) => {
    try {
      const raw = messageBuf.toString();

      // Attempt to parse JSON first
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        parsed = null;
      }

      // Robust recursive extractor for keys like 'lel' (case-insensitive)
      function findNumericByKey(obj, keys = ['lel', 'level', 'lvl', 'value']) {
        if (obj == null) return null;
        if (typeof obj !== 'object') return null;
        for (const k of Object.keys(obj)) {
          try {
            if (keys.includes(String(k).toLowerCase())) {
              const candidate = obj[k];
              const n = parseNumericValue(candidate);
              if (n != null && !isNaN(n)) return n;
            }
          } catch (e) { /* ignore per-key errors */ }
        }
        // Traverse children
        for (const v of Object.values(obj)) {
          if (v && typeof v === 'object') {
            const found = findNumericByKey(v, keys);
            if (found != null && !isNaN(found)) return found;
          }
        }
        return null;
      }

      let lelVal = null;

      if (parsed && typeof parsed === 'object') {
        // First try recursive key lookup (preferred)
        lelVal = findNumericByKey(parsed, ['lel', 'LEL', 'level', 'Level', 'value', 'Value']);
      }

      // If not found via parsed object, try tolerant regex that matches quoted keys like "LEL":0
      if (lelVal === null) {
        const m = raw.match(/["']?\blel\b["']?\s*[:=]\s*["']?(-?\d+(?:[.,]\d+)?)["']?/i);
        if (m) {
          lelVal = parseNumericValue(m[1]);
        }
      }

      // Final fallback: pick a plausible numeric token from the message.
      // Prefer numbers in range 0..100 (typical percentage). This prevents picking timestamps.
      if (lelVal === null) {
        const all = Array.from(raw.matchAll(/-?\d+(?:[.,]\d+)?/g)).map(m => parseFloat(m[0].replace(',', '.'))).filter(n => !isNaN(n));
        if (all.length > 0) {
          // prefer any value between 0 and 100 (last occurrence), else pick the last numeric token
          const plausible = all.filter(n => n >= 0 && n <= 100);
          if (plausible.length) {
            lelVal = plausible[plausible.length - 1];
          } else {
            lelVal = all[all.length - 1];
          }
        }
      }

      const tid = String(MQTT_TERMINAL_ID);
      const nowIso = new Date().toISOString();
      if (!deviceStatus[tid]) {
        deviceStatus[tid] = { terminal_id: tid, lel: null, lastLelAt: null, panelOnline: false, lastPingAt: null, topic: MQTT_TOPIC_230346 };
      }

      // Only overwrite if we parsed a valid numeric LEL
      if (lelVal !== null && !isNaN(lelVal)) {
        // convert to Number explicitly
        deviceStatus[tid].lel = Number(lelVal);
        deviceStatus[tid].lastLelAt = nowIso;
      }

      // Broadcast update for this terminal (include only relevant fields)
      const payload = {
        type: 'status_update',
        terminal_id: tid,
        lel: deviceStatus[tid].lel,
        lastLelAt: deviceStatus[tid].lastLelAt,
        panelOnline: deviceStatus[tid].panelOnline,
        lastPingAt: deviceStatus[tid].lastPingAt,
        topic: MQTT_TOPIC_230346
      };
      broadcastStatusUpdate(payload);
    } catch (err) {
      console.warn('MQTT message handling error', err && err.message);
    }
  });

  mqttClient.on('error', (err) => {
    console.warn('MQTT client error', err && err.message);
  });

} catch (e) {
  console.warn('Failed to initialize MQTT client', e && e.message);
}

// Ping loop for configured IPs (only the one given for now)
async function doPingLoop() {
  const tid = String(MQTT_TERMINAL_ID);
  const host = PING_IP_230346;
  try {
    const res = await ping.promise.probe(host, { timeout: 2 });
    const was = deviceStatus[tid] && deviceStatus[tid].panelOnline;
    const nowIso = new Date().toISOString();
    if (!deviceStatus[tid]) deviceStatus[tid] = { terminal_id: tid, lel: null, lastLelAt: null, panelOnline: false, lastPingAt: null, topic: MQTT_TOPIC_230346 };
    deviceStatus[tid].panelOnline = !!res.alive;
    deviceStatus[tid].lastPingAt = nowIso;

    // Broadcast only if changed OR include periodic heartbeat update (we'll broadcast each run to keep clients in sync)
    const payload = {
      type: 'status_update',
      terminal_id: tid,
      lel: deviceStatus[tid].lel,
      lastLelAt: deviceStatus[tid].lastLelAt,
      panelOnline: deviceStatus[tid].panelOnline,
      lastPingAt: deviceStatus[tid].lastPingAt,
      topic: MQTT_TOPIC_230346
    };
    broadcastStatusUpdate(payload);
  } catch (err) {
    console.warn('Ping error for', host, err && err.message);
  }
}
// start ping interval
setInterval(() => { doPingLoop().catch(()=>{}); }, PING_INTERVAL);
// do an initial ping on startup
doPingLoop().catch(()=>{});

/* HTTP API to fetch device status for a terminal (polling fallback)
   GET /api/device-status?terminalId=230346
   returns { terminal_id, lel, lastLelAt, panelOnline, lastPingAt, topic }
*/
app.get('/api/device-status', (req, res) => {
  try {
    const tid = req.query.terminalId ? String(req.query.terminalId).trim() : '';
    if (!tid) return res.status(400).json({ error: 'terminalId query parameter is required' });
    const s = deviceStatus[tid];
    if (!s) return res.status(404).json({ error: 'not found' });
    return res.json({
      terminal_id: s.terminal_id,
      lel: s.lel === null || s.lel === undefined ? null : Number(s.lel),
      lastLelAt: s.lastLelAt || null,
      panelOnline: !!s.panelOnline,
      lastPingAt: s.lastPingAt || null,
      topic: s.topic || null
    });
  } catch (err) {
    console.warn('GET /api/device-status failed', err && err.message);
    return res.status(500).json({ error: 'failed to fetch device status' });
  }
});

/* NEW: socket.io setup
   - We create a Socket.IO server bound to the same HTTP server to push updates to clients.
*/

// Start HTTP server once
const server = app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// Initialize socket.io bound to the same HTTP server
try {
  io = new SocketIO(server, {
    path: WS_PATH,
    // optional CORS settings if your front-end is served from another origin:
    // cors: { origin: '*' }
  });

  io.on('connection', (socket) => {
    const remote = (socket && socket.handshake && socket.handshake.address) ? socket.handshake.address : (socket.conn && socket.conn.remoteAddress) ? socket.conn.remoteAddress : 'unknown';
    console.info('[io] new connection from', remote);

    // Send initial snapshot
    try {
      const snapshot = { type: 'init', payload: deviceStatus };
      // send as 'init' event
      socket.emit('init', deviceStatus);
    } catch (e) { console.warn('[io] send snapshot exception', e && e.message); }

    socket.on('message', (msg) => {
      // For debugging, show small messages from client (avoid logging large payloads)
      try {
        const sample = (typeof msg === 'string' && msg.length > 300) ? msg.slice(0, 300) + '…' : msg;
        console.debug('[io] message from', remote, sample);
        // optional: parse and handle client pings in the future
      } catch (e) { /* ignore */ }
    });

    socket.on('disconnect', (reason) => {
      console.info('[io] client disconnected', remote, reason);
    });

    socket.on('error', (err) => {
      console.warn('Realtime socket error', err && err.message);
    });
  });
} catch (err) {
  console.warn('Failed to initialize socket.io', err && err.message);
}

async function shutdown() {
  console.log('Shutting down server...');
  try { await server.close(); } catch (e) { /* ignore */ }
  try { if (io) { io.close(); } } catch (e) { /* ignore */ }
  try { await pool.end(); } catch (e) { /* ignore */ }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/* ----------------------------------------
   NEW: Gas consumption endpoint (/api/consumption)
   ---------------------------------------- */

// Helper: parse liters from a free-form capacity string (e.g., "2000 L", "2,000 liters")
function parseCapacityLiters(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str) return null;
  const m = str.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return isNaN(n) ? null : n;
}

// Cache (TTL in ms)
const CONSUMPTION_CACHE_TTL_MS = Math.max(1000, parseInt(process.env.CONSUMPTION_CACHE_TTL_MS || '60000', 10));
const consumptionCache = new Map(); // key -> { expiresAt, data }

function cacheKey(terminalId, sinceIso, untilIso) {
  return `${terminalId || 'ALL'}|${sinceIso || ''}|${untilIso || ''}`;
}

function isExpired(entry) {
  return !entry || !entry.expiresAt || Date.now() > entry.expiresAt;
}

// Compute daily percent drops from sorted rows within each calendar day (UTC).
function computeDailySeries(rows) {
  // rows: [{ timestamp: iso, tank_level: number|null }]
  const byDay = new Map(); // YYYY-MM-DD -> array of numeric levels in time order
  rows.forEach(r => {
    const ts = normalizeDbTimestampToIso(r.timestamp);
    if (!ts) return;
    const day = ts.slice(0, 10); // YYYY-MM-DD
    const lvl = (r.tank_level === null || r.tank_level === undefined) ? null : Number(r.tank_level);
    if (lvl == null || isNaN(lvl)) return;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(lvl);
  });

  // Ensure levels are in order; percent drop per day sums only negative deltas (ignore increases), include tiny negatives.
  const result = [];
  for (const [day, levels] of byDay.entries()) {
    // levels already in chronological order because query sorted ASC by timestamp
    let drop = 0;
    for (let i = 1; i < levels.length; i++) {
      const prev = levels[i - 1];
      const next = levels[i];
      const delta = next - prev;
      if (delta < 0) {
        drop += Math.abs(delta);
      } else {
        // ignore increases; do not subtract tiny negatives anywhere else
      }
    }
    result.push({ day, percentDrop: drop, readings: levels.length });
  }

  // Sort by day ascending
  result.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return result;
}

// Helper: round to 2 decimals
function round2(n) {
  if (n == null || isNaN(n)) return null;
  return Math.round(Number(n) * 100) / 100;
}

app.get('/api/consumption', async (req, res) => {
  try {
    const terminalIdParam = req.query.terminalId ? String(req.query.terminalId).trim() : null;

    // Define window: last 30 full days (exclude today)
    const now = new Date();
    const todayUtcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const until = todayUtcMidnight; // exclusive upper bound (today)
    const since = new Date(todayUtcMidnight.getTime() - (30 * 24 * 60 * 60 * 1000)); // 30 days prior

    const sinceIso = since.toISOString();
    const untilIso = until.toISOString();

    const key = cacheKey(terminalIdParam, sinceIso, untilIso);
    const cached = consumptionCache.get(key);
    if (cached && !isExpired(cached)) {
      return res.json(cached.data);
    }

    const client = await pool.connect();
    try {
      // Determine terminals
      let terminalIds = [];
      if (terminalIdParam) {
        terminalIds = [terminalIdParam];
      } else {
        const rInfo = await client.query(`SELECT terminal_id FROM tank_info WHERE terminal_id IS NOT NULL`);
        const rLevel = await client.query(`
          SELECT DISTINCT id AS terminal_id
          FROM tank_level
          WHERE "current_timestamp" >= (now() - interval '60 days')
        `);
        const set = new Set();
        (rInfo.rows || []).forEach(row => { if (row.terminal_id) set.add(String(row.terminal_id)); });
        (rLevel.rows || []).forEach(row => { if (row.terminal_id) set.add(String(row.terminal_id)); });
        terminalIds = Array.from(set);
      }

      // Capacity map
      const capMap = new Map();
      if (terminalIds.length) {
        const qCap = await client.query(`SELECT terminal_id, lpg_tank_capacity FROM tank_info WHERE terminal_id = ANY($1::text[])`, [terminalIds]);
        (qCap.rows || []).forEach(row => {
          capMap.set(String(row.terminal_id), parseCapacityLiters(row.lpg_tank_capacity));
        });
      }

      // Build responses
      const rowsOut = [];
      const MIN_READINGS_PER_DAY = Math.max(1, parseInt(process.env.CONSUMPTION_MIN_READINGS_PER_DAY || '3', 10));

      for (const tid of terminalIds) {
        // Fetch rows for window sorted ascending
        const q = `
          SELECT "current_timestamp" AS ts, tank_level
          FROM tank_level
          WHERE id = $1
            AND "current_timestamp" >= $2
            AND "current_timestamp" < $3
          ORDER BY "current_timestamp" ASC
        `;
        const r = await client.query(q, [String(tid), sinceIso, untilIso]);
        const rows = (r.rows || []).map(rr => ({
          timestamp: normalizeDbTimestampToIso(rr.ts),
          tank_level: rr.tank_level === null || rr.tank_level === undefined ? null : Number(rr.tank_level)
        }));

        const dailySeries = computeDailySeries(rows); // [{ day, percentDrop, readings }]
        // Daily: pick the most recent completed day (yesterday) if present
        const yesterday = new Date(until.getTime() - (24 * 60 * 60 * 1000));
        const yesterdayKey = yesterday.toISOString().slice(0, 10);
        const dailyEntry = dailySeries.find(d => d.day === yesterdayKey) || null;

        const capacityLiters = capMap.has(String(tid)) ? capMap.get(String(tid)) : null;

        let dailyOut = null;
        if (dailyEntry) {
          const liters = (capacityLiters != null && !isNaN(capacityLiters)) ? (capacityLiters * (dailyEntry.percentDrop / 100.0)) : null;
          dailyOut = {
            date: dailyEntry.day,
            percent_drop: round2(dailyEntry.percentDrop),
            liters: round2(liters),
            readings: dailyEntry.readings
          };
        }

        // Monthly averages over last 30 days
        const daysIncluded = dailySeries.filter(d => d.readings >= MIN_READINGS_PER_DAY);
        const avgPercentPerDay = daysIncluded.length
          ? (daysIncluded.reduce((sum, d) => sum + d.percentDrop, 0) / daysIncluded.length)
          : null;
        const totalPercent30d = dailySeries.reduce((sum, d) => sum + d.percentDrop, 0);

        let avgLitersPerDay = null;
        let totalLiters30d = null;
        if (capacityLiters != null && !isNaN(capacityLiters)) {
          avgLitersPerDay = (avgPercentPerDay != null) ? (capacityLiters * (avgPercentPerDay / 100.0)) : null;
          totalLiters30d = capacityLiters * (totalPercent30d / 100.0);
        }

        rowsOut.push({
          terminal_id: String(tid),
          capacity_liters: capacityLiters,
          daily: dailyOut,
          monthly: {
            average_liters_per_day: round2(avgLitersPerDay),
            average_percent_per_day: round2(avgPercentPerDay),
            total_liters_30d: round2(totalLiters30d),
            total_percent_30d: round2(totalPercent30d),
            days_included: daysIncluded.length,
            days_total: dailySeries.length
          }
        });
      }

      const out = terminalIdParam
        ? (rowsOut[0] || { terminal_id: terminalIdParam, capacity_liters: null, daily: null, monthly: { average_liters_per_day: null, average_percent_per_day: null, total_liters_30d: null, total_percent_30d: null, days_included: 0, days_total: 0 } })
        : { rows: rowsOut };

      consumptionCache.set(key, { expiresAt: Date.now() + CONSUMPTION_CACHE_TTL_MS, data: out });
      return res.json(out);
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('GET /api/consumption failed:', err && err.message);
    return res.status(500).json({ error: 'failed to compute consumption' });
  }
});
