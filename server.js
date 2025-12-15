const express = require('express');
const fetch = require('node-fetch');
const { parseStringPromise } = require('xml2js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3007;

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Replace these with the actual SOAP endpoint and credentials
const SOAP_URL = 'https://webvision.digimatic.it/api/2/service.php'; // <--- replace with real base URL
const SOAP_ACTION = 'https://webvision.digimatic.it/api/2/TerminalGetInfo'; // <--- replace with real SOAPAction
const SOAP_USERNAME = 'AlFanarG_tGdvI0Tt'; // <--- replace with username
const SOAP_PASSWORD = 'GYU8Stf0PO62pL3BWLeh'; // <--- replace with password

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

app.get('/api/tank', async (req, res) => {
  try {
    const terminalId = req.query.terminalId;
    if (!terminalId) {
      return res.status(400).json({ error: 'terminalId query parameter is required' });
    }

    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:api="http://webservice.api.shitek.it/">
  <soap:Body>
    <TerminalGetInfo>
      <TerminalId>${terminalId}</TerminalId>
    </TerminalGetInfo>
  </soap:Body>
</soap:Envelope>`;

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
      const text = await response.text();
      return res.status(502).json({ error: 'Bad response from SOAP service', status: response.status, body: text });
    }

    const xml = await response.text();
    const parsed = await parseStringPromise(xml, { explicitArray: false, ignoreAttrs: false });

    const items = collectItems(parsed);

    const target = items.find(it => {
      const name = it.Name;
      if (!name) return false;
      return (typeof name === 'string' && name === 'LIVELLO') ||
             (typeof name === 'object' && name._ === 'LIVELLO');
    });

    if (!target) {
      return res.status(404).json({ error: 'LIVELLO item not found in SOAP response', rawXml: xml });
    }

    const value = (typeof target.Value === 'string') ? target.Value : (target.Value && target.Value._) ? target.Value._ : null;
    const timestamp = (typeof target.Timestamp === 'string') ? target.Timestamp : (target.Timestamp && target.Timestamp._) ? target.Timestamp._ : null;

    if (!value || !timestamp) {
      return res.status(500).json({ error: 'Value or Timestamp missing in item', item: target });
    }

    res.json({ value, timestamp });
  } catch (err) {
    console.error('Error in /api/tank', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
