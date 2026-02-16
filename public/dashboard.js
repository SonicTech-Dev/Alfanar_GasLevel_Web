(function () {
  // Poll interval and keys
  const POLL_INTERVAL_MS = 30000;
  const VIEW_KEY = 'tank_view_mode';

  // Colors for map markers (site theme)
  const COLORS = {
    accent: '#06B6D4', // site accent
    red:    '#ef4444', // danger
    gray:   '#6b7280'  // muted
  };

  // DOM refs
  const mapEl = document.getElementById('dashboard-map');
  const mapMsg = document.getElementById('map-msg');
  const alertsListEl = document.getElementById('alerts-list');
  const alertsCountEl = document.getElementById('alerts-count');
  const sumTotalEl = document.getElementById('sum-total');
  const sumNormalEl = document.getElementById('sum-normal');
  const sumAboveEl = document.getElementById('sum-above');
  const sumUnderEl = document.getElementById('sum-under');
  const devicesCountEl = document.getElementById('map-devices-count');

  // Location panel refs
  const locationPanel = document.getElementById('location-panel');
  const summaryPanel = document.getElementById('summary-panel');
  const locOpenBtn = document.getElementById('loc-open-btn');
  const locEmpty = document.getElementById('loc-empty');
  const locProjectName = document.getElementById('loc-project-name');
  const locProjectCode = document.getElementById('loc-project-code');
  const locEmirate = document.getElementById('loc-emirate');
  const locBuilding = document.getElementById('loc-building');
  const locAddress = document.getElementById('loc-address');

  // Header buttons
  const backListBtn = document.getElementById('back-list');
  const backCardsBtn = document.getElementById('back-cards');

  // Gas Details panel refs
  const gasRefreshBtn = document.getElementById('gas-refresh-btn');
  const gasTbody = document.getElementById('gas-details-tbody');
  const gasNote = document.getElementById('gas-note');

  // In-memory catalog of devices keyed by terminal_id
  const devices = new Map();

  let leafletMap = null;
  let leafletMarkers = [];

  // Load Leaflet safely (no-op if already present)
  function ensureLeaflet() {
    return new Promise((resolve) => {
      if (window.L) return resolve(window.L);
      const wait = () => {
        if (window.L) resolve(window.L);
        else setTimeout(wait, 50);
      };
      wait();
    });
  }

  // Fetch helpers
  async function fetchJson(url) {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j.error || resp.statusText || `HTTP ${resp.status}`);
    }
    return resp.json();
  }

  // Build unified catalog from sites + titles + tank_info
  async function loadCatalog() {
    const sites = await fetchJson('/api/sites').catch(() => ({ rows: [] }));
    const titles = await fetchJson('/api/titles').catch(() => ([]));
    const infos = await fetchJson('/api/tank-info').catch(() => ({ rows: [] }));

    const titleMap = new Map((titles || []).map(r => [String(r.terminal_id), r]));
    const infoMap = new Map((infos.rows || []).map(r => [String(r.terminal_id), r]));

    (sites.rows || []).forEach(s => {
      const tid = String(s.terminal_id);
      const t = titleMap.get(tid);
      const i = infoMap.get(tid);
      devices.set(tid, {
        terminal_id: tid,
        title: (t && t.tank_title) || '',
        sn: (t && t.sn) || '',
        site: s.site || '',
        locationLink: s.location || '',
        lat: (typeof s.latitude === 'number') ? s.latitude : null,
        lng: (typeof s.longitude === 'number') ? s.longitude : null,
        emirate: i ? (i.emirate || '') : '',
        project_code: i ? (i.project_code || '') : '',
        building_name: i ? (i.building_name || '') : '',
        address: i ? (i.address || '') : '',
        lpg_min_level: i && i.lpg_min_level != null ? Number(i.lpg_min_level) : null,
        lpg_max_level: i && i.lpg_max_level != null ? Number(i.lpg_max_level) : null,
        lpg_tank_capacity: i ? (i.lpg_tank_capacity || '') : '',
        _lastValueNumeric: null,
        _lastTimestamp: null
      });
    });

    // Include any terminal present only in tank_info (no coords)
    (infos.rows || []).forEach(i => {
      const tid = String(i.terminal_id);
      if (devices.has(tid)) return;
      const t = titleMap.get(tid);
      devices.set(tid, {
        terminal_id: tid,
        title: (t && t.tank_title) || '',
        sn: (t && t.sn) || '',
        site: '',
        locationLink: '',
        lat: null,
        lng: null,
        emirate: i.emirate || '',
        project_code: i.project_code || '',
        building_name: i.building_name || '',
        address: i.address || '',
        lpg_min_level: i.lpg_min_level != null ? Number(i.lpg_min_level) : null,
        lpg_max_level: i.lpg_max_level != null ? Number(i.lpg_max_level) : null,
        lpg_tank_capacity: i.lpg_tank_capacity || '',
        _lastValueNumeric: null,
        _lastTimestamp: null
      });
    });

    // Titles only fallback
    if (devices.size === 0 && (titles || []).length) {
      titles.forEach(t => {
        const tid = String(t.terminal_id);
        devices.set(tid, {
          terminal_id: tid,
          title: t.tank_title || '',
          sn: t.sn || '',
          site: '',
          locationLink: '',
          lat: null, lng: null,
          emirate: '',
          project_code: '',
          building_name: '',
          address: '',
          lpg_min_level: null,
          lpg_max_level: null,
          lpg_tank_capacity: '',
          _lastValueNumeric: null,
          _lastTimestamp: null
        });
      });
    }
  }

  // Fetch live level for a device
  async function refreshLevelFor(tid) {
    try {
      const j = await fetchJson(`/api/tank?terminalId=${encodeURIComponent(tid)}`);
      const val = parsePercent(j && j.value);
      const ts = j && j.timestamp ? String(j.timestamp) : null;
      const d = devices.get(String(tid));
      if (d) {
        d._lastValueNumeric = (val == null || isNaN(val)) ? null : Number(val);
        d._lastTimestamp = ts;
      }
    } catch {
      const d = devices.get(String(tid));
      if (d) d._lastTimestamp = d._lastTimestamp || null;
    }
  }

  // Light parsing helpers
  function parsePercent(valueStr) {
    if (valueStr == null) return null;
    const s = String(valueStr).trim().replace(',', '.').replace('%', '');
    const m = s.match(/-?\d+(\.\d+)?/);
    if (!m) return null;
    return parseFloat(m[0]);
  }

  // Threshold status
  // returns 'min' | 'max' | 'normal' | 'unknown'
  function thresholdStatusForDevice(d) {
    const val = d._lastValueNumeric;
    const min = (d.lpg_min_level != null) ? Number(d.lpg_min_level) : null;
    const max = (d.lpg_max_level != null) ? Number(d.lpg_max_level) : null;
    if (val == null || isNaN(val) || (min == null && max == null)) return 'unknown';
    if (min != null && !isNaN(min) && val < min) return 'min';
    if (max != null && !isNaN(max) && val > max) return 'max';
    return 'normal';
  }

  // Render map with markers (bigger icon; RED for alarms min/max; ACCENT for normal; GRAY for unknown)
  async function renderMap() {
    if (!mapEl) return;
    mapMsg.textContent = 'Loading map…';
    const L = await ensureLeaflet().catch(() => null);
    if (!L) {
      mapMsg.textContent = 'Failed to load map library.';
      return;
    }
    try {
      if (!leafletMap) {
        leafletMap = L.map(mapEl, { scrollWheelZoom: true }).setView([25.2048, 55.2708], 10);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap contributors'
        }).addTo(leafletMap);
      }
      // Clear existing markers
      leafletMarkers.forEach(m => { try { m.remove(); } catch {} });
      leafletMarkers = [];

      const coords = [];
      devices.forEach(d => {
        if (typeof d.lat === 'number' && typeof d.lng === 'number') coords.push(d);
      });

      coords.forEach(d => {
        const status = thresholdStatusForDevice(d);
        const color = (status === 'min' || status === 'max') ? COLORS.red
                    : (status === 'normal') ? COLORS.accent
                    : COLORS.gray;

        // Bigger, more apparent marker (solid dot with white ring and shadow)
        const icon = L.divIcon({
          html: `
            <div style="
              width: 32px; height: 32px; border-radius: 50%;
              background: ${color};
              border: 3px solid #ffffff;
              box-shadow: 0 0 0 3px rgba(0,0,0,0.12), 0 6px 18px rgba(0,0,0,0.35);
            "></div>
          `,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
          className: '' // prevent default leaflet-icon classes
        });

        const marker = L.marker([d.lat, d.lng], { icon }).addTo(leafletMap);
        const title = (d.title || d.site || d.terminal_id);
        const levelStr = (d._lastValueNumeric == null || isNaN(d._lastValueNumeric)) ? 'N/A' : `${Math.round(d._lastValueNumeric)}%`;
        const popup = `
          <div style="font-weight:700;margin-bottom:6px">${escapeHtml(title)}</div>
          <div style="font-size:12px;color:var(--muted)">SN: ${escapeHtml(d.sn || '—')}</div>
          <div style="margin-top:6px;font-size:12px;">Level: ${escapeHtml(levelStr)}</div>
        `;
        marker.bindPopup(popup);
        marker.on('click', () => {
          // highlight in table by scrolling to row
          const row = document.querySelector(`tr[data-terminal="${d.terminal_id}"]`);
          if (row) {
            try { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { row.scrollIntoView(); }
            row.classList.add('pulse-row');
            setTimeout(() => row.classList.remove('pulse-row'), 1200);
          }
          // populate location panel
          setLocationInfo(d);
        });
        leafletMarkers.push(marker);
      });

      if (coords.length) {
        const group = L.featureGroup(leafletMarkers);
        try { leafletMap.fitBounds(group.getBounds().pad(0.12)); } catch {}
        mapMsg.textContent = '';
      } else {
        mapMsg.textContent = 'No device coordinates available.';
      }
      devicesCountEl.textContent = `${devices.size} devices`;
    } catch (err) {
      mapMsg.textContent = 'Map failed to initialize: ' + (err && err.message);
    }
  }

  // Populate Location panel for a device
  function setLocationInfo(d) {
    if (!d) return;
    // Hide empty message; show fields
    if (locEmpty) locEmpty.style.display = 'none';
    const fields = locationPanel.querySelectorAll('.loc-field');
    fields.forEach(f => { f.style.display = ''; });

    // Project name prefers title, falls back to site or terminal_id
    const projName = (d.title && String(d.title).trim()) ? d.title
                    : (d.site && String(d.site).trim()) ? d.site
                    : d.terminal_id;

    locProjectName.textContent = projName || '—';
    locProjectCode.textContent = (d.project_code && String(d.project_code).trim()) ? d.project_code : '—';
    locEmirate.textContent = (d.emirate && String(d.emirate).trim()) ? d.emirate : '—';
    locBuilding.textContent = (d.building_name && String(d.building_name).trim()) ? d.building_name : '—';
    locAddress.textContent = (d.address && String(d.address).trim()) ? d.address : '—';

    // Open link button
    if (locOpenBtn) {
      if (d.locationLink && String(d.locationLink).trim()) {
        locOpenBtn.href = d.locationLink;
        locOpenBtn.style.display = 'inline-flex';
      } else {
        locOpenBtn.removeAttribute('href');
        locOpenBtn.style.display = 'none';
      }
    }
  }

  // If available, set default location from any device with info
  function setDefaultLocationIfAvailable() {
    for (const d of devices.values()) {
      if ((d.emirate && d.emirate.trim()) || (d.building_name && d.building_name.trim()) || (d.address && d.address.trim())) {
        setLocationInfo(d);
        return;
      }
    }
    // Otherwise keep "select a device" message visible
    if (locEmpty) {
      locEmpty.style.display = '';
      const fields = locationPanel.querySelectorAll('.loc-field');
      fields.forEach(f => { f.style.display = 'none'; });
    }
  }

  // Ensure Location panel does not exceed Summary panel height
  function adjustLocationPanelHeight() {
    try {
      if (!summaryPanel || !locationPanel) return;
      const h = summaryPanel.offsetHeight;
      if (h && h > 0) {
        locationPanel.style.maxHeight = h + 'px';
        locationPanel.style.overflow = 'auto';
      }
    } catch {}
  }

  // Render alerts panel and summary panel
  function renderAlertsAndSummary() {
    let normal = 0;
    let above = 0;
    let under = 0;

    const alertItems = [];

    devices.forEach(d => {
      const st = thresholdStatusForDevice(d);
      if (st === 'normal') normal++;
      else if (st === 'max') {
        above++;
        alertItems.push(buildAlertItem(d, 'Above Maximum'));
      } else if (st === 'min') {
        under++;
        alertItems.push(buildAlertItem(d, 'Under Minimum'));
      }
    });

    // Alerts list (use text-only color classes to avoid background highlight)
    alertsListEl.innerHTML = alertItems.length === 0
      ? `<div class="panel-subtitle" style="padding:8px;">✅ No alerts</div>`
      : alertItems.join('');

    // Alerts count indicator (uppercase + color)
    const totalAlerts = above + under;
    alertsCountEl.textContent = `${totalAlerts} ALERTS`.toUpperCase();
    alertsCountEl.classList.remove('status-red','status-green','status-muted');
    alertsCountEl.classList.add(totalAlerts > 0 ? 'status-red' : 'status-green');

    // Summary table counts
    sumTotalEl.textContent = String(devices.size);
    sumNormalEl.textContent = String(normal);
    sumAboveEl.textContent = String(above);
    sumUnderEl.textContent = String(under);

    // After summary renders, adjust the location panel height cap
    adjustLocationPanelHeight();
  }

  function buildAlertItem(d, label) {
    const valStr = (d._lastValueNumeric == null || isNaN(d._lastValueNumeric)) ? 'N/A' : `${Math.round(d._lastValueNumeric)}%`;
    const minStr = (d.lpg_min_level == null || isNaN(d.lpg_min_level)) ? '—' : `${d.lpg_min_level}%`;
    const maxStr = (d.lpg_max_level == null || isNaN(d.lpg_max_level)) ? '—' : `${d.lpg_max_level}%`;
    const title = d.title || d.site || d.terminal_id;
    return `
      <div class="alert-row" data-terminal="${escapeAttr(d.terminal_id)}">
        <div class="alert-left">
          <div class="name">${escapeHtml(title)}</div>
          <div class="meta">SN: ${escapeHtml(d.sn || '—')}</div>
        </div>
        <div class="alert-right">
          <div class="status status-red">${escapeHtml(label)}</div>
          <div class="meta">Level: ${escapeHtml(valStr)}</div>
          <div class="meta">Min/Max: ${escapeHtml(minStr)} / ${escapeHtml(maxStr)}</div>
        </div>
      </div>
    `;
  }

  // Render devices table
  function renderTable() {
    const tbody = document.getElementById('devices-tbody');
    if (!tbody) return;

    if (devices.size === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="muted">No devices found.</td></tr>`;
      return;
    }

    const rows = [];
    devices.forEach(d => {
      const name = (d.title || d.site || '').trim() || d.terminal_id;
      const projectCode = d.project_code || '';
      const sn = d.sn || '';
      const emirate = d.emirate || '';
      const val = (d._lastValueNumeric == null || isNaN(d._lastValueNumeric)) ? 'N/A' : `${Math.round(d._lastValueNumeric)}%`;
      const status = thresholdStatusForDevice(d);
      const statusClass = status === 'min' ? 'min' : status === 'max' ? 'max' : status === 'normal' ? 'normal' : 'unknown';
      const statusText = status === 'min' ? 'Under Threshold' : status === 'max' ? 'Above Threshold' : status === 'normal' ? 'Normal' : 'Unknown';
      const minStr = (d.lpg_min_level == null || isNaN(d.lpg_min_level)) ? '—' : `${d.lpg_min_level}%`;
      const maxStr = (d.lpg_max_level == null || isNaN(d.lpg_max_level)) ? '—' : `${d.lpg_max_level}%`;

      rows.push(`
        <tr class="list-row" data-terminal="${escapeAttr(d.terminal_id)}">
          <td class="list-project">${escapeHtml(name)}</td>
          <td class="list-project-code">${escapeHtml(projectCode || '—')}</td>
          <td class="list-serial">${escapeHtml(sn || '—')}</td>
          <td class="list-emirate">${escapeHtml(emirate || '—')}</td>
          <td class="list-level">${escapeHtml(val)}</td>
          <td><span class="status-pill ${escapeAttr(statusClass)}">${escapeHtml(statusText)}</span></td>
          <td class="list-capacity">${escapeHtml(minStr)} / ${escapeHtml(maxStr)}</td>
        </tr>
      `);
    });

    tbody.innerHTML = rows.join('');
  }

  // Escape helpers
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
  function escapeAttr(text) {
    return String(text).replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  // Refresh sequence: fetch levels, redraw UI and map
  async function refreshAll() {
    const ids = Array.from(devices.keys());
    await Promise.all(ids.map(tid => refreshLevelFor(tid)));
    renderAlertsAndSummary();
    renderTable();
    renderMap();
    // Ensure summary-height cap applied (in case DOM sizes change after map)
    adjustLocationPanelHeight();
  }

  // Back to List/Cards handlers: set preferred view in localStorage and go home
  function goHome(mode) {
    try { localStorage.setItem(VIEW_KEY, mode); } catch {}
    window.location.href = '/';
  }
  if (backListBtn) {
    backListBtn.addEventListener('click', (e) => { e.stopPropagation(); goHome('list'); });
  }
  if (backCardsBtn) {
    backCardsBtn.addEventListener('click', (e) => { e.stopPropagation(); goHome('cards'); });
  }

  /* ---------------------------
     GAS DETAILS: Fetch and render
     --------------------------- */

  function round2(n) {
    if (n == null || isNaN(n)) return null;
    return Math.round(Number(n) * 100) / 100;
  }

  async function fetchConsumptionAll() {
    return fetchJson('/api/consumption').catch(() => ({ rows: [] }));
  }

  function deviceLabelFor(tid) {
    const d = devices.get(String(tid));
    return d ? (d.title || d.site || d.terminal_id) : String(tid);
  }

  async function refreshGasDetails() {
    if (!gasTbody) return;
    try {
      gasTbody.innerHTML = `<tr><td colspan="6" class="muted">Loading…</td></tr>`;
      const data = await fetchConsumptionAll();
      const rows = Array.isArray(data.rows) ? data.rows : (data.terminal_id ? [data] : []);
      if (!rows.length) {
        gasTbody.innerHTML = `<tr><td colspan="6" class="muted">No data</td></tr>`;
        return;
      }
      const html = rows.map(r => {
        const name = escapeHtml(deviceLabelFor(r.terminal_id));
        const cap = (r.capacity_liters == null || isNaN(r.capacity_liters)) ? 'unknown' : String(round2(r.capacity_liters));
        const dailyLiters = (r.daily && r.daily.liters != null && !isNaN(r.daily.liters)) ? String(round2(r.daily.liters)) : (r.daily && r.daily.percent_drop != null ? `${round2(r.daily.percent_drop)}%` : '—');
        const avgLiters = (r.monthly && r.monthly.average_liters_per_day != null && !isNaN(r.monthly.average_liters_per_day)) ? String(round2(r.monthly.average_liters_per_day)) : (r.monthly && r.monthly.average_percent_per_day != null ? `${round2(r.monthly.average_percent_per_day)}%` : '—');
        const total30 = (r.monthly && r.monthly.total_liters_30d != null && !isNaN(r.monthly.total_liters_30d)) ? String(round2(r.monthly.total_liters_30d)) : (r.monthly && r.monthly.total_percent_30d != null ? `${round2(r.monthly.total_percent_30d)}%` : '—');
        const daysInc = (r.monthly && r.monthly.days_included != null) ? String(r.monthly.days_included) : '—';
        return `
          <tr>
            <td class="muted">${name}</td>
            <td class="muted">${cap}</td>
            <td>${dailyLiters}</td>
            <td>${avgLiters}</td>
            <td>${total30}</td>
            <td class="muted">${daysInc}</td>
          </tr>
        `;
      }).join('');
      gasTbody.innerHTML = html;
    } catch (err) {
      gasTbody.innerHTML = `<tr><td colspan="6" class="muted">Failed to load gas details: ${escapeHtml(err && err.message || 'Unknown')}</td></tr>`;
    }
  }

  if (gasRefreshBtn) {
    gasRefreshBtn.addEventListener('click', (e) => { e.stopPropagation(); refreshGasDetails(); });
  }

  // Init flow
  (async function initDashboard() {
    try {
      await loadCatalog();
      setDefaultLocationIfAvailable();
      await refreshAll();
      await refreshGasDetails();
      setInterval(() => { refreshAll().catch(() => {}); }, POLL_INTERVAL_MS);
    } catch (err) {
      try {
        const tbody = document.getElementById('devices-tbody');
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="muted">Failed to load dashboard: ${escapeHtml(err && err.message || 'Unknown error')}</td></tr>`;
      } catch {}
    }
  })();
})();
