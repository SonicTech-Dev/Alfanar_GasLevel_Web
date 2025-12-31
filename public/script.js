// Devices to display — edit friendly names or IDs here
let devices = [
  { id: "230347", name: "ZERO.1 A — ZN000000099657" },
  { id: "230344", name: "ZERO.1 B — ZN000000104508" },
  { id: "230348", name: "ZERO.1 C — ZN000000103596" },
  { id: "230345", name: "ZERO.1 D — ZN000000104344" },
  { id: "230346", name: "ZERO.1 E — ZN000000104482" },
  { id: "231544", name: "ZERO.1 F — ZN000000104512" }
];

// Poll interval in milliseconds
const POLL_INTERVAL_MS = 20000;

const tanksContainer = document.getElementById('tanks');
const globalErrorEl = document.getElementById('global-error');
const ORDER_KEY = 'tank_order_v1';

let selectedCard = null; // for keyboard-only reordering

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
    </div>
  `.trim();

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
   Init
   --------------------------- */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
