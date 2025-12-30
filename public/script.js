// Devices to display — edit friendly names or IDs here
const devices = [
  { id: "230347", name: "ZERO.1 A — ZN000000099657" },
  { id: "230344", name: "ZERO.1 B — ZN000000104508" },
  { id: "230348", name: "ZERO.1 C — ZN000000103596" },
  { id: "230345", name: "ZERO.1 D — ZN000000104344" },
  { id: "230346", name: "ZERO.1 E — ZN000000104482" },
  { id: "231544", name: "ZN000000104512" } // <-- new device added
];

// Poll interval in milliseconds (adjust as needed)
// Set to 20000 (20s) to match your observed interval; change if desired.
const POLL_INTERVAL_MS = 20000;

const tanksContainer = document.getElementById('tanks');
const globalErrorEl = document.getElementById('global-error');

// Create a card element for a device
function createCard(device) {
  const card = document.createElement('article');
  card.className = 'card tank-card';
  card.dataset.terminal = device.id;

  card.innerHTML = `
    <div class="card-top">
      <div class="device-name">${escapeHtml(device.name)}</div>
      <div class="card-spinner" aria-hidden="true" style="display:none;"></div>
    </div>

    <div class="result-header">
      <div class="value-unit">
        <div class="value">--</div>
        <div class="unit">%</div>
      </div>
    </div>

    <div class="meta">
      <div><strong>Terminal ID:</strong> <span class="term">${escapeHtml(device.id)}</span></div>
      <div><strong>Timestamp:</strong> <span class="time">-</span></div>
    </div>

    <div class="card-footer">
      <div class="card-error" style="display:none;color:#ffdede;margin-top:8px;"></div>
    </div>
  `.trim();

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

// Fetch data for a single card and update UI
// showSpinner: boolean to force showing the spinner for this fetch (used for initial load)
async function fetchAndUpdate(device, cardEl, showSpinner = false) {
  const spinner = cardEl.querySelector('.card-spinner');
  const errorEl = cardEl.querySelector('.card-error');
  const valueEl = cardEl.querySelector('.value');
  const timeEl = cardEl.querySelector('.time');

  // UI state
  errorEl.style.display = 'none';
  if (showSpinner) spinner.style.display = 'inline-block';

  try {
    const url = `/api/tank?terminalId=${encodeURIComponent(device.id)}`;
    const resp = await fetch(url, { cache: 'no-store' });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || err.message || resp.statusText || `HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const value = data.value;
    const timestamp = data.timestamp;

    const d = new Date(timestamp);
    if (isNaN(d.getTime())) throw new Error('Invalid timestamp returned: ' + timestamp);

    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
    const timeFormatted = `${dd}-${mm}-${yyyy} ${timeStr}`;

    valueEl.textContent = value;
    timeEl.textContent = timeFormatted;
  } catch (err) {
    errorEl.textContent = err.message || 'Unknown error';
    errorEl.style.display = 'block';
  } finally {
    // Hide spinner after the fetch completes (only visible when showSpinner === true)
    if (showSpinner) spinner.style.display = 'none';
    // Mark device as "initial-loaded" so future polls don't show the spinner again
    device._initialLoaded = true;
  }
}

// Build all cards and start polling
function init() {
  if (!tanksContainer) return;

  // Clear container
  tanksContainer.innerHTML = '';

  // Build cards for all devices
  devices.forEach(device => {
    const card = createCard(device);
    tanksContainer.appendChild(card);
  });

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

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
