// Devices to display — edit friendly names or IDs here
let devices = [
  { id: "230347", name: "Transmitter A" },
  { id: "230344", name: "Transmitter B" },
  { id: "230348", name: "Transmitter C" },
  { id: "230345", name: "Transmitter D" },
  { id: "230346", name: "Transmitter E" },
  { id: "231927", name: "Transmitter F" }
];

// Poll interval in milliseconds
const POLL_INTERVAL_MS = 20000;

const tanksContainer = document.getElementById('tanks');
const globalErrorEl = document.getElementById('global-error');
const ORDER_KEY = 'tank_order_v1';

let selectedCard = null; // for keyboard-only reordering

// Simple auth helper (in-memory flag set by the login modal during this page load)
function isLoggedIn() {
  try {
    return !!window._clientAuthenticated;
  } catch (e) {
    return false;
  }
}

// New helper to detect admin login
function isAdmin() {
  try {
    return !!window._clientIsAdmin;
  } catch (e) {
    return false;
  }
}

// Who can see the Device Information menu (Sonic or Alfanar_Admin1)
function canSeeDeviceInformation() {
  try {
    const u = (window._clientUsername || '').trim();
    return (u === 'Sonic' || u === 'Alfanar_Admin1');
  } catch (e) {
    return false;
  }
}

// Simple HTML escape
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Try to extract a serial number from the device name (after the "—" dash)
function extractSnFromName(name) {
  if (!name) return undefined;
  const parts = String(name).split('—');
  if (parts.length > 1) {
    const sn = parts[1].trim();
    return sn || undefined;
  }
  // fallback: find a ZN... pattern
  const m = String(name).match(/\bZN[0-9]+\b/);
  return m ? m[0] : undefined;
}

// Load titles from the backend and update devices
async function loadTitles() {
  try {
    const resp = await fetch('/api/titles', { cache: 'no-store' });
    if (!resp.ok) throw new Error('Failed to fetch titles');
    const titles = await resp.json();
    const map = new Map(titles.map(t => [String(t.terminal_id), t.tank_title]));
    devices.forEach(device => {
      // Attach sn if not present
      if (!device.sn) device.sn = extractSnFromName(device.name);
      // Set the title from the fetched data, or use the existing device name as the default
      device.title = map.get(String(device.id)) || device.title || device.name;
    });
  } catch (err) {
    console.warn('Failed to load titles:', err && err.message);
  }

  // Also try to load site location information (latitude/longitude and a google maps link)
  try {
    const resp = await fetch('/api/sites', { cache: 'no-store' });
    if (resp.ok) {
      const json = await resp.json();
      if (Array.isArray(json.rows)) {
        const siteMap = new Map(json.rows.map(r => [String(r.terminal_id), r]));
        devices.forEach(device => {
          const s = siteMap.get(String(device.id));
          if (s) {
            device.lat = (s.latitude === null || s.latitude === undefined) ? undefined : Number(s.latitude);
            device.lng = (s.longitude === null || s.longitude === undefined) ? undefined : Number(s.longitude);
            device.locationLink = s.location || '';
            if (s.site) device.site = s.site;
            // optionally override title/site name
            if (!device.title && s.site) device.title = s.site;
          }
        });
      }
    }
  } catch (err) {
    console.warn('Failed to load sites:', err && err.message);
  }
}

// Allow users to edit titles and save to the server
async function saveTitle(terminalId, sn, title) {
  try {
    const body = { terminalId, title };
    if (sn) body.sn = sn;
    const resp = await fetch('/api/titles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const json = await resp.json().catch(() => ({}));
      throw new Error(json.error || 'Failed to save title');
    }
  } catch (err) {
    console.warn(`Failed to save title for terminal ${terminalId}:`, err.message);
    alert('Failed to save title. Please try again.');
  }
}

// Try to restore saved order from localStorage
function restoreDeviceOrder() {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (!raw) return;
    const order = JSON.parse(raw);
    if (!Array.isArray(order)) return;
    const map = new Map(devices.map(d => [d.id, d]));
    const ordered = [];
    for (const id of order) {
      if (map.has(id)) {
        ordered.push(map.get(id));
        map.delete(id);
      }
    }
    for (const d of devices) if (map.has(d.id)) ordered.push(d);
    devices = ordered;
  } catch (e) {
    console.warn('Failed to restore order', e);
  }
}

function persistDeviceOrder() {
  try {
    const ids = Array.from(document.querySelectorAll('.tank-card')).map(el => el.dataset.terminal);
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  } catch (e) {
    console.warn('Failed to persist order', e);
  }
}

function parsePercent(valueStr) {
  if (valueStr == null) return null;
  const s = String(valueStr).trim().replace(',', '.').replace('%', '');
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  return parseFloat(m[0]);
}

// parse a voltage-like string and return float (e.g. "3.531", "3,531 V")
function parseVoltage(valueStr) {
  if (valueStr == null) return null;
  const s = String(valueStr).trim().replace(',', '.').replace(/V|v/g, '').trim();
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  return parseFloat(m[0]);
}

// compute battery percent using linear mapping and rounding
function computeBatteryPercent(voltage, vMin = 3.35, vMax = 3.55) {
  if (voltage == null || isNaN(voltage)) return null;
  const v = Number(voltage);
  if (v <= vMin) return 0;
  if (v >= vMax) return 100;
  const pct = ((v - vMin) / (vMax - vMin)) * 100.0;
  return Math.round(pct); // rounding per your preference
}

// compute RSSI -> percent mapping (0..31 -> 0..100). Returns null for unknown/invalid.
function computeRssiPercent(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  // Treat common "unknown" code 99 as N/A
  if (/^99$/.test(s)) return null;
  // Some APIs might return non-numeric; try to extract integer
  const m = s.match(/-?\d+/);
  if (!m) return null;
  const r = parseInt(m[0], 10);
  if (isNaN(r)) return null;
  // Typical RSSI range for this device is 0..31 (higher is better). Clamp and convert.
  const minR = 0;
  const maxR = 31;
  const clamped = Math.max(minR, Math.min(maxR, r));
  const pct = Math.round((clamped / maxR) * 100);
  return pct;
}

// set simple battery color on small dot element
function setBatteryColor(pct, dotEl) {
  if (!dotEl) return;
  dotEl.classList.remove('status-green', 'status-orange', 'status-red');
  if (pct == null || isNaN(pct)) {
    dotEl.classList.add('status-red');
    return;
  }
  if (pct >= 50) dotEl.classList.add('status-green');
  else if (pct >= 20) dotEl.classList.add('status-orange');
  else dotEl.classList.add('status-red');
}

// status logic: NEW behavior per your spec
// Signature changed to accept the device context (which may include lpg_min_level / lpg_max_level)
function setStatusColor(valueNum, valueEl, dotEl, device) {
  // remove any previous status classes
  dotEl.classList.remove('status-green', 'status-orange', 'status-red');
  valueEl.classList.remove('muted');

  // unknown / invalid => red + muted
  if (valueNum == null || isNaN(valueNum)) {
    dotEl.classList.add('status-red');
    valueEl.classList.add('muted');
    return;
  }

  // read thresholds from device if present
  const min = (device && device.lpg_min_level !== undefined && device.lpg_min_level !== null) ? Number(device.lpg_min_level) : null;
  const max = (device && device.lpg_max_level !== undefined && device.lpg_max_level !== null) ? Number(device.lpg_max_level) : null;

  // If min is set and value is below min -> ALWAYS ORANGE
  if (min !== null && !isNaN(min) && valueNum < min) {
    dotEl.classList.add('status-orange');
    return;
  }

  // If max is set and value is above max -> ALWAYS RED
  if (max !== null && !isNaN(max) && valueNum > max) {
    dotEl.classList.add('status-red');
    return;
  }

  // If either threshold exists (and we haven't matched above/below), mark GREEN
  if ((min !== null && !isNaN(min)) || (max !== null && !isNaN(max))) {
    dotEl.classList.add('status-green');
    return;
  }

  // Fallback: no thresholds defined for this device -> use legacy mapping
  if (valueNum >= 30 && valueNum <= 70) {
    dotEl.classList.add('status-green');
  } else if (valueNum < 30) {
    dotEl.classList.add('status-orange');
  } else { // valueNum > 70
    dotEl.classList.add('status-red');
  }
}

/* Update card DOM to show location/link/coords (called after devices updated)
   NOTE: intentionally disabled — we remove the visual "Location:" row from each card.
*/
function updateCardLocationDisplay(device) {
  // Remove any existing location-row so it's never displayed.
  try {
    const card = document.querySelector(`.tank-card[data-terminal="${device.id}"]`);
    if (!card) return;
    const existing = card.querySelector('.meta .location-row');
    if (existing) existing.remove();
  } catch (e) {
    // ignore errors; this function is intentionally minimal
  }
}

// Create a card element for a device
function createCard(device) {
  const card = document.createElement('article');
  card.className = 'card tank-card';
  card.dataset.terminal = device.id;
  card.tabIndex = 0; // make focusable so user can click/focus and use keyboard

  // Ensure we have a serial cached
  if (!device.sn) device.sn = extractSnFromName(device.name);

  card.innerHTML = `
    <div class="title-edit-wrap">
      <input type="text" class="title-input" placeholder="Tank Title" value="${escapeHtml(device.title || '')}" />
    </div>
    <div class="card-top">
      <div class="device-name">${escapeHtml(device.name)}</div>
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="card-spinner" aria-hidden="true" style="display:none;"></div>
      </div>
    </div>

    <div class="result-header">
      <div class="value-unit">
        <div class="value-box">
          <div class="status-dot status-red" aria-hidden="true"></div>
          <div class="value skeleton muted" aria-live="polite" aria-atomic="true"> </div>
          <div class="unit">%</div>
        </div>
      </div>
    </div>
    <div class="meta">
      <div class="term-row admin-only" style="display:none;"><strong>Terminal ID:</strong> <span class="term">${escapeHtml(device.id)}</span></div>
      <div><strong>Timestamp:</strong> <span class="time">-</span></div>
      <div class="battery-row" style="margin-top:8px;"><strong>Battery Level:</strong>
        <span style="display:inline-flex;align-items:center;gap:8px;margin-left:8px;">
          <div class="battery-dot status-red" aria-hidden="true" style="width:18px;height:10px;border-radius:3px;"></div>
          <div class="battery-value muted">—</div>
          <div class="battery-unit" style="color:var(--muted);margin-left:6px">%</div>
        </span>
      </div>

      <!-- NEW GSM row placed under Battery Level (updated every poll) -->
      <div class="gsm-row" style="margin-top:6px;"><strong>GSM:</strong>
        <span style="display:inline-flex;align-items:center;gap:8px;margin-left:8px;">
          <div class="gsm-value muted">—</div>
          <div class="gsm-unit" style="color:var(--muted);margin-left:6px"></div>
        </span>
      </div>
    </div>

    <div class="card-footer">
      <div class="card-error" style="display:none;">
        <div class="card-error-text"></div>
        <button class="retry-btn" type="button" aria-label="Retry">Retry</button>
      </div>
    </div>

    <div class="controls" aria-hidden="true">
      <button class="refresh-btn" title="Refresh" aria-label="Refresh tank" type="button">
        <!-- small refresh SVG icon -->
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
          <path d="M21 12a9 9 0 10-2.25 5.625" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M21 3v6h-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>

      <button class="history-btn" title="History" aria-label="Show history" type="button">
        <!-- history / chart icon (simple) -->
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
          <path d="M3 3v18h18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M7 14v-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M12 14v-8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M17 14v-2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>

      <button class="info-btn" title="Device Info" aria-label="Device Info" type="button">
        <!-- info / document icon -->
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          <rect x="6" y="6" width="12" height="14" rx="2" stroke="currentColor" stroke-width="1.4" fill="none"></rect>
          <path d="M12 11v5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
          <circle cx="12" cy="9" r="0.6" fill="currentColor"></circle>
        </svg>
      </button>

      <button class="map-btn" title="Map" aria-label="Show map" type="button">
        <!-- simple pin icon -->
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2C8.686 2 6 4.686 6 8c0 4.5 6 12 6 12s6-7.5 6-12c0-3.314-2.686-6-6-6z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="12" cy="8" r="2.4" fill="currentColor"/>
        </svg>
      </button>
    </div>
  `.trim();

  // Title input behaviors:
  const titleInput = card.querySelector('.title-input');

  // Stop keyboard shortcuts (Space/Enter) from bubbling to the card when editing title
  titleInput.addEventListener('keydown', (e) => {
    // Allow typing space in the title; prevent card-level handlers
    if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') {
      e.stopPropagation();
    }
    // If user presses Enter, commit edit by blurring (then save in 'blur' handler)
    if (e.key === 'Enter') {
      e.preventDefault();
      titleInput.blur();
    }
  });

  // Save on blur (not on each keystroke); this avoids accidental saves on Space
  titleInput.addEventListener('blur', async () => {
    const newTitle = titleInput.value.trim();
    if (newTitle && newTitle !== device.title) {
      device.title = newTitle; // Update locally
      await saveTitle(device.id, device.sn, newTitle); // Save to the server
    }
  });

  // prevent the retry/refresh clicks from toggling selection
  card.querySelectorAll('button').forEach(b => {
    b.addEventListener('mousedown', e => e.stopPropagation());
    b.addEventListener('click', e => e.stopPropagation());
  });

  // click selects/deselects the card
  card.addEventListener('click', (e) => {
    e.preventDefault();
    selectCard(card);
  });

  // keyboard shortcuts on card — ignore if the focused element is the title input (or any input/textarea)
  card.addEventListener('keydown', (e) => {
    const target = e.target;
    const isEditableEl =
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable ||
      target.closest('.title-input');

    if (isEditableEl) return; // do not hijack keyboard while editing text

    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      selectCard(card);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectCard(card);
    }
  });

  // After building card, append location display (if available)
  setTimeout(() => updateCardLocationDisplay(device), 0);

  return card;
}

// Fetch data for a single card and update UI
async function fetchAndUpdate(device, cardEl, showSpinner = false) {
  const spinner = cardEl.querySelector('.card-spinner');
  const errorWrap = cardEl.querySelector('.card-error');
  const errorText = cardEl.querySelector('.card-error-text');
  const retryBtn = cardEl.querySelector('.retry-btn');
  const valueEl = cardEl.querySelector('.value');
  const timeEl = cardEl.querySelector('.time');
  const dotEl = cardEl.querySelector('.status-dot');

  // battery UI elements
  const batteryValueEl = cardEl.querySelector('.battery-value');
  const batteryDotEl = cardEl.querySelector('.battery-dot');

  // GSM UI element
  const gsmValueEl = cardEl.querySelector('.gsm-value');

  // UI state
  if (showSpinner) spinner.style.display = 'inline-block';
  errorWrap.style.display = 'none';
  valueEl.classList.add('skeleton', 'muted');
  valueEl.textContent = ' ';

  // mark battery as loading (preserve previous if exists)
  if (batteryValueEl) {
    batteryValueEl.classList.add('muted');
    batteryValueEl.textContent = device._lastBattery != null ? device._lastBattery : '—';
  }
  if (batteryDotEl) {
    batteryDotEl.classList.remove('status-green','status-orange','status-red');
    batteryDotEl.classList.add('status-red');
  }

  // mark GSM as loading (preserve previous if exists)
  if (gsmValueEl) {
    gsmValueEl.classList.add('muted');
    gsmValueEl.textContent = device._lastGsm != null ? (String(device._lastGsm) + ( /^\d+$/.test(String(device._lastGsm)) ? '%' : '' )) : '—';
  }

  try {
    const url = `/api/tank?terminalId=${encodeURIComponent(device.id)}`;
    const resp = await fetch(url, { cache: 'no-store' });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || err.message || resp.statusText || `HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const rawValue = data.value;
    const timestamp = data.timestamp;

    // Validate timestamp
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) {
      throw new Error('No Connection.');
    }

    // Format timestamp
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
    const timeFormatted = `${dd}-${mm}-${yyyy} ${timeStr}`;

    // Normalise and display value
    const numeric = parsePercent(rawValue);
    const display = (numeric == null || isNaN(numeric)) ? String(rawValue || '—') : (Math.round(numeric * 100) / 100).toString();

    // Detect change for pulse animation
    const prev = device._lastValue;
    if (prev !== undefined && String(prev) !== String(display)) {
      valueEl.classList.remove('skeleton', 'muted');
      valueEl.textContent = display;
      // force reflow then add pulse
      void valueEl.offsetWidth;
      valueEl.classList.add('pulse');
      valueEl.addEventListener('animationend', () => valueEl.classList.remove('pulse'), { once: true });
    } else {
      valueEl.classList.remove('skeleton', 'muted');
      valueEl.textContent = display;
    }

    device._lastValue = display;
    timeEl.textContent = timeFormatted;

    setStatusColor(numeric, valueEl, dotEl, device);

    // hide error if any
    errorWrap.style.display = 'none';
  } catch (err) {
    const message = (err && err.message && /no connection|network|failed to fetch|timeout/i.test(err.message))
      ? 'No Connection.'
      : (err && err.message) || 'Unknown error';

    errorText.textContent = message;
    errorWrap.style.display = 'flex';
    retryBtn.onclick = () => fetchAndUpdate(device, cardEl, true);

    // keep previous value but mark as muted
    const prev = device._lastValue;
    if (prev != null) {
      valueEl.textContent = prev;
      valueEl.classList.add('muted');
    } else {
      valueEl.textContent = '—';
      valueEl.classList.add('muted');
    }

    // ensure dot is red on error
    dotEl.classList.remove('status-green', 'status-orange', 'status-red');
    dotEl.classList.add('status-red');
  } finally {
    if (showSpinner) spinner.style.display = 'none';
    device._initialLoaded = true;
  }

  // Fetch battery (BATT variable) and update battery UI — non-fatal if it fails
  try {
    const battUrl = `/api/tank?terminalId=${encodeURIComponent(device.id)}&variable=BATT`;
    const respB = await fetch(battUrl, { cache: 'no-store' });
    if (!respB.ok) {
      // keep previous displayed battery, mark muted
      throw new Error('Battery read failed');
    }
    const jb = await respB.json();
    // server may include a computed percent
    let battPct = (jb && (jb.percent !== undefined && jb.percent !== null)) ? Number(jb.percent) : null;
    const rawBatt = jb && jb.value ? jb.value : null;

    // if server didn't send percent, try to compute client-side from raw BATT value
    if (battPct == null) {
      const v = parseVoltage(rawBatt);
      battPct = computeBatteryPercent(v);
    }

    // Update battery UI
    if (batteryValueEl) {
      batteryValueEl.classList.remove('muted');
      batteryValueEl.textContent = (battPct == null || isNaN(battPct)) ? (String(rawBatt || '—')) : String(battPct);
    }
    if (batteryDotEl) setBatteryColor(battPct, batteryDotEl);

    // cache last battery
    device._lastBattery = (battPct == null || isNaN(battPct)) ? (rawBatt != null ? String(rawBatt) : null) : String(battPct);
  } catch (e) {
    // keep previous battery if present, otherwise show muted dash
    try {
      const prevB = device._lastBattery;
      if (prevB != null) {
        if (batteryValueEl) {
          batteryValueEl.textContent = prevB;
          batteryValueEl.classList.add('muted');
        }
      } else {
        if (batteryValueEl) {
          batteryValueEl.textContent = '—';
          batteryValueEl.classList.add('muted');
        }
      }
      if (batteryDotEl) {
        batteryDotEl.classList.remove('status-green','status-orange','status-red');
        batteryDotEl.classList.add('status-red');
      }
    } catch (ignored) { /* ignore */ }
  }

  // NEW: Fetch RSSI (GSM signal) and update GSM UI — non-fatal if it fails
  try {
    const rssiUrl = `/api/tank?terminalId=${encodeURIComponent(device.id)}&variable=RSSI`;
    const respR = await fetch(rssiUrl, { cache: 'no-store' });
    if (!respR.ok) {
      throw new Error('RSSI read failed');
    }
    const jr = await respR.json();
    const rawRssi = jr && (jr.value !== undefined && jr.value !== null) ? jr.value : null;

    const gsmPct = computeRssiPercent(rawRssi); // null if unknown/invalid
    // Update GSM UI: show percent when available, otherwise "N/A"
    if (gsmValueEl) {
      if (gsmPct == null || isNaN(gsmPct)) {
        gsmValueEl.textContent = 'N/A';
        gsmValueEl.classList.add('muted');
      } else {
        gsmValueEl.textContent = String(gsmPct) + '%';
        gsmValueEl.classList.remove('muted');
      }
    }

    // cache last GSM display (store percent number if available else null)
    device._lastGsm = (gsmPct == null || isNaN(gsmPct)) ? (rawRssi != null ? String(rawRssi) : null) : String(gsmPct);
  } catch (err) {
    // On error, preserve previous gsm if available; otherwise show muted dash or 'N/A'
    try {
      if (gsmValueEl) {
        if (device._lastGsm != null) {
          // if last stored is numeric percent string, append '%'
          const last = String(device._lastGsm);
          gsmValueEl.textContent = /^\d+$/.test(last) ? (last + '%') : last;
          gsmValueEl.classList.add('muted');
        } else {
          gsmValueEl.textContent = 'N/A';
          gsmValueEl.classList.add('muted');
        }
      }
    } catch (ignored) { /* ignore */ }
  }
}

// Fetch for every device/card (silent updates)
function refreshAll() {
  const cardEls = Array.from(document.querySelectorAll('.tank-card'));
  cardEls.forEach(cardEl => {
    const terminalId = cardEl.dataset.terminal;
    const device = devices.find(d => d.id === terminalId);
    if (device) fetchAndUpdate(device, cardEl, false);
  });
}

// Attach refresh and keyboard reorder handlers to cards
function attachCardControls() {
  const cardEls = Array.from(document.querySelectorAll('.tank-card'));
  cardEls.forEach(cardEl => {
    const terminalId = cardEl.dataset.terminal;
    const device = devices.find(d => d.id === terminalId);
    // refresh button
    const refreshBtn = cardEl.querySelector('.refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        fetchAndUpdate(device, cardEl, true);
      });
    }

    // history button
    const historyBtn = cardEl.querySelector('.history-btn');
    if (historyBtn) {
      historyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tid = cardEl.dataset.terminal;
        const dev = devices.find(d => d.id === tid) || {};
        showHistoryModal(tid, dev.name);
      });
    }

    // info/view button (new) - opens read-only professional modal
    const infoBtn = cardEl.querySelector('.info-btn');
    if (infoBtn) {
      infoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tid = cardEl.dataset.terminal;
        showTankInfoViewModal(tid);
      });
    }

    // map button — ONLY open the interactive modal (do not auto-open external map link)
    const mapBtn = cardEl.querySelector('.map-btn');
    if (mapBtn) {
      mapBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tid = cardEl.dataset.terminal;
        const dev = devices.find(d => d.id === tid) || {};
        // Do NOT auto-open external location link. Only show the interactive modal.
        showMapModal(tid, dev);
      });
    }
  });

  enableKeyboardReorder();
}

// Keyboard-only reordering: click/select a card, then ArrowUp / ArrowDown to move
function selectCard(cardEl) {
  // deselect current if different
  if (selectedCard && selectedCard !== cardEl) {
    selectedCard.classList.remove('selected');
  }
  if (selectedCard === cardEl) {
    // toggle off
    selectedCard.classList.remove('selected');
    selectedCard = null;
    return;
  }
  selectedCard = cardEl;
  selectedCard.classList.add('selected');
  selectedCard.focus();
}

// Move the selected card up or down in the DOM and persist
function moveSelected(direction) {
  if (!selectedCard) return;
  if (direction === 'up') {
    const prev = selectedCard.previousElementSibling;
    if (prev && prev.classList.contains('tank-card')) {
      selectedCard.parentNode.insertBefore(selectedCard, prev);
      reorderDevicesFromDOM();
      persistDeviceOrder();
      selectedCard.focus();
    }
  } else if (direction === 'down') {
    const next = selectedCard.nextElementSibling;
    if (next && next.classList.contains('tank-card')) {
      selectedCard.parentNode.insertBefore(next, selectedCard);
      reorderDevicesFromDOM();
      persistDeviceOrder();
      selectedCard.focus();
    }
  }
}

function enableKeyboardReorder() {
  // Global key handler when a card is selected
  document.addEventListener('keydown', (e) => {
    if (!selectedCard) return;

    // Do not intercept if the user is typing in any input/textarea/contenteditable
    const active = document.activeElement;
    const editing =
      active &&
      (active.tagName === 'INPUT' ||
       active.tagName === 'TEXTAREA' ||
       active.isContentEditable ||
       active.classList.contains('title-input'));
    if (editing) return;

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelected('up');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelected('down');
    } else if (e.key === 'Escape') {
      // cancel selection
      selectedCard.classList.remove('selected');
      selectedCard = null;
    } else if (e.key.toLowerCase() === 'r') {
      // quick refresh when selected
      const terminalId = selectedCard.dataset.terminal;
      const device = devices.find(d => d.id === terminalId);
      if (device) fetchAndUpdate(device, selectedCard, true);
    }
  });

  // clicking outside any card deselects
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.tank-card') && selectedCard) {
      selectedCard.classList.remove('selected');
      selectedCard = null;
    }
  });
}

function reorderDevicesFromDOM() {
  const ids = Array.from(document.querySelectorAll('.tank-card')).map(el => el.dataset.terminal);
  const map = new Map(devices.map(d => [d.id, d]));
  devices = ids.map(id => map.get(id)).filter(Boolean);
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)); } catch (e) { /* ignore */ }
}

/* ---------------------------
   History / Chart functionality
   --------------------------- */

async function fetchHistory(terminalId, limit = 2000) {
  const url = `/api/history?terminalId=${encodeURIComponent(terminalId)}&limit=${encodeURIComponent(limit)}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || resp.statusText || 'Failed to load history');
  }
  return resp.json();
}

let _activeChart = null;

function computeStats(values) {
  const nums = values.filter(v => typeof v === 'number' && !isNaN(v));
  if (nums.length === 0) return { min: null, max: null, avg: null, count: 0 };
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const avg = nums.reduce((s, n) => s + n, 0) / nums.length;
  return { min, max, avg, count: nums.length };
}

function sanitizeFilename(name) {
  if (!name) return '';
  return name.replace(/[\/\\?%*:|"<>]/g, '-').trim();
}

// CSV download now includes only local timestamp + tank_level (and optional title line)
function downloadCSV(filename, rows, title) {
  const header = ['timestamp_local', 'tank_level'];
  const lines = [];
  if (title) {
    lines.push(`"${String(title).replace(/"/g, '""')}"`);
    lines.push(''); // blank line for readability
  }
  lines.push(header.join(','));
  for (const r of rows) {
    const local = (r.timestamp ? new Date(r.timestamp).toLocaleString() : '');
    const val = (r.tank_level === null || r.tank_level === undefined) ? '' : String(r.tank_level);
    const safe = [`"${local.replace(/"/g,'""')}"`, val].join(',');
    lines.push(safe);
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportPdfFromChart(chart, filename = 'chart.pdf', title = '') {
  try {
    // jsPDF import (UMD)
    const { jsPDF } = window.jspdf || {};
    if (!jsPDF) throw new Error('jsPDF not available');

    // Chart image as dataURL (png)
    const imgData = chart.toBase64Image();

    // Choose landscape and size that fits
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    // compute available width/height in pts
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();

    // create an Image to read its dimensions and preserve aspect ratio
    const img = new Image();
    img.src = imgData;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });

    const imgRatio = img.width / img.height;
    // reserve vertical space for title if present
    const titleHeight = title ? 34 : 0;
    let w = pageWidth - 40; // leave some margin
    let h = (pageHeight - 40 - titleHeight) ? (w / imgRatio) : (pageHeight - 40 - titleHeight);
    if (h > pageHeight - 40 - titleHeight) {
      h = pageHeight - 40 - titleHeight;
      w = h * imgRatio;
    }
    const x = (pageWidth - w) / 2;
    const y = (20 + titleHeight); // start image after top margin plus title area

    // Draw title if provided
    if (title) {
      pdf.setFontSize(18);
      pdf.setTextColor(20, 20, 20);
      pdf.setFont(undefined, 'bold');
      // center title
      const textWidth = pdf.getTextWidth(title);
      const titleX = Math.max(20, (pageWidth - textWidth) / 2);
      const titleY = 26;
      pdf.text(String(title), titleX, titleY);
      // reset font
      pdf.setFont(undefined, 'normal');
    }

    pdf.addImage(imgData, 'PNG', x, y, w, h);
    pdf.save(filename);
  } catch (err) {
    throw new Error('PDF export failed: ' + (err && err.message));
  }
}

/* Helper: fetch rows (with a given limit) then optionally filter by startMs/endMs.
   Returns filtered rows (each row: {timestamp: ISO|null, tank_level: number|null}) */
async function fetchAndFilterRows(terminalId, { limit = 2000, startMs = null, endMs = null } = {}) {
  const data = await fetchHistory(terminalId, limit);
  const rows = (data && data.rows) ? data.rows.slice() : [];
  // If no start/end provided, return rows as-is
  if (startMs == null && endMs == null) return rows;
  const filtered = rows.filter(r => {
    if (!r || !r.timestamp) return false;
    const t = Date.parse(r.timestamp);
    if (isNaN(t)) return false;
    if (startMs != null && t < startMs) return false;
    if (endMs != null && t > endMs) return false;
    return true;
  });
  return filtered;
}

/* Utility: format ms -> datetime-local value "YYYY-MM-DDTHH:MM" (local time) */
function toDatetimeLocalValue(ms) {
  const d = new Date(ms);
  const YYYY = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${YYYY}-${MM}-${DD}T${hh}:${mm}`;
}

function showHistoryModal(terminalId, terminalName) {
  // modal DOM
  const modal = document.createElement('div');
  modal.className = 'history-modal';
  modal.innerHTML = `
    <div class="history-panel" role="dialog" aria-modal="true" aria-label="History for ${escapeHtml(terminalName || terminalId)}">
      <div class="history-actions">
        <div style="display:flex;align-items:center;gap:12px;">
          <strong>${escapeHtml(terminalName || terminalId)}</strong>
          <div class="history-range">
            <!-- start/end datetime selectors -->
            <input type="datetime-local" class="range-start graph-title-input" aria-label="Start time" />
            <span style="color:var(--muted); font-size:13px;">to</span>
            <input type="datetime-local" class="range-end graph-title-input" aria-label="End time" />
            <button class="btn apply-range">Apply</button>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <input class="graph-title-input" type="text" placeholder="Graph Title" aria-label="Graph Title" />
          <div class="history-controls">
            <button class="btn stats-btn" type="button" title="Stats">Stats</button>
            <button class="btn export-btn" type="button" title="Export">Export</button>
            <button class="btn reset-btn" type="button" title="Reset">Reset</button>
            <button class="history-close" type="button">Close</button>
          </div>
        </div>
      </div>
      <div style="position:relative;height:520px;">
        <canvas id="history-chart" width="1200" height="480" style="width:100%;height:100%;cursor:grab;"></canvas>
      </div>
      <div id="history-msg" class="history-msg"></div>
    </div>
  `;
  document.body.appendChild(modal);

  // add page dimming state so everything behind fades to black
  document.body.classList.add('modal-open');

  const closeBtn = modal.querySelector('.history-close');
  const msgEl = modal.querySelector('#history-msg');
  const chartCanvas = modal.querySelector('#history-chart');
  const statsBtn = modal.querySelector('.stats-btn');
  const exportBtn = modal.querySelector('.export-btn');
  const resetBtn = modal.querySelector('.reset-btn');
  const titleInput = modal.querySelector('.graph-title-input[placeholder*="Graph Title"]');
  const startInput = modal.querySelector('.range-start');
  const endInput = modal.querySelector('.range-end');
  const applyBtn = modal.querySelector('.apply-range');

  let currentRows = []; // keep loaded rows for exports/stats
  let statsDropdown = null;
  let exportDropdown = null;

  function removeModal() {
    if (_activeChart) { _activeChart.destroy(); _activeChart = null; }
    if (statsDropdown) { statsDropdown.remove(); statsDropdown = null; }
    if (exportDropdown) { exportDropdown.remove(); exportDropdown = null; }
    modal.remove();
    document.body.classList.remove('modal-open');
  }

  closeBtn.addEventListener('click', () => {
    removeModal();
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) removeModal();
  });

  // Helper to load & render a given start/end range (ms). If startMs/endMs null -> loads default last N rows.
  async function loadRange({ startMs = null, endMs = null, limit = 500 } = {}) {
    try {
      msgEl.textContent = 'Loading...';
      if (_activeChart) { _activeChart.clear(); }
      // If start/end provided, request large limit so client filtering is reliable
      const fetchLimit = (startMs != null || endMs != null) ? 50000 : limit;
      const rows = await fetchAndFilterRows(terminalId, { limit: fetchLimit, startMs, endMs });
      currentRows = rows;
      if (!rows || rows.length === 0) {
        msgEl.textContent = 'No history data available for that range.';
        if (_activeChart) { _activeChart.destroy(); _activeChart = null; }
        return;
      }
      msgEl.textContent = '';

      // Build numeric-millisecond points (x: ms, y: value)
      const points = currentRows.map(r => {
        const ms = r && r.timestamp ? Date.parse(r.timestamp) : NaN;
        return { x: isNaN(ms) ? null : ms, y: (r.tank_level === null ? NaN : Number(r.tank_level)) };
      }).filter(pt => pt.x !== null && !isNaN(pt.x));

      // Create chart from numeric points
      createChart(points, chartCanvas, titleInput ? String(titleInput.value || '') : '');

      // auto-populate start/end inputs with actual range (optional)
      const firstTs = points.length ? points[0].x : null;
      const lastTs = points.length ? points[points.length - 1].x : null;
      if (firstTs && lastTs) {
        // set inputs to reflect actual loaded range
        if (startInput && endInput) {
          startInput.value = toDatetimeLocalValue(firstTs);
          endInput.value = toDatetimeLocalValue(lastTs);
        }
      }
    } catch (err) {
      console.error('loadRange error', err);
      msgEl.textContent = 'Failed to load history: ' + (err && err.message);
    }
  }

  // Apply range handler: read datetime-local inputs, convert to ms, and load
  applyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const startVal = startInput.value; // e.g. "2026-01-06T11:00"
    const endVal = endInput.value;
    if (!startVal && !endVal) {
      msgEl.textContent = 'Please set a start and/or end time to filter.';
      return;
    }
    const startMs = startVal ? new Date(startVal).getTime() : null;
    const endMs = endVal ? new Date(endVal).getTime() : null;
    if (startMs != null && isNaN(startMs)) {
      msgEl.textContent = 'Invalid start time.';
      return;
    }
    if (endMs != null && isNaN(endMs)) {
      msgEl.textContent = 'Invalid end time.';
      return;
    }
    if (startMs != null && endMs != null && startMs > endMs) {
      msgEl.textContent = 'Start time must be before end time.';
      return;
    }
    await loadRange({ startMs, endMs });
  });

  // Stats button handler
  statsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (statsDropdown) { statsDropdown.remove(); statsDropdown = null; return; }

    const pos = statsBtn.getBoundingClientRect();
    statsDropdown = document.createElement('div');
    statsDropdown.className = 'dropdown modal-dropdown';
    statsDropdown.style.top = (pos.bottom + 8) + 'px';
    statsDropdown.style.left = (pos.left) + 'px';

    const stats = computeStats(currentRows.map(r => (r.tank_level === null ? NaN : Number(r.tank_level))));
    const fmt = v => (v == null ? '—' : (Math.round(v * 100) / 100).toString());

    statsDropdown.innerHTML = `
      <div class="dropdown-row"><div>Count</div><div>${stats.count}</div></div>
      <div class="dropdown-row"><div>Min</div><div>${fmt(stats.min)}</div></div>
      <div class="dropdown-row"><div>Max</div><div>${fmt(stats.max)}</div></div>
      <div class="dropdown-row"><div>Avg</div><div>${fmt(stats.avg)}</div></div>
    `;
    document.body.appendChild(statsDropdown);

    const closer = (ev) => {
      if (!statsDropdown) return;
      if (!ev.target.closest('.dropdown') && ev.target !== statsBtn) {
        statsDropdown.remove(); statsDropdown = null;
        document.removeEventListener('click', closer);
      }
    };
    document.addEventListener('click', closer);
  });

  // Export button handler — dropdown remains interactive while page is dimmed
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (exportDropdown) { exportDropdown.remove(); exportDropdown = null; return; }

    const pos = exportBtn.getBoundingClientRect();
    exportDropdown = document.createElement('div');
    exportDropdown.className = 'dropdown modal-dropdown';
    exportDropdown.style.top = (pos.bottom + 8) + 'px';
    exportDropdown.style.left = (pos.left) + 'px';
    exportDropdown.innerHTML = `
      <div class="dropdown-row"><div><button class="btn export-csv">Export CSV</button></div></div>
      <div class="dropdown-row"><div><button class="btn export-pdf">Export PDF</button></div></div>
    `;
    document.body.appendChild(exportDropdown);

    const readTitle = () => {
      const t = (titleInput && titleInput.value) ? String(titleInput.value).trim() : '';
      return t || '';
    };

    exportDropdown.querySelector('.export-csv').addEventListener('click', () => {
      try {
        const title = readTitle();
        // Do NOT use terminalId in fallback filename to avoid leaking IDs via downloads.
        const safe = sanitizeFilename(title) || sanitizeFilename(terminalName) || 'tank_history';
        const filename = `${safe}.csv`;
        // currentRows already contains filtered rows (or default last N rows)
        downloadCSV(filename, currentRows, title);
      } catch (err) {
        alert('CSV export failed: ' + (err && err.message));
      } finally {
        if (exportDropdown) { exportDropdown.remove(); exportDropdown = null; }
      }
    });

    exportDropdown.querySelector('.export-pdf').addEventListener('click', async () => {
      try {
        if (!_activeChart) throw new Error('No chart available');
        const title = readTitle();
        // Do NOT use terminalId in fallback filename to avoid leaking IDs via downloads.
        const safe = sanitizeFilename(title) || sanitizeFilename(terminalName) || 'tank_history';
        const filename = `${safe}.pdf`;
        await exportPdfFromChart(_activeChart, filename, title);
      } catch (err) {
        alert('PDF export failed: ' + (err && err.message));
      } finally {
        if (exportDropdown) { exportDropdown.remove(); exportDropdown = null; }
      }
    });

    const closer = (ev) => {
      if (!exportDropdown) return;
      if (!ev.target.closest('.dropdown') && ev.target !== exportBtn) {
        exportDropdown.remove(); exportDropdown = null;
        document.removeEventListener('click', closer);
      }
    };
    document.addEventListener('click', closer);
  });

  // Reset button handler - restores chart to original position (full loaded data range)
  resetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    try {
      if (!_activeChart) return;
      // If we have currentRows, use their full range as original
      if (currentRows && currentRows.length > 0) {
        const firstTs = Date.parse(currentRows[0].timestamp);
        const lastTs = Date.parse(currentRows[currentRows.length - 1].timestamp);
        if (!isNaN(firstTs) && !isNaN(lastTs)) {
          // Clear plugin-managed zoom state if possible
          if (typeof _activeChart.resetZoom === 'function') {
            try { _activeChart.resetZoom(); } catch (e) { /* ignore */ }
          }
          // Ensure the visible x range matches the full data range
          _activeChart.options.scales.x.min = firstTs;
          _activeChart.options.scales.x.max = lastTs;
          _activeChart.update();
          return;
        }
      }
      // Fallback: try plugin resetZoom or clear min/max
      if (typeof _activeChart.resetZoom === 'function') {
        _activeChart.resetZoom();
      } else {
        delete _activeChart.options.scales.x.min;
        delete _activeChart.options.scales.x.max;
        _activeChart.update();
      }
    } catch (err) {
      console.warn('Reset failed', err && err.message);
    }
  });

  /* ---------------------------
     Chart creation + zoom/pan
     --------------------------- */

  // NOTE: createChart accepts a points array of {x: msNumber, y: numeric} and the chartCanvas element.
  // It will set _activeChart.
  function createChart(points, canvasEl, title = '') {
    try {
      if (_activeChart) {
        try { _activeChart.destroy(); } catch(e) { /* ignore */ }
        _activeChart = null;
      }

      const ctx = canvasEl.getContext('2d');

      // Defensive: ensure points sorted ascending by x
      points.sort((a,b) => (a.x || 0) - (b.x || 0));

      // Use the numeric ms timestamps directly as x values
      const cfg = {
        type: 'line',
        data: {
          datasets: [{
            label: 'Tank level (%)',
            data: points.map(p => ({ x: p.x, y: (p.y === null ? NaN : p.y) })),
            parsing: false,
            fill: true,
            // purple-ish blue theme:
            borderColor: 'rgba(88,86,214,0.95)',
            backgroundColor: 'rgba(88,86,214,0.12)',
            pointBackgroundColor: 'rgba(88,86,214,0.95)',
            pointBorderColor: '#ffffff',
            pointRadius: Math.min(3, Math.round(1200 / Math.max(1, Math.max(1, points.length) * 0.5))),
            pointHoverRadius: 6,
            spanGaps: false,
            cubicInterpolationMode: 'monotone'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              type: 'time',
              time: {
                // Chart.js / Luxon adapter will accept numeric timestamps (ms)
                tooltipFormat: 'DD MMM yyyy, t',
                displayFormats: {
                  millisecond: 'HH:mm:ss',
                  second: 'HH:mm:ss',
                  minute: 'HH:mm',
                  hour: 'dd LLL HH:mm',
                  day: 'dd LLL',
                  month: 'MMM yyyy',
                  year: 'yyyy'
                }
              },
              ticks: { autoSkip: true, maxTicksLimit: 12 },
            },
            y: {
              display: true,
              beginAtZero: true,
              suggestedMax: 100,
              title: { display: true, text: '%' }
            }
          },
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              mode: 'index',
              callbacks: {
                title: function(tooltipItems) {
                  if (!tooltipItems || tooltipItems.length === 0) return '';
                  const item = tooltipItems[0];
                  const rawX = (item.parsed && item.parsed.x !== undefined) ? item.parsed.x : item.label;

                  // rawX is expected to be a millisecond number
                  const DateTime = (window.luxon && window.luxon.DateTime) ? window.luxon.DateTime : null;
                  if (DateTime) {
                    let dt = null;
                    if (typeof rawX === 'number') dt = DateTime.fromMillis(rawX);
                    else dt = DateTime.fromISO(String(rawX));
                    if (dt && dt.isValid) {
                      return dt.toFormat('dd LLL yyyy') + ' ' + dt.toFormat('hh:mm a');
                    }
                  }

                  const parsedMs = (typeof rawX === 'number') ? rawX : Date.parse(String(rawX));
                  if (!isNaN(parsedMs)) {
                    const d = new Date(parsedMs);
                    const dd = String(d.getDate()).padStart(2, '0');
                    const monthShort = d.toLocaleString(undefined, { month: 'short' });
                    const yyyy = d.getFullYear();
                    const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
                    return `${dd} ${monthShort} ${yyyy} ${timeStr}`;
                  }

                  return String(rawX);
                }
              }
            },
            zoom: {
              zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
              pan: { enabled: false }
            }
          },
        }
      };

      _activeChart = new Chart(ctx, cfg);

      // Set initial visible range to full dataset
      const firstTs = points.length ? points[0].x : null;
      const lastTs = points.length ? points[points.length - 1].x : null;
      if (!isNaN(firstTs) && !isNaN(lastTs)) {
        _activeChart.options.scales.x.min = firstTs;
        _activeChart.options.scales.x.max = lastTs;
        _activeChart.update('none');
      }

      // Implement custom inverted drag panning (hold left mouse button and drag)
      let isDragging = false;
      let lastX = null;

      function toMillis(v) {
        if (v == null) return NaN;
        if (typeof v === 'number' && !isNaN(v)) return v;
        if (v instanceof Date) return v.getTime();
        const parsed = Date.parse(String(v));
        return isNaN(parsed) ? NaN : parsed;
      }

      function getXValueForPixelSafe(pixelX) {
        try {
          const raw = _activeChart.scales.x.getValueForPixel(pixelX);
          // getValueForPixel may return a Date or number depending on adapter; normalize to ms
          if (raw instanceof Date) return raw.getTime();
          if (typeof raw === 'number') return raw;
          // Try to parse to ms
          const parsed = Date.parse(String(raw));
          if (!isNaN(parsed)) return parsed;
          // fallback to linear interpolation inside chart area
          const area = _activeChart.chartArea;
          const left = area.left;
          const right = area.right;
          const minRaw = _activeChart.scales.x.min ?? _activeChart.scales.x.getValueForPixel(left);
          const maxRaw = _activeChart.scales.x.max ?? _activeChart.scales.x.getValueForPixel(right);
          const minMs = toMillis(minRaw);
          const maxMs = toMillis(maxRaw);
          const ratio = (pixelX - left) / (right - left);
          return minMs + (ratio * (maxMs - minMs));
        } catch (e) {
          // In case of any chart internals failing, approximate based on bounding box
          try {
            const area = _activeChart.chartArea || { left: 0, right: canvasEl.width || canvasEl.clientWidth };
            const left = area.left || 0;
            const right = area.right || (canvasEl.width || canvasEl.clientWidth);
            const minRaw = _activeChart.options.scales.x.min;
            const maxRaw = _activeChart.options.scales.x.max;
            const minMs = toMillis(minRaw);
            const maxMs = toMillis(maxRaw);
            const ratio = (pixelX - left) / (right - left);
            return minMs + (ratio * (maxMs - minMs));
          } catch (ee) {
            console.error('getXValueForPixelSafe fallback failed', ee);
            return NaN;
          }
        }
      }

      function onPointerDown(e) {
        if (e.button !== 0) return; // left button only
        isDragging = true;
        canvasEl.style.cursor = 'grabbing';
        lastX = e.clientX;
        e.preventDefault();
      }

      async function onPointerMove(e) {
        if (!isDragging || !_activeChart) return;
        const rect = canvasEl.getBoundingClientRect();
        const lastPixel = lastX - rect.left;
        const curPixel = e.clientX - rect.left;
        const lastTime = getXValueForPixelSafe(lastPixel);
        const curTime = getXValueForPixelSafe(curPixel);

        if (isNaN(lastTime) || isNaN(curTime)) return;

        const shift = lastTime - curTime;

        const area = _activeChart.chartArea;
        const left = area.left;
        const right = area.right;
        const oldMinRaw = _activeChart.scales.x.min ?? _activeChart.scales.x.getValueForPixel(left);
        const oldMaxRaw = _activeChart.scales.x.max ?? _activeChart.scales.x.getValueForPixel(right);
        const oldMin = toMillis(oldMinRaw);
        const oldMax = toMillis(oldMaxRaw);
        if (isNaN(oldMin) || isNaN(oldMax)) return;

        const newMin = oldMin + shift;
        const newMax = oldMax + shift;

        _activeChart.options.scales.x.min = newMin;
        _activeChart.options.scales.x.max = newMax;
        _activeChart.update('none');

        lastX = e.clientX;
        e.preventDefault();
      }

      function onPointerUp() {
        if (!isDragging) return;
        isDragging = false;
        canvasEl.style.cursor = 'grab';
        lastX = null;
      }

      canvasEl.addEventListener('mousedown', onPointerDown);
      window.addEventListener('mousemove', onPointerMove);
      window.addEventListener('mouseup', onPointerUp);
      canvasEl.addEventListener('mouseleave', onPointerUp);

      const origDestroy = _activeChart.destroy;
      _activeChart.destroy = function() {
        try {
          canvasEl.removeEventListener('mousedown', onPointerDown);
          window.removeEventListener('mousemove', onPointerMove);
          window.removeEventListener('mouseup', onPointerUp);
          canvasEl.removeEventListener('mouseleave', onPointerUp);
        } catch (e) { /* ignore */ }
        return origDestroy.apply(this, arguments);
      };

      return _activeChart;
    } catch (err) {
      console.error('createChart error', err);
      throw err;
    }
  }
  // On open: prefill start/end to "last 48 hours" (NOW and NOW - 48 hours), then auto-load that range.
  try {
    const nowMs = Date.now();
    const fortyEightHoursAgoMs = nowMs - (48 * 60 * 60 * 1000);
    if (startInput && endInput) {
      startInput.value = toDatetimeLocalValue(fortyEightHoursAgoMs);
      endInput.value = toDatetimeLocalValue(nowMs);
    }
    // Immediately load last 48 hours
    loadRange({ startMs: fortyEightHoursAgoMs, endMs: nowMs });
  } catch (e) {
    // fallback: load default last 500 rows
    loadRange({ limit: 500 });
  }
}

/* ---------------------------
   NEW: Device Information modal + API helpers (editor/upsert)
   --------------------------- */

// Fetch tank info for a specific terminal (returns object or throws)
async function fetchTankInfo(terminalId) {
  const url = `/api/tank-info?terminalId=${encodeURIComponent(terminalId)}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) {
    const j = await resp.json().catch(() => ({}));
    throw new Error(j.error || resp.statusText || `HTTP ${resp}`);
  }
  return resp.json();
}

// Save (upsert) tank info payload: { terminalId, building_name, address, afg_bld_code, client_bld_code, lpg_tank_capacity, lpg_tank_details, lpg_tank_type, lpg_installation_type }
async function saveTankInfo(payload) {
  const resp = await fetch('/api/tank-info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const j = await resp.json().catch(() => ({}));
    throw new Error(j.error || resp.statusText || `HTTP ${resp}`);
  }
  return resp.json();
}

function buildDeviceInfoModalHtml(uniqueId) {
  // fields:
  // building_name, address, afg_bld_code, client_bld_code, lpg_tank_capacity, lpg_tank_details
  // dropdowns: lpg_tank_type, lpg_installation_type
  // add notes textarea at bottom-left
  // NEW: LPG Minimum Level and LPG Maximum Level inputs added
  // NEW: Alarm E-mail input added (now supports multiple comma-separated addresses)
  return `
    <div class="history-panel" role="dialog" aria-modal="true" aria-label="Device Information">
      <div class="history-actions">
        <div style="display:flex;align-items:center;gap:12px;">
          <strong>Device Information</strong>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="history-controls">
            <button class="btn device-info-save" type="button">Save</button>
            <button class="history-close" type="button">Close</button>
          </div>
        </div>
      </div>

      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        <div style="flex:1 1 320px;min-width:280px;">
          <label style="display:block;margin-bottom:6px;color:var(--muted);font-size:13px;">Select Device (Serial Number)</label>
          <select id="device-info-select-${uniqueId}" class="graph-title-input" style="width:100%;"></select>
          <div style="margin-top:8px;color:var(--muted);font-size:12px;">Or enter Serial Number manually:</div>
          <input id="device-info-terminal-${uniqueId}" class="graph-title-input" placeholder="Serial Number" style="margin-top:6px;" />

          <!-- NOTES textarea placed in bottom-left -->
          <label style="display:block;margin-top:12px;margin-bottom:6px;color:var(--muted);font-size:13px;">Notes</label>
          <textarea id="device-info-notes-${uniqueId}" class="graph-title-input" placeholder="Notes about this device" style="min-height:90px; width:100%; resize:vertical; padding:8px;"></textarea>
        </div>

        <div style="flex:1 1 320px;min-width:280px;">
          <label style="display:block;margin-bottom:6px;color:var(--muted);font-size:13px;">Building / Company name</label>
          <input id="device-info-building-${uniqueId}" class="graph-title-input" placeholder="Building / Company name" />

          <label style="display:block;margin-top:10px;margin-bottom:6px;color:var(--muted);font-size:13px;">Address</label>
          <input id="device-info-address-${uniqueId}" class="graph-title-input" placeholder="Address" />

          <label style="display:block;margin-top:10px;margin-bottom:6px;color:var(--muted);font-size:13px;">AFG Bld Code</label>
          <input id="device-info-afg-${uniqueId}" class="graph-title-input" placeholder="AFG Bld Code" />

          <label style="display:block;margin-top:10px;margin-bottom:6px;color:var(--muted);font-size:13px;">Client Bld Code</label>
          <input id="device-info-client-${uniqueId}" class="graph-title-input" placeholder="Client Bld Code" />
        </div>

        <div style="flex:1 1 320px;min-width:280px;">
          <label style="display:block;margin-bottom:6px;color:var(--muted);font-size:13px;">LPG Tank capacity</label>
          <input id="device-info-capacity-${uniqueId}" class="graph-title-input" placeholder="LPG Tank capacity" />

          <label style="display:block;margin-top:10px;margin-bottom:6px;color:var(--muted);font-size:13px;">LPG Tank details</label>
          <input id="device-info-details-${uniqueId}" class="graph-title-input" placeholder="LPG Tank details" />

          <label style="display:block;margin-top:10px;margin-bottom:6px;color:var(--muted);font-size:13px;">LPG Tank type</label>
          <select id="device-info-type-${uniqueId}" class="graph-title-input">
            <option value="">— select type —</option>
            <option value="Spherical">Spherical</option>
            <option value="Cylindrical horizontal">Cylindrical horizontal</option>
            <option value="Cylindrical vertical">Cylindrical vertical</option>
          </select>

          <label style="display:block;margin-top:10px;margin-bottom:6px;color:var(--muted);font-size:13px;">LPG Tank installation type</label>
          <select id="device-info-install-${uniqueId}" class="graph-title-input">
            <option value="">— select installation —</option>
            <option value="A/G">A/G</option>
            <option value="B/G">B/G</option>
          </select>

          <!-- NEW: LPG thresholds -->
          <label style="display:block;margin-top:10px;margin-bottom:6px;color:var(--muted);font-size:13px;">LPG Minimum Level (%)</label>
          <input id="device-info-min-${uniqueId}" class="graph-title-input" placeholder="Min % (0-100)" />

          <label style="display:block;margin-top:10px;margin-bottom:6px;color:var(--muted);font-size:13px;">LPG Maximum Level (%)</label>
          <input id="device-info-max-${uniqueId}" class="graph-title-input" placeholder="Max % (0-100)" />

          <!-- NEW: Alarm E-mail (supports multiple, comma or semicolon separated) -->
          <label style="display:block;margin-top:10px;margin-bottom:6px;color:var(--muted);font-size:13px;">Alarm E-mail(s)</label>
          <input id="device-info-email-${uniqueId}" class="graph-title-input" placeholder="e.g. alarm@example.com, other@example.com" />
        </div>
      </div>

      <div id="device-info-msg-${uniqueId}" class="history-msg" style="margin-top:10px;"></div>
    </div>
  `;
}

function showDeviceInfoModal(initialSerial) {
  const unique = 'did' + Date.now();
  const modal = document.createElement('div');
  modal.className = 'history-modal';
  modal.innerHTML = buildDeviceInfoModalHtml(unique);
  document.body.appendChild(modal);
  document.body.classList.add('modal-open');

  const selectEl = modal.querySelector(`#device-info-select-${unique}`);
  const terminalInput = modal.querySelector(`#device-info-terminal-${unique}`); // now used as Serial input
  const buildingInput = modal.querySelector(`#device-info-building-${unique}`);
  const addressInput = modal.querySelector(`#device-info-address-${unique}`);
  const afgInput = modal.querySelector(`#device-info-afg-${unique}`);
  const clientInput = modal.querySelector(`#device-info-client-${unique}`);
  const capacityInput = modal.querySelector(`#device-info-capacity-${unique}`);
  const detailsInput = modal.querySelector(`#device-info-details-${unique}`);
  const typeSelect = modal.querySelector(`#device-info-type-${unique}`);
  const installSelect = modal.querySelector(`#device-info-install-${unique}`);
  const notesInput = modal.querySelector(`#device-info-notes-${unique}`);
  const saveBtn = modal.querySelector('.device-info-save');
  const closeBtn = modal.querySelector('.history-close');
  const msgEl = modal.querySelector(`#device-info-msg-${unique}`);

  // NEW threshold inputs
  const minInput = modal.querySelector(`#device-info-min-${unique}`);
  const maxInput = modal.querySelector(`#device-info-max-${unique}`);

  // NEW alarm email input
  const emailInput = modal.querySelector(`#device-info-email-${unique}`);

  // Helper: resolve a serial number to the current/most-recent terminal id via server API
  async function resolveTerminalIdFromSn(sn) {
    if (!sn) return null;
    try {
      const resp = await fetch(`/api/tank-by-sn?sn=${encodeURIComponent(String(sn))}`, { cache: 'no-store' });
      if (!resp.ok) {
        return null;
      }
      const json = await resp.json();
      return (json && json.terminal_id) ? String(json.terminal_id) : null;
    } catch (err) {
      return null;
    }
  }

  // Populate device select with SNs retrieved from server (fall back to devices[] if API fails)
  (async () => {
    try {
      selectEl.innerHTML = `<option value="">— choose device —</option>`;
      const resp = await fetch('/api/tank-sns', { cache: 'no-store' });
      if (resp.ok) {
        const json = await resp.json();
        const rows = Array.isArray(json.rows) ? json.rows : (Array.isArray(json) ? json : []);
        for (const r of rows) {
          const opt = document.createElement('option');
          opt.value = r.sn || '';
          // DO NOT expose the terminal id in the visible text. The server intentionally returns only sn here.
          // Client will resolve the terminal id when needed via /api/tank-by-sn.
          opt.textContent = r.sn ? `${r.sn}` : 'Unknown';
          selectEl.appendChild(opt);
        }
      } else {
        // fallback: use local devices array but prefer device.sn as value
        devices.forEach(dev => {
          const opt = document.createElement('option');
          opt.value = dev.sn || '';
          opt.textContent = dev.sn || dev.name;
          selectEl.appendChild(opt);
        });
      }
    } catch (err) {
      // fallback default
      selectEl.innerHTML = `<option value="">— choose device —</option>`;
      devices.forEach(dev => {
        const opt = document.createElement('option');
        opt.value = dev.sn || '';
        opt.textContent = dev.sn || dev.name;
        selectEl.appendChild(opt);
      });
    }
  })();

  function removeModal() {
    modal.remove();
    document.body.classList.remove('modal-open');
  }

  closeBtn.addEventListener('click', () => removeModal());
  modal.addEventListener('click', (e) => { if (e.target === modal) removeModal(); });

  // When user picks a device from the select, populate serial input and fetch existing info
  selectEl.addEventListener('change', async (e) => {
    const val = e.target.value;
    if (val) {
      terminalInput.value = val; // show serial in input
      // Resolve terminal id via API (we don't store terminal_id on the option)
      const resolved = await resolveTerminalIdFromSn(val);
      if (resolved) {
        await loadInfoForTerminal(resolved);
      } else {
        msgEl.textContent = 'No terminal mapping found for that serial.';
        setTimeout(() => { msgEl.textContent = ''; }, 2000);
      }
    }
  });

  terminalInput.addEventListener('blur', async () => {
    const serial = terminalInput.value && terminalInput.value.trim();
    if (serial) {
      // Try to resolve serial -> terminal id
      msgEl.textContent = 'Looking up terminal...';
      const resolved = await resolveTerminalIdFromSn(serial);
      if (resolved) {
        // If possible, set the select to match this serial
        try {
          const optToSelect = Array.from(selectEl.options).find(o => o.value === serial);
          if (optToSelect) selectEl.value = serial;
        } catch (e) { /* ignore */ }
        await loadInfoForTerminal(resolved);
        msgEl.textContent = '';
      } else {
        // If nothing found, clear fields and show helpful message
        msgEl.textContent = 'No terminal mapping found for that serial.';
        buildingInput.value = '';
        addressInput.value = '';
        afgInput.value = '';
        clientInput.value = '';
        capacityInput.value = '';
        detailsInput.value = '';
        typeSelect.value = '';
        installSelect.value = '';
        notesInput.value = '';
        emailInput.value = '';
        minInput.value = '';
        maxInput.value = '';
        setTimeout(() => { msgEl.textContent = ''; }, 2200);
      }
    }
  });

  async function loadInfoForTerminal(tid) {
    msgEl.textContent = 'Loading…';
    try {
      const info = await fetchTankInfo(tid);
      buildingInput.value = info.building_name || '';
      addressInput.value = info.address || '';
      afgInput.value = info.afg_bld_code || '';
      clientInput.value = info.client_bld_code || '';
      capacityInput.value = info.lpg_tank_capacity || '';
      detailsInput.value = info.lpg_tank_details || '';
      typeSelect.value = info.lpg_tank_type || '';
      installSelect.value = info.lpg_installation_type || '';
      notesInput.value = info.notes || '';

      // populate new alarm email input
      emailInput.value = info.alarm_email || '';

      // Populate new threshold inputs
      minInput.value = (info.lpg_min_level !== null && info.lpg_min_level !== undefined) ? String(info.lpg_min_level) : '';
      maxInput.value = (info.lpg_max_level !== null && info.lpg_max_level !== undefined) ? String(info.lpg_max_level) : '';

      // update in-memory device if exists
      const dev = devices.find(d => String(d.id) === String(tid));
      if (dev) {
        dev._info = info;
        dev.lpg_min_level = (info.lpg_min_level !== null && info.lpg_min_level !== undefined) ? Number(info.lpg_min_level) : null;
        dev.lpg_max_level = (info.lpg_max_level !== null && info.lpg_max_level !== undefined) ? Number(info.lpg_max_level) : null;
        dev.alarm_email = info.alarm_email || null;
      }

      msgEl.textContent = 'Loaded existing info.';
      setTimeout(() => { msgEl.textContent = ''; }, 1600);
    } catch (err) {
      // if not found, just clear fields
      buildingInput.value = '';
      addressInput.value = '';
      afgInput.value = '';
      clientInput.value = '';
      capacityInput.value = '';
      detailsInput.value = '';
      typeSelect.value = '';
      installSelect.value = '';
      notesInput.value = '';
      emailInput.value = '';
      minInput.value = '';
      maxInput.value = '';
      if (err && /not found/i.test(err.message)) {
        msgEl.textContent = 'No saved info for that terminal yet.';
      } else {
        msgEl.textContent = 'Failed to load info: ' + (err && err.message);
      }
      setTimeout(() => { msgEl.textContent = ''; }, 2200);
    }
  }

  saveBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const serial = terminalInput.value && terminalInput.value.trim();
    if (!serial) {
      msgEl.textContent = 'Serial Number is required.';
      msgEl.style.color = '#ffdede';
      return;
    }

    // Resolve serial to terminal id
    msgEl.style.color = 'var(--muted)';
    msgEl.textContent = 'Resolving serial…';
    const resolvedTid = await resolveTerminalIdFromSn(serial);
    if (!resolvedTid) {
      msgEl.style.color = '#ffdede';
      msgEl.textContent = 'Could not find terminal for that serial number.';
      return;
    }

    // parse thresholds defensively
    let minVal = minInput && minInput.value !== undefined && minInput.value !== null && String(minInput.value).trim() !== '' ? Number(minInput.value) : null;
    if (minVal !== null && isNaN(minVal)) minVal = null;
    let maxVal = maxInput && maxInput.value !== undefined && maxInput.value !== null && String(maxInput.value).trim() !== '' ? Number(maxInput.value) : null;
    if (maxVal !== null && isNaN(maxVal)) maxVal = null;

    // Normalize alarm emails: accept comma or semicolon separated; validate basic structure client-side
    let rawEmails = emailInput && emailInput.value ? String(emailInput.value).trim() : '';
    let normalizedEmails = '';
    if (rawEmails) {
      const parts = rawEmails.split(/[;,]+/).map(s => s.trim()).filter(Boolean);
      // Basic client-side email regex (simple)
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const good = parts.filter(p => emailRe.test(p));
      normalizedEmails = good.join(', ');
    }

    const payload = {
      terminalId: resolvedTid,
      building_name: buildingInput.value || '',
      address: addressInput.value || '',
      afg_bld_code: afgInput.value || '',
      client_bld_code: clientInput.value || '',
      lpg_tank_capacity: capacityInput.value || '',
      lpg_tank_details: detailsInput.value || '',
      lpg_tank_type: typeSelect.value || '',
      lpg_installation_type: installSelect.value || '',
      notes: notesInput.value || '',
      lpg_min_level: minVal,
      lpg_max_level: maxVal,
      alarm_email: normalizedEmails || ''
    };
    try {
      msgEl.style.color = 'var(--muted)';
      msgEl.textContent = 'Saving…';
      const saved = await saveTankInfo(payload);
      // update in-memory devices if terminal matches and maybe show feedback
      const dev = devices.find(d => String(d.id) === String(saved.terminal_id));
      if (dev) {
        dev._info = saved;
        dev.lpg_min_level = (saved.lpg_min_level !== null && saved.lpg_min_level !== undefined) ? Number(saved.lpg_min_level) : null;
        dev.lpg_max_level = (saved.lpg_max_level !== null && saved.lpg_max_level !== undefined) ? Number(saved.lpg_max_level) : null;
        dev.alarm_email = saved.alarm_email || null;
      }
      msgEl.style.color = '#22c55e';
      msgEl.textContent = 'Saved.';
      setTimeout(() => { msgEl.textContent = ''; }, 1800);
    } catch (err) {
      msgEl.style.color = '#ffdede';
      msgEl.textContent = 'Save failed: ' + (err && err.message);
    }
  });

  // If caller provided an initial serial, prefill and try to resolve & load
  if (initialSerial) {
    terminalInput.value = initialSerial;
    // attempt to set select to this serial if possible later
    setTimeout(async () => {
      try {
        // Try to set select value if option exists
        const optToSelect = Array.from(selectEl.options).find(o => o.value === initialSerial);
        if (optToSelect) selectEl.value = initialSerial;
      } catch (e) { /* ignore */ }
      const resolved = await resolveTerminalIdFromSn(initialSerial);
      if (resolved) {
        await loadInfoForTerminal(resolved);
      }
    }, 120);
  }
}

/* ---------------------------
   Read-only Tank Info View Modal
   --------------------------- */

// Show a professional, read-only modal with tank_info values for a terminal
function showTankInfoViewModal(terminalId) {
  const modal = document.createElement('div');
  modal.className = 'history-modal tank-info-view';
  modal.innerHTML = `
    <div class="history-panel" role="dialog" aria-modal="true" aria-label="Device Information View for ${escapeHtml(terminalId)}">
      <div class="history-actions" style="align-items:center;">
        <div style="display:flex;align-items:center;gap:12px;">
          <strong>Device Information</strong>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="history-controls">
            <button class="history-close" type="button">Close</button>
          </div>
        </div>
      </div>

      <div id="tank-info-view-body" style="display:grid;grid-template-columns: 1fr 1fr; gap:18px; padding-top:8px;">
        <div style="background:linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0.005)); padding:16px; border-radius:10px; border:1px solid rgba(255,255,255,0.02);">
          <div style="font-size:13px;color:var(--muted);margin-bottom:8px;font-weight:700;">Building / Company</div>
          <div id="view-building" style="font-size:15px;color:var(--text);"></div>

          <div style="font-size:13px;color:var(--muted);margin-top:12px;font-weight:700;">Address</div>
          <div id="view-address" style="font-size:14px;color:var(--text);"></div>

          <div style="display:flex;gap:12px;margin-top:12px;">
            <div style="flex:1;">
              <div style="font-size:13px;color:var(--muted);font-weight:700;">AFG Bld Code</div>
              <div id="view-afg" style="font-size:14px;color:var(--text);"></div>
            </div>
            <div style="flex:1;">
              <div style="font-size:13px;color:var(--muted);font-weight:700;">Client Bld Code</div>
              <div id="view-client" style="font-size:14px;color:var(--text);"></div>
            </div>
          </div>

          <!-- NEW: Min/Max display -->
          <div style="margin-top:12px;">
            <div style="font-size:13px;color:var(--muted);font-weight:700;">LPG Min Level</div>
            <div id="view-min-level" style="font-size:14px;color:var(--text);"></div>

            <div style="font-size:13px;color:var(--muted);margin-top:8px;font-weight:700;">LPG Max Level</div>
            <div id="view-max-level" style="font-size:14px;color:var(--text);"></div>
          </div>
        </div>

        <div style="background:linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0.005)); padding:16px; border-radius:10px; border:1px solid rgba(255,255,255,0.02);">
          <div style="font-size:13px;color:var(--muted);margin-bottom:8px;font-weight:700;">LPG Tank Capacity</div>
          <div id="view-capacity" style="font-size:15px;color:var(--text);"></div>

          <div style="font-size:13px;color:var(--muted);margin-top:12px;font-weight:700;">LPG Tank Details</div>
          <div id="view-details" style="font-size:14px;color:var(--text);"></div>

          <div style="display:flex;gap:12px;margin-top:12px;">
            <div style="flex:1;">
              <div style="font-size:13px;color:var(--muted);font-weight:700;">Tank Type</div>
              <div id="view-type" style="font-size:14px;color:var(--text);"></div>
            </div>
            <div style="flex:1;">
              <div style="font-size:13px;color:var(--muted);font-weight:700;">Installation</div>
              <div id="view-install" style="font-size:14px;color:var(--text);"></div>
            </div>
          </div>

          <div style="margin-top:12px;">
            <div style="font-size:13px;color:var(--muted);font-weight:700;">Alarm E-mail</div>
            <div id="view-alarm-email" style="font-size:14px;color:var(--text);"></div>
          </div>
        </div>

        <!-- full-width supplemental area -->
        <div style="grid-column: 1 / -1; margin-top:6px; display:flex; justify-content:space-between; gap:12px;">
          <div style="flex:1; background:linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0.005)); padding:14px; border-radius:10px; border:1px solid rgba(255,255,255,0.02);">
            <div style="font-size:13px;color:var(--muted);font-weight:700;">Notes</div>
            <div id="view-notes" style="font-size:14px;color:var(--muted); margin-top:6px;">(No additional notes)</div>
          </div>
          <div style="width:240px; flex-shrink:0; background:linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0.005)); padding:14px; border-radius:10px; border:1px solid rgba(255,255,255,0.02); text-align:center;">
            <div style="font-size:12px;color:var(--muted);font-weight:700;">Last saved</div>
            <div id="view-saved-at" style="font-size:13px;color:var(--text); margin-top:8px;"></div>
          </div>
        </div>
      </div>

      <div id="tank-info-view-msg" class="history-msg" style="margin-top:12px;"></div>
    </div>
  `;

  document.body.appendChild(modal);
  document.body.classList.add('modal-open');

  const closeBtn = modal.querySelector('.history-close');
  const msgEl = modal.querySelector('#tank-info-view-msg');

  function removeModal() {
    modal.remove();
    document.body.classList.remove('modal-open');
  }

  closeBtn.addEventListener('click', removeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) removeModal(); });

  // populate fields
  (async () => {
    try {
      msgEl.textContent = 'Loading…';
      const info = await fetchTankInfo(terminalId);
      modal.querySelector('#view-building').textContent = info.building_name || '—';
      modal.querySelector('#view-address').textContent = info.address || '—';
      modal.querySelector('#view-afg').textContent = info.afg_bld_code || '—';
      modal.querySelector('#view-client').textContent = info.client_bld_code || '—';
      modal.querySelector('#view-capacity').textContent = info.lpg_tank_capacity || '—';
      modal.querySelector('#view-details').textContent = info.lpg_tank_details || '—';
      modal.querySelector('#view-type').textContent = info.lpg_tank_type || '—';
      modal.querySelector('#view-install').textContent = info.lpg_installation_type || '—';
      modal.querySelector('#view-notes').textContent = info.notes && String(info.notes).trim() ? info.notes : '(No additional notes)';
      modal.querySelector('#view-saved-at').textContent = info.created_at ? new Date(info.created_at).toLocaleString() : '—';

      // NEW: min/max display
      modal.querySelector('#view-min-level').textContent = (info.lpg_min_level !== null && info.lpg_min_level !== undefined) ? String(info.lpg_min_level) + '%' : '—';
      modal.querySelector('#view-max-level').textContent = (info.lpg_max_level !== null && info.lpg_max_level !== undefined) ? String(info.lpg_max_level) + '%' : '—';

      // NEW: alarm email display - show multiple on separate lines for readability
      const viewAlarmEl = modal.querySelector('#view-alarm-email');
      if (info.alarm_email) {
        const parts = String(info.alarm_email).split(/[;,]+/).map(s => s.trim()).filter(Boolean);
        viewAlarmEl.innerHTML = parts.map(p => escapeHtml(p)).join('<br>');
      } else {
        viewAlarmEl.textContent = '—';
      }

      msgEl.textContent = '';
    } catch (err) {
      msgEl.textContent = 'No saved information for this terminal.';
      modal.querySelector('#view-building').textContent = '—';
      modal.querySelector('#view-address').textContent = '—';
      modal.querySelector('#view-afg').textContent = '—';
      modal.querySelector('#view-client').textContent = '—';
      modal.querySelector('#view-capacity').textContent = '—';
      modal.querySelector('#view-details').textContent = '—';
      modal.querySelector('#view-type').textContent = '—';
      modal.querySelector('#view-install').textContent = '—';
      modal.querySelector('#view-notes').textContent = '(No additional notes)';
      modal.querySelector('#view-saved-at').textContent = '—';
      modal.querySelector('#view-min-level').textContent = '—';
      modal.querySelector('#view-max-level').textContent = '—';
      modal.querySelector('#view-alarm-email').textContent = '—';
    }
  })();
}

/* ---------------------------
   Visitor Tracking (Admin)
   --------------------------- */

async function fetchLoginAttempts({ limit = 200, offset = 0, isAdmin, success, username, since, until } = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  if (isAdmin !== undefined) params.set('isAdmin', isAdmin ? '1' : '0');
  if (success !== undefined) params.set('success', success ? '1' : '0');
  if (username) params.set('username', username);
  if (since) params.set('since', since);
  if (until) params.set('until', until);
  const url = `/api/login-attempts?${params.toString()}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || resp.statusText || 'Failed to load login attempts');
  }
  return resp.json();
}

function formatDateTimeIso(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function showVisitorTrackingModal() {
  const modal = document.createElement('div');
  modal.className = 'history-modal';
  modal.innerHTML = `
    <div class="history-panel" role="dialog" aria-modal="true" aria-label="Visitor Tracking">
      <div class="history-actions">
        <div style="display:flex;align-items:center;gap:12px;">
          <strong>Visitor Tracking</strong>
          <div class="history-range">
            <input type="text" class="vt-username graph-title-input" placeholder="Filter username" />
            <select class="vt-type graph-title-input" title="Type">
              <option value="">All</option>
              <option value="1">Admin attempts</option>
              <option value="0">User attempts</option>
            </select>
            <select class="vt-success graph-title-input" title="Success">
              <option value="">All</option>
              <option value="1">Success</option>
              <option value="0">Failure</option>
            </select>
            <button class="btn vt-apply">Apply</button>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="history-controls">
            <button class="btn vt-refresh" type="button">Refresh</button>
            <button class="history-close" type="button">Close</button>
          </div>
        </div>
      </div>

      <div style="max-height:520px; overflow:auto; padding:6px;">
        <table class="tracking-table" style="width:100%;border-collapse:collapse;">
          <thead>
            <tr>
              <th style="text-align:left;padding:8px;border-bottom:1px solid rgba(255,255,255,0.04);">Time</th>
              <th style="text-align:left;padding:8px;border-bottom:1px solid rgba(255,255,255,0.04);">Username</th>
              <th style="text-align:left;padding:8px;border-bottom:1px solid rgba(255,255,255,0.04);">Type</th>
              <th style="text-align:left;padding:8px;border-bottom:1px solid rgba(255,255,255,0.04);">Result</th>
              <th style="text-align:left;padding:8px;border-bottom:1px solid rgba(255,255,255,0.04);">IP</th>
              <th style="text-align:left;padding:8px;border-bottom:1px solid rgba(255,255,255,0.04);">User Agent</th>
            </tr>
          </thead>
          <tbody class="tracking-body">
            <tr><td colspan="6" style="padding:18px;color:var(--muted);">Loading...</td></tr>
          </tbody>
        </table>
      </div>

      <div id="vt-msg" class="history-msg"></div>
    </div>
  `;
  document.body.appendChild(modal);
  document.body.classList.add('modal-open');

  const closeBtn = modal.querySelector('.history-close');
  const refreshBtn = modal.querySelector('.vt-refresh');
  const applyBtn = modal.querySelector('.vt-apply');
  const usernameFilter = modal.querySelector('.vt-username');
  const typeFilter = modal.querySelector('.vt-type');
  const successFilter = modal.querySelector('.vt-success');
  const tbody = modal.querySelector('.tracking-body');
  const msgEl = modal.querySelector('#vt-msg');

  function removeModal() {
    modal.remove();
    document.body.classList.remove('modal-open');
  }
  closeBtn.addEventListener('click', () => removeModal());
  modal.addEventListener('click', (e) => { if (e.target === modal) removeModal(); });

  async function loadList() {
    try {
      msgEl.textContent = 'Loading...';
      tbody.innerHTML = `<tr><td colspan="6" style="padding:18px;color:var(--muted);">Loading...</td></tr>`;
      const limit = 500;
      const params = { limit };
      if (usernameFilter && usernameFilter.value) params.username = usernameFilter.value.trim();
      if (typeFilter && typeFilter.value !== '') params.isAdmin = typeFilter.value === '1';
      if (successFilter && successFilter.value !== '') params.success = successFilter.value === '1';

      const json = await fetchLoginAttempts(params);
      const rows = (json && json.rows) ? json.rows : [];
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="6" style="padding:18px;color:var(--muted);">No login attempts found for that filter.</td></tr>`;
        msgEl.textContent = '';
        return;
      }
      tbody.innerHTML = '';
      for (const r of rows) {
        const time = formatDateTimeIso(r.created_at);
        const tUser = escapeHtml(r.username || '');
        const type = r.is_admin_attempt ? 'Admin' : 'User';
        const result = r.success ? '<span style="color:var(--green);font-weight:700">Success</span>' : '<span style="color:var(--red);font-weight:700">Failure</span>';
        const ip = escapeHtml(r.ip || '');
        const ua = escapeHtml((r.user_agent || '').slice(0, 180));
        const note = escapeHtml(r.note || '');
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="padding:8px;border-top:1px solid rgba(255,255,255,0.02);vertical-align:top">${time}</td>
          <td style="padding:8px;border-top:1px solid rgba(255,255,255,0.02);vertical-align:top">${tUser}${note ? `<div style="color:var(--muted);font-size:12px;margin-top:6px">${note}</div>` : ''}</td>
          <td style="padding:8px;border-top:1px solid rgba(255,255,255,0.02);vertical-align:top">${type}</td>
          <td style="padding:8px;border-top:1px solid rgba(255,255,255,0.02);vertical-align:top">${result}</td>
          <td style="padding:8px;border-top:1px solid rgba(255,255,255,0.02);vertical-align:top">${ip}</td>
          <td style="padding:8px;border-top:1px solid rgba(255,255,255,0.02);vertical-align:top;font-size:13px;color:var(--muted)}">${ua}</td>
        `;
        tbody.appendChild(tr);
      }
      msgEl.textContent = '';
    } catch (err) {
      msgEl.textContent = 'Failed to load visitor tracking: ' + (err && err.message);
      tbody.innerHTML = `<tr><td colspan="6" style="padding:18px;color:var(--muted);">Error loading attempts.</td></tr>`;
    }
  }

  refreshBtn.addEventListener('click', (e) => { e.stopPropagation(); loadList(); });
  applyBtn.addEventListener('click', (e) => { e.stopPropagation(); loadList(); });

  // initial load
  loadList();
}

/* ---------------------------
   MAP (Leaflet) integration (lightweight, lazy-loaded)
   (unchanged from the original script; keep behavior)
*/

function loadLeafletOnce() {
  // returns a promise that resolves when L is available
  if (window._leafletLoadingPromise) return window._leafletLoadingPromise;

  window._leafletLoadingPromise = new Promise((resolve, reject) => {
    // If Leaflet already present
    if (window.L) return resolve(window.L);

    // Inject CSS
    const cssHref = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    if (!document.querySelector(`link[href="${cssHref}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = cssHref;
      link.crossOrigin = '';
      document.head.appendChild(link);
    }

    // Inject script
    const scriptSrc = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    if (document.querySelector(`script[src="${scriptSrc}"]`)) {
      // Wait until L is available
      const waitForL = () => {
        if (window.L) return resolve(window.L);
        setTimeout(waitForL, 50);
      };
      waitForL();
      return;
    }

    const s = document.createElement('script');
    s.src = scriptSrc;
    s.async = true;
    s.onload = () => {
      if (window.L) resolve(window.L);
      else reject(new Error('Leaflet loaded but L not found'));
    };
    s.onerror = (e) => reject(new Error('Failed to load Leaflet: ' + (e && e.message)));
    document.body.appendChild(s);
  });

  return window._leafletLoadingPromise;
}

function showMapModal(terminalId, device) {
  const modal = document.createElement('div');
  modal.className = 'history-modal';
  const title = escapeHtml(device.title || device.name || terminalId);
  const canvasId = `map-canvas-${terminalId}-${Date.now()}`;

  modal.innerHTML = `
    <div class="history-panel" role="dialog" aria-modal="true" aria-label="Location for ${title}">
      <div class="history-actions">
        <div style="display:flex;align-items:center;gap:12px;">
          <strong>${title}</strong>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="history-controls">
            <a class="btn open-gmap-link" target="_blank" rel="noopener" style="display:none;">Open Location Link</a>
            <button class="history-close" type="button">Close</button>
          </div>
        </div>
      </div>
      <div style="position:relative;">
        <div style="padding:8px 0;color:var(--muted);font-size:13px;">
          <span id="map-latlng-${canvasId}"></span>
        </div>
        <div id="${canvasId}" class="map-canvas" aria-hidden="false"></div>
      </div>
      <div id="map-msg" class="history-msg"></div>
    </div>
  `;

  document.body.appendChild(modal);
  document.body.classList.add('modal-open');

  const closeBtn = modal.querySelector('.history-close');
  const msgEl = modal.querySelector('#map-msg');
  const mapEl = modal.querySelector(`#${canvasId}`);
  const openGmapLink = modal.querySelector('.open-gmap-link');
  const latlngLabel = modal.querySelector(`#map-latlng-${canvasId}`);

  let leafletMap = null;

  function cleanup() {
    if (leafletMap) {
      try { leafletMap.remove(); } catch (e) { /* ignore */ }
      leafletMap = null;
    }
    modal.remove();
    document.body.classList.remove('modal-open');
  }

  closeBtn.addEventListener('click', () => cleanup());
  modal.addEventListener('click', (e) => { if (e.target === modal) cleanup(); });

  const lat = device && device.lat;
  const lng = device && device.lng;

  // If there's a location link, show button and set href
  if (device && device.locationLink) {
    openGmapLink.href = device.locationLink;
    openGmapLink.style.display = 'inline-flex';
    openGmapLink.textContent = 'Open Location Link';
  }

  // Show lat/lng if present
  if (typeof lat === 'number' && typeof lng === 'number' && !isNaN(lat) && !isNaN(lng)) {
    latlngLabel.textContent = `Lat / Lng: ${lat.toFixed(6)} , ${lng.toFixed(6)}`;
  } else {
    latlngLabel.textContent = device && device.locationLink ? 'No numeric lat/lng available for this site.' : 'Location not available for this device.';
  }

  // If lat/lng present, display a small Leaflet preview map (lazy-load the library)
  if (typeof lat === 'number' && typeof lng === 'number' && !isNaN(lat) && !isNaN(lng)) {
    msgEl.textContent = 'Loading map…';
    loadLeafletOnce().then((L) => {
      try {
        leafletMap = L.map(mapEl, { attributionControl: true, zoomControl: true }).setView([lat, lng], 14);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap contributors'
        }).addTo(leafletMap);

        const popupContent = `
          <div style="font-weight:700;margin-bottom:6px">${escapeHtml(device.title || device.name)}</div>
          <div style="margin-top:6px">Lat/Lng: ${lat.toFixed(6)}, ${lng.toFixed(6)}</div>
        `;

        const marker = L.marker([lat, lng]).addTo(leafletMap).bindPopup(popupContent).openPopup();

        marker.on('click', () => {
          const card = document.querySelector(`.tank-card[data-terminal="${terminalId}"]`);
          if (card) {
            selectCard(card);
            try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { card.scrollIntoView(); }
          }
        });

        msgEl.textContent = '';
        setTimeout(() => { try { leafletMap.invalidateSize(); } catch (e) { /* ignore */ } }, 200);
      } catch (err) {
        msgEl.textContent = 'Map failed to initialize: ' + (err && err.message);
      }
    }).catch(err => {
      msgEl.textContent = 'Failed to load map library: ' + (err && err.message);
    });
  } else {
    // No lat/lng available; leave the canvas area empty and show helpful message
    msgEl.textContent = device && device.locationLink ? 'Opened link in a new tab (if provided).' : 'No coordinates or location link available.';
  }
}

// Show all devices (admin) in one map modal with simple markers
async function showAllDevicesMap() {
  // gather available coords
  const coords = devices.map(d => ({ id: d.id, title: d.title || d.name, lat: d.lat, lng: d.lng })).filter(d => typeof d.lat === 'number' && typeof d.lng === 'number');
  if (!coords.length) {
    alert('No device coordinates available to show on the map.');
    return;
  }

  const modal = document.createElement('div');
  modal.className = 'history-modal';
  const canvasId = `map-all-${Date.now()}`;
  modal.innerHTML = `
    <div class="history-panel" role="dialog" aria-modal="true" aria-label="All devices">
      <div class="history-actions">
        <div style="display:flex;align-items:center;gap:12px;">
          <strong>All devices</strong>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="history-controls">
            <button class="history-close" type="button">Close</button>
          </div>
        </div>
      </div>
      <div style="position:relative;">
        <div id="${canvasId}" class="map-canvas"></div>
      </div>
      <div id="map-all-msg" class="history-msg"></div>
    </div>
  `;
  document.body.appendChild(modal);
  document.body.classList.add('modal-open');

  const closeBtn = modal.querySelector('.history-close');
  const msgEl = modal.querySelector('#map-all-msg');
  const mapEl = modal.querySelector(`#${canvasId}`);
  let leafletMap = null;

  function cleanup() {
    if (leafletMap) {
      try { leafletMap.remove(); } catch (e) { /* ignore */ }
      leafletMap = null;
    }
    modal.remove();
    document.body.classList.remove('modal-open');
  }

  closeBtn.addEventListener('click', () => cleanup());
  modal.addEventListener('click', (e) => { if (e.target === modal) cleanup(); });

  msgEl.textContent = 'Loading map…';
  loadLeafletOnce().then((L) => {
    try {
      // center map at average
      const avgLat = coords.reduce((s, r) => s + r.lat, 0) / coords.length;
      const avgLng = coords.reduce((s, r) => s + r.lng, 0) / coords.length;
      leafletMap = L.map(mapEl, { scrollWheelZoom: true }).setView([avgLat, avgLng], 12);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(leafletMap);

      const group = [];
      coords.forEach(c => {
        const marker = L.marker([c.lat, c.lng]).addTo(leafletMap);
        // Do NOT include terminal id in the popup to avoid exposing IDs to users.
        marker.bindPopup(`<div style="font-weight:700">${escapeHtml(c.title)}</div>`);
        marker.on('click', () => {
          const card = document.querySelector(`.tank-card[data-terminal="${c.id}"]`);
          if (card) {
            selectCard(card);
            try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { card.scrollIntoView(); }
          }
        });
        group.push(marker);
      });

      const groupLayer = L.featureGroup(group);
      try { leafletMap.fitBounds(groupLayer.getBounds().pad(0.12)); } catch (e) { /* ignore */ }

      msgEl.textContent = '';
      setTimeout(() => { try { leafletMap.invalidateSize(); } catch (e) { /* ignore */ } }, 200);
    } catch (err) {
      msgEl.textContent = 'Map failed to initialize: ' + (err && err.message);
    }
  }).catch(err => {
    msgEl.textContent = 'Failed to load map library: ' + (err && err.message);
  });
}

/* ---------------------------
   Sites (client-side helpers + admin UI)
   --------------------------- */

// Helper to POST a site (used by admin UI). Minimal validation.
async function saveSite({ terminalId, site, location, latitude, longitude }) {
  const body = { terminalId, site, location };
  if (latitude !== undefined && latitude !== null && latitude !== '') body.latitude = Number(latitude);
  if (longitude !== undefined && longitude !== null && longitude !== '') body.longitude = Number(longitude);
  const resp = await fetch('/api/sites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const j = await resp.json().catch(() => ({}));
    throw new Error(j.error || 'Failed to save site');
  }
  return resp.json();
}

// Refresh devices' site info from server and update cards/dropdown
async function refreshSitesAndUpdateUI() {
  try {
    const resp = await fetch('/api/sites', { cache: 'no-store' });
    if (!resp.ok) return;
    const json = await resp.json();
    const rows = Array.isArray(json.rows) ? json.rows : [];
    const siteMap = new Map(rows.map(r => [String(r.terminal_id), r]));

    // update devices in memory
    devices.forEach(d => {
      const s = siteMap.get(String(d.id));
      if (s) {
        d.lat = (s.latitude === null || s.latitude === undefined) ? undefined : Number(s.latitude);
        d.lng = (s.longitude === null || s.longitude === undefined) ? undefined : Number(s.longitude);
        d.locationLink = s.location || '';
        d.site = s.site || d.site;
      } else {
        // keep existing if none found
      }
    });

    // update card displays for location
    devices.forEach(d => updateCardLocationDisplay(d));

    // update admin-device-select dropdown if present
    const sel = document.getElementById('admin-device-select');
    if (sel) {
      // Clear and rebuild options
      const val = sel.value;
      sel.innerHTML = `<option value="">— choose device —</option>`;
      devices.forEach(dev => {
        const opt = document.createElement('option');
        opt.value = dev.id;
        opt.textContent = `${dev.name} (${dev.id})`;
        sel.appendChild(opt);
      });
      // attempt to restore previous selection if still valid
      if (val) sel.value = val;
    }
  } catch (err) {
    console.warn('Failed to refresh sites:', err && err.message);
  }
}

/* ---------------------------
   Init
   --------------------------- */

 // Single, unified init that loads titles BEFORE building cards
async function init() {
  // prevent starting if not authenticated (for this page load)
  if (!isLoggedIn()) {
    return;
  }

  // mark started so subsequent events don't re-run init
  window._app_started = true;

  if (!tanksContainer) return;

  try {
    // Load titles and sites from backend first so inputs show correct values on initial render
    await loadTitles();
  } catch (e) {
    console.warn('Title/site load failed during init', e && e.message);
  }

  // NEW: attempt to fetch tank_info list so we have thresholds available for coloring immediately
  try {
    const tiResp = await fetch('/api/tank-info', { cache: 'no-store' });
    if (tiResp.ok) {
      const tiJson = await tiResp.json();
      const rows = Array.isArray(tiJson.rows) ? tiJson.rows : [];
      const infoMap = new Map(rows.map(r => [String(r.terminal_id), r]));
      devices.forEach(d => {
        const s = infoMap.get(String(d.id));
        if (s) {
          d.lpg_min_level = (s.lpg_min_level !== null && s.lpg_min_level !== undefined) ? Number(s.lpg_min_level) : null;
          d.lpg_max_level = (s.lpg_max_level !== null && s.lpg_max_level !== undefined) ? Number(s.lpg_max_level) : null;
          d.alarm_email = s.alarm_email || null;
          d._info = s;
        } else {
          d.lpg_min_level = d.lpg_min_level || null;
          d.lpg_max_level = d.lpg_max_level || null;
          d.alarm_email = d.alarm_email || null;
        }
      });
    }
  } catch (e) {
    console.warn('Failed to load tank info list during init', e && e.message);
  }

  // Restore any saved order
  restoreDeviceOrder();

  // Clear container
  tanksContainer.innerHTML = '';

  // Build cards for all devices
  devices.forEach(device => {
    const card = createCard(device);
    tanksContainer.appendChild(card);
  });

  // Attach refresh button handlers and keyboard-only reorder handlers
  attachCardControls();

  // Initial fetch for all cards — show spinner for the first fetch only
  const cardEls = Array.from(document.querySelectorAll('.tank-card'));
  cardEls.forEach(cardEl => {
    const terminalId = cardEl.dataset.terminal;
    const device = devices.find(d => d.id === terminalId);
    if (device) fetchAndUpdate(device, cardEl, true);
  });

  // If logged in as admin, reveal the Administrator Menu area
  try {
    const adminMenu = document.getElementById('admin-menu');
      if (isAdmin() && adminMenu) {
      adminMenu.style.display = 'block';
      adminMenu.setAttribute('aria-hidden', 'false');

      // Reveal Terminal ID rows for admins
      document.querySelectorAll('.term-row.admin-only').forEach(el => { el.style.display = ''; });

      // Attach visitor tracking button handler
      const vtBtn = document.getElementById('visitor-tracking-btn');
      if (vtBtn) {
        vtBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          showVisitorTrackingModal();
        });
      }

      // Attach "Show All Devices Map" handler
      const allMapBtn = document.getElementById('open-all-map');
      if (allMapBtn) {
        allMapBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          showAllDevicesMap();
        });
      }

      // Attach "Device Information" handler (admin)
      const adminDevInfoBtn = document.getElementById('admin-device-info-btn');
      if (adminDevInfoBtn) {
        // ensure the button only appears for Sonic or Alfanar_Admin1
        if (canSeeDeviceInformation()) {
          adminDevInfoBtn.style.display = '';
          adminDevInfoBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showDeviceInfoModal();
          });
        } else {
          adminDevInfoBtn.style.display = 'none';
        }
      }

      // Populate admin device dropdown and wire up save button
      const deviceSelect = document.getElementById('admin-device-select');
      if (deviceSelect) {
        deviceSelect.innerHTML = `<option value="">— choose device —</option>`;
        devices.forEach(dev => {
          const opt = document.createElement('option');
          opt.value = dev.id;
          opt.textContent = `${dev.name} (${dev.id})`;
          deviceSelect.appendChild(opt);
        });

        deviceSelect.addEventListener('change', (ev) => {
          const v = ev.target.value;
          const tidInput = document.getElementById('admin-terminal-id');
          if (v && tidInput) tidInput.value = v;
        });
      }

      const saveBtn = document.getElementById('admin-site-save');
      const msgSpan = document.getElementById('admin-site-msg');
      if (saveBtn) {
        saveBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const sel = document.getElementById('admin-device-select');
          const terminalInput = document.getElementById('admin-terminal-id');
          const siteInput = document.getElementById('admin-site-name');
          const locInput = document.getElementById('admin-location-link');
          const latInput = document.getElementById('admin-lat');
          const lngInput = document.getElementById('admin-lng');

          // Prefer explicit terminal id, else selection
          const chosenId = (terminalInput && terminalInput.value) ? String(terminalInput.value).trim() : (sel && sel.value ? sel.value : '');
          if (!chosenId) {
            msgSpan.textContent = 'Terminal ID required (enter or pick a device).';
            msgSpan.style.color = '#ffdede';
            return;
          }

          const payload = {
            terminalId: chosenId,
            site: siteInput && siteInput.value ? siteInput.value.trim() : '',
            location: locInput && locInput.value ? locInput.value.trim() : '',
            latitude: latInput && latInput.value ? latInput.value.trim() : '',
            longitude: lngInput && lngInput.value ? lngInput.value.trim() : ''
          };

          msgSpan.textContent = 'Saving…';
          msgSpan.style.color = 'var(--muted)';
          try {
            const res = await saveSite(payload);
            // update in-memory device entry if present
            const dev = devices.find(d => String(d.id) === String(res.terminal_id));
            if (dev) {
              dev.lat = (res.latitude !== null && res.latitude !== undefined) ? Number(res.latitude) : undefined;
              dev.lng = (res.longitude !== null && res.longitude !== undefined) ? Number(res.longitude) : undefined;
              dev.locationLink = res.location || '';
              dev.site = res.site || dev.site;
              // update card UI
              updateCardLocationDisplay(dev);
            }
            // refresh site list & dropdowns
            await refreshSitesAndUpdateUI();
            msgSpan.textContent = 'Saved';
            msgSpan.style.color = '#22c55e';
            setTimeout(() => { msgSpan.textContent = ''; }, 2200);
          } catch (err) {
            console.warn('Save site failed', err && err.message);
            msgSpan.textContent = 'Save failed: ' + (err && err.message);
            msgSpan.style.color = '#ffdede';
          }
        });
      }
         } else if (adminMenu) {
      adminMenu.style.display = 'none';
      adminMenu.setAttribute('aria-hidden', 'true');

      // Ensure Terminal ID rows are hidden for non-admins
      document.querySelectorAll('.term-row.admin-only').forEach(el => { el.style.display = 'none'; });
    }
  } catch (e) {
    console.warn('Failed to set admin menu visibility', e && e.message);
  }
  // Show simple User Menu for non-admin authenticated users
  try {
    const userMenu = document.getElementById('user-menu');
    if (userMenu) {
      if (!isAdmin()) {
        // show for normal authenticated users
        userMenu.style.display = 'block';
        userMenu.setAttribute('aria-hidden', 'false');

        const userMapBtn = document.getElementById('user-open-all-map');
        if (userMapBtn) {
          // ensure only one handler attached
          userMapBtn.removeEventListener('click', userMapBtn._boundHandler);
          userMapBtn._boundHandler = (e) => { e.stopPropagation(); showAllDevicesMap(); };
          userMapBtn.addEventListener('click', userMapBtn._boundHandler);
        }

        // user device info button - show only for Sonic or Alfanar_Admin1
        const userDevInfoBtn = document.getElementById('user-device-info-btn');
        if (userDevInfoBtn) {
          if (canSeeDeviceInformation()) {
            userDevInfoBtn.style.display = '';
            userDevInfoBtn.removeEventListener('click', userDevInfoBtn._boundHandler);
            userDevInfoBtn._boundHandler = (e) => { e.stopPropagation(); showDeviceInfoModal(); };
            userDevInfoBtn.addEventListener('click', userDevInfoBtn._boundHandler);
          } else {
            userDevInfoBtn.style.display = 'none';
          }
        }
      } else {
        // hide for admins (they already have the admin menu)
        userMenu.style.display = 'none';
        userMenu.setAttribute('aria-hidden', 'true');
      }
    }
  } catch (e) {
    console.warn('Failed to set user menu visibility', e && e.message);
  }
  // Ensure location displays are accurate (in case loaded after card creation)
  devices.forEach(d => updateCardLocationDisplay(d));

  // Polling: subsequent refreshes will NOT show the spinner (silent updates)
  setInterval(refreshAll, POLL_INTERVAL_MS);
}

// Expose a named start function so the login script can call it after authentication
window.appStart = init;

// Always wait for the login event; the login modal shows on every page load.
// When the login modal calls window.appStart() (after setting window._clientAuthenticated = true),
// init() will run for this page load.
const onLogin = function () {
  if (window._app_started) return;
  try { init(); } catch (e) { console.warn('Init after login failed', e); }
  window.removeEventListener('app:login', onLogin);
};
window.addEventListener('app:login', onLogin);
