const express = require('express');
const fetch = require('node-fetch');
const { parseStringPromise } = require('xml2js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3007;

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// SOAP endpoint and credentials (keep as you have them)
const SOAP_URL = 'https://webvision.digimatic.it/api/2/service.php';
const SOAP_ACTION = 'https://webvision.digimatic.it/api/2/TerminalGetInfo';
const SOAP_USERNAME = 'AlFanarG_tGdvI0Tt';
const SOAP_PASSWORD = 'GYU8Stf0PO62pL3BWLeh';

// Helper: recursively collect all "item" nodes from parsed XML
function collectItems(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'item') {
      if (Array.isArray(v)) out.push(...v);
      else out.push(v);
    } else {
      if (Array.isArray(v)) {
        v.forEach(el => collectItems(el, out));
      } else {
        collectItems(v, out);
      }
    }
  }
  return out;
}

// Robust helper to extract text from nodes (strings, objects with "_" or "#text", arrays, nested)
function nodeText(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value) && value.length > 0) {
    for (const v of value) {
      const t = nodeText(v);
      if (t) return t;
    }
    return null;
  }
  if (typeof value === 'object') {
    if (typeof value._ === 'string') return value._;
    if (typeof value['#text'] === 'string') return value['#text'];
    for (const v of Object.values(value)) {
      const t = nodeText(v);
      if (t) return t;
    }
  }
  return null;
}

function normStr(s) {
  return (s || '').toString().trim().toUpperCase();
}

// Find the item that corresponds to the level ("LIVELLO") using a few heuristics
function findLivelloItem(items) {
  if (!Array.isArray(items)) return null;

  const candidateNameKeys = [
    'Name', 'name', 'Nome', 'nome', 'Key', 'key', 'Description', 'description',
    'Descrizione', 'descrizione', 'Label', 'label'
  ];

  // 1) Exact match on known name-like keys (case-insensitive)
  for (const it of items) {
    for (const k of candidateNameKeys) {
      if (k in it) {
        const txt = nodeText(it[k]);
        if (normStr(txt) === 'LIVELLO' || normStr(txt) === 'LEVEL') return it;
      }
    }
  }

  // 2) Partial contains "LIVELLO" or "LEVEL" in any field
  for (const it of items) {
    for (const [k, v] of Object.entries(it)) {
      const txt = nodeText(v);
      if (txt && (normStr(txt).includes('LIVELLO') || normStr(txt).includes('LEVEL'))) return it;
    }
  }

  // 3) Check Value/Valore fields for labeling
  for (const it of items) {
    const valTxt = nodeText(it.Value) || nodeText(it.Valore) || nodeText(it.value) || nodeText(it.valore);
    if (valTxt && (normStr(valTxt).includes('LIVELLO') || normStr(valTxt).includes('LEVEL'))) return it;
  }

  // 4) Heuristic: if only one item has a numeric-ish value, pick it
  const numericCandidates = items.filter(it => {
    const v = nodeText(it.Value) || nodeText(it.Valore) || nodeText(it.value) || nodeText(it.valore);
    if (!v) return false;
    return /[0-9]+([.,][0-9]+)?\s*%?$/.test(String(v).trim());
  });
  if (numericCandidates.length === 1) return numericCandidates[0];

  return null;
}

// Extract first non-empty field from the given list of keys, fallback to first non-empty field
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

// Main API: returns { value, timestamp } or a concise error message
app.get('/api/tank', async (req, res) => {
  try {
    const terminalId = req.query.terminalId;
    if (!terminalId) return res.status(400).json({ error: 'terminalId query parameter is required' });

    const soapBody = buildSoapBody(terminalId);

    const response = await fetch(SOAP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': SOAP_ACTION,
        'Authorization': 'Basic ' + Buffer.from(`${SOAP_USERNAME}:${SOAP_PASSWORD}`).toString('base64')
      },
      body: soapBody
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return res.status(502).json({ error: 'Bad response from SOAP service', status: response.status, body: text });
    }

    const xml = await response.text();
    let parsed;
    try {
      parsed = await parseStringPromise(xml, { explicitArray: false, ignoreAttrs: false });
    } catch (parseErr) {
      return res.status(500).json({ error: 'Failed to parse SOAP XML', details: parseErr.message });
    }

    const items = collectItems(parsed);
    const target = findLivelloItem(items);

    if (!target) {
      // concise diagnostic: number of items and a small sample of textual fields
      const sample = items.slice(0, 8).map((it, idx) => {
        const keys = Object.keys(it || {}).slice(0, 6);
        const values = keys.map(k => nodeText(it[k])).filter(Boolean).slice(0, 3);
        return { index: idx, samples: values };
      });
      return res.status(404).json({ error: 'LIVELLO item not found in SOAP response', itemsFound: items.length, sample });
    }

    const valueKeys = ['Value', 'value', 'Valore', 'valore', 'Val', 'val'];
    const timeKeys = ['Timestamp', 'timestamp', 'Time', 'time', 'DateTime', 'dateTime', 'Data', 'DataOra'];

    const value = extractField(target, valueKeys);
    const timestamp = extractField(target, timeKeys);

    if (!value || !timestamp) {
      return res.status(500).json({ error: 'Value or Timestamp missing in LIVELLO item', itemPreview: Object.keys(target).slice(0, 6) });
    }

    return res.json({ value, timestamp });
  } catch (err) {
    console.error('Error in /api/tank', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
