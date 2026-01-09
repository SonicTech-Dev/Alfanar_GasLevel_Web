// Devices to display — edit friendly names or IDs here
let devices = [
  { id: "230347", name: "Transmitter A — ZN000000099657" },
  { id: "230344", name: "Transmitter B — ZN000000104508" },
  { id: "230348", name: "Transmitter C — ZN000000103596" },
  { id: "230345", name: "Transmitter D — ZN000000104344" },
  { id: "230346", name: "Transmitter E — ZN000000104482" },
  { id: "231544", name: "Transmitter F — ZN000000104512" }
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

//tank title codes

// Load titles and update devices
async function loadTitles() {
  try {
    const resp = await fetch('/api/titles', { cache: 'no-store' });
    if (!resp.ok) throw new Error('Failed to fetch titles');
    const titles = await resp.json();
    const map = new Map(titles.map(t => [t.terminal_id, t.tank_title]));
    devices.forEach(device => {
      device.title = map.get(device.id) || device.name; // Default to "name" if no title exists
    });
  } catch (err) {
    console.warn('Failed to load titles:', err.message);
  }
}

// Allow users to edit titles and save to the server
async function saveTitle(terminalId, sn, title) {
  try {
    const resp = await fetch('/api/titles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalId, sn, title }),
    });
    if (!resp.ok) {
      const json = await resp.json();
      throw new Error(json.error || 'Failed to save title');
    }
  } catch (err) {
    console.warn(`Failed to save title for terminal ${terminalId}:`, err.message);
    alert('Failed to save title. Please try again.');
  }
}

async function init() {
  try {
    await loadTitles(); // Load titles from the server
    // The rest of the initialization logic goes here...
  } catch (e) {
    console.warn('Failed to initialize app:', e.message);
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

// Create a card element for a device
function createCard(device) {
  const card = document.createElement('article');
  card.className = 'card tank-card';
  card.dataset.terminal = device.id;
  card.tabIndex = 0; // make focusable so user can click/focus and use keyboard

  card.innerHTML = `
    <div class="title-edit-wrap">
      <input type="text" class="title-input" value="${escapeHtml(device.title)}" aria-label="Edit tank title" />
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
      <div><strong>Terminal ID:</strong> <span class="term">${escapeHtml(device.id)}</span></div>
      <div><strong>Timestamp:</strong> <span class="time">-</span></div>
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
    </div>
  `.trim();
  
  //card title codes
  const titleInput = card.querySelector('.title-input');
  titleInput.addEventListener('change', async () => {
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

  // keyboard: Enter toggles select, Space toggles select (prevent page scroll)
  card.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      selectCard(card);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectCard(card);
    }
  });

  return card;
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

function parsePercent(valueStr) {
  if (valueStr == null) return null;
  const s = String(valueStr).trim().replace(',', '.').replace('%', '');
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  return parseFloat(m[0]);
}

// status logic: GREEN if 30-70 inclusive, ORANGE if <30, RED if >70
function setStatusColor(valueNum, valueEl, dotEl) {
  // remove any previous status classes
  dotEl.classList.remove('status-green', 'status-orange', 'status-red');
  valueEl.classList.remove('muted');

  // unknown / invalid => red + muted
  if (valueNum == null || isNaN(valueNum)) {
    dotEl.classList.add('status-red');
    valueEl.classList.add('muted');
    return;
  }

  if (valueNum >= 30 && valueNum <= 70) {
    dotEl.classList.add('status-green');
  } else if (valueNum < 30) {
    dotEl.classList.add('status-orange');
  } else { // valueNum > 70
    dotEl.classList.add('status-red');
  }
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

  // UI state
  if (showSpinner) spinner.style.display = 'inline-block';
  errorWrap.style.display = 'none';
  valueEl.classList.add('skeleton', 'muted');
  valueEl.textContent = ' ';

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

    setStatusColor(numeric, valueEl, dotEl);

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
}

// Build all cards and start polling
function init() {
  // prevent starting if not authenticated (for this page load)
  if (!isLoggedIn()) {
    return;
  }

  // mark started so subsequent events don't re-run init
  window._app_started = true;

  if (!tanksContainer) return;

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

  // Polling: subsequent refreshes will NOT show the spinner (silent updates)
  setInterval(refreshAll, POLL_INTERVAL_MS);
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
        const terminalId = cardEl.dataset.terminal;
        const device = devices.find(d => d.id === terminalId) || {};
        showHistoryModal(terminalId, device.name);
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
      const labels = currentRows.map(r => r.timestamp);
      const values = currentRows.map(r => (r.tank_level === null ? NaN : Number(r.tank_level)));
      createChart(labels, values, chartCanvas);
      // auto-populate start/end inputs with actual range (optional)
      const firstTs = currentRows[0] && currentRows[0].timestamp ? Date.parse(currentRows[0].timestamp) : null;
      const lastTs = currentRows[currentRows.length-1] && currentRows[currentRows.length-1].timestamp ? Date.parse(currentRows[currentRows.length-1].timestamp) : null;
      if (firstTs && lastTs) {
        // set inputs to reflect actual loaded range
        if (startInput && endInput) {
          startInput.value = toDatetimeLocalValue(firstTs);
          endInput.value = toDatetimeLocalValue(lastTs);
        }
      }
    } catch (err) {
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
        const safe = sanitizeFilename(title) || `${terminalId}_history`;
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
        const safe = sanitizeFilename(title) || `${terminalId}_history`;
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

  // NOTE: createChart accepts the chartCanvas element so it can be called from multiple places. It will set _activeChart.
  function createChart(labels, values, canvasEl) {
    if (_activeChart) {
      try { _activeChart.destroy(); } catch(e) { /* ignore */ }
      _activeChart = null;
    }

    const ctx = canvasEl.getContext('2d');

    // Prepare dataset: Chart.js time axis will parse ISO strings and display in local timezone via luxon adapter
    const data = labels.map((lab, i) => ({ x: lab, y: (values[i] === null ? NaN : values[i]) }));

    const cfg = {
      type: 'line',
      data: {
        datasets: [{
          label: 'Tank level (%)',
          data,
          parsing: { xAxisKey: 'x', yAxisKey: 'y' },
          fill: true,
          // purple-ish blue theme:
          borderColor: 'rgba(88,86,214,0.95)',
          backgroundColor: 'rgba(88,86,214,0.12)',
          pointBackgroundColor: 'rgba(88,86,214,0.95)',
          pointBorderColor: '#ffffff',
          pointRadius: Math.min(3, Math.round(1200 / Math.max(1, data.length * 0.5))),
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
              // Custom title: show "Day Month Year" then the hour (keep hour format unchanged)
              title: function(tooltipItems) {
                if (!tooltipItems || tooltipItems.length === 0) return '';
                const item = tooltipItems[0];
                const rawX = (item.parsed && item.parsed.x !== undefined) ? item.parsed.x : item.label;

                // Try Luxon first (loaded on the page). Fallback to Date.
                const DateTime = (window.luxon && window.luxon.DateTime) ? window.luxon.DateTime : null;
                let dt = null;
                if (DateTime) {
                  if (typeof rawX === 'number') {
                    dt = DateTime.fromMillis(rawX);
                  } else {
                    dt = DateTime.fromISO(String(rawX));
                    if (!dt.isValid) dt = DateTime.fromMillis(Date.parse(String(rawX)));
                  }
                  if (dt && dt.isValid) {
                    // "dd LLL yyyy" (Day Month Year) + space + time as "hh:mm a" (keeps AM/PM form)
                    return dt.toFormat('dd LLL yyyy') + ' ' + dt.toFormat('hh:mm a');
                  }
                }

                // Fallback using native Date
                const parsedMs = (typeof rawX === 'number') ? rawX : Date.parse(String(rawX));
                if (!isNaN(parsedMs)) {
                  const d = new Date(parsedMs);
                  const dd = String(d.getDate()).padStart(2, '0');
                  const monthShort = d.toLocaleString(undefined, { month: 'short' }); // e.g. "Jan"
                  const yyyy = d.getFullYear();
                  const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
                  // "06 Jan 2026 12:09 PM"
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
    const firstTs = data.length ? Date.parse(data[0].x) : null;
    const lastTs = data.length ? Date.parse(data[data.length - 1].x) : null;
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
        return toMillis(raw);
      } catch (e) {
        const area = _activeChart.chartArea;
        const left = area.left;
        const right = area.right;
        const minRaw = _activeChart.scales.x.min ?? _activeChart.scales.x.getValueForPixel(left);
        const maxRaw = _activeChart.scales.x.max ?? _activeChart.scales.x.getValueForPixel(right);
        const minMs = toMillis(minRaw);
        const maxMs = toMillis(maxRaw);
        const ratio = (pixelX - left) / (right - left);
        return minMs + (ratio * (maxMs - minMs));
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
  }

  // On open: prefill start/end to "last hour" (NOW and NOW - 1 hour), then auto-load that range.
  try {
    const nowMs = Date.now();
    const oneHourAgoMs = nowMs - 60 * 60 * 1000;
    if (startInput && endInput) {
      startInput.value = toDatetimeLocalValue(oneHourAgoMs);
      endInput.value = toDatetimeLocalValue(nowMs);
    }
    // Immediately load last hour
    loadRange({ startMs: oneHourAgoMs, endMs: nowMs });
  } catch (e) {
    // fallback: load default last 500 rows
    loadRange({ limit: 500 });
  }
}

/* ---------------------------
   Init
   --------------------------- */
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
