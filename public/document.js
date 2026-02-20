// Document Tracker (SQL-backed) front-end
// Exposes global functions used by inline HTML: showScreen, toggleSidebar, getCurrentScreen,
// filterAlerts, applyFilters, exportToCSV, exportToExcel, exportToPDF, openEditModal, closeEditModal, saveEdit, reloadDocumentTracker.
//
// CHANGE: SN is now auto-generated server-side for new sites. The edit modal no longer includes an SN input,
// and saveEdit does not send an SN in the payload.
//
// NEW: Treat "unknown" (missing/invalid date) as "expired" across the UI.
// - Dashboard per-document tiles: Expired = Total − Valid − Renewal (unknown absorbed into expired).
// - Map/List aggregated status: if any document is unknown, the site is considered expired.
// - Alerts: unknown (no date) entries are listed as expired with a clear message.
// NEW: List view Exp/Ren/Val columns show per-site counts (unknown counted as expired). Also included in CSV/Excel/PDF exports.
//
// NEW (dashboard drill-down):
// - renewalDocs: array of individual documents with status "renewal" (for TOTAL DOCUMENTS UNDER RENEWAL card).
// - expiredDocs: array of individual documents with status "expired" or "unknown" (for TOTAL DOCUMENTS EXPIRED card).
// Both are rebuilt in refreshDashboard() to keep counts and lists in sync.
//
// NEW: File upload support for 5 document types, stored as BYTEA in Postgres.
// - Upload endpoints: POST /api/tank-documents/:id/upload/:type (type in {istifaa, amc, doe_noc, coc, tpi}).
// - Download endpoints: GET /api/tank-documents/:id/file/:type.
//
// NEW: Separate "Documents" modal for uploads/downloads; main edit modal is only for site + expiry info.
// NEW: Delete buttons in documents modal, implemented by uploading an empty file for that type.

(function(){
  const API = {
    list: async (q = '') => {
      const url = q ? `/api/tank-documents?q=${encodeURIComponent(q)}&limit=2000` : '/api/tank-documents?limit=2000';
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('Failed to load documents');
      return r.json();
    },
    get: async (id) => {
      const r = await fetch(`/api/tank-documents/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('Failed to load record');
      return r.json();
    },
    createOrUpsert: async (payload) => {
      const r = await fetch('/api/tank-documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || 'Save failed');
      }
      return r.json();
    },
    update: async (id, payload) => {
      const r = await fetch(`/api/tank-documents/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || 'Update failed');
      }
      return r.json();
    },
    remove: async (id) => {
      const r = await fetch(`/api/tank-documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('Delete failed');
      return r.json();
    },
    bulkImport: async (rows) => {
      const r = await fetch('/api/tank-documents/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows })
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || 'Import failed');
      }
      return r.json();
    },
    uploadFile: async (id, type, file) => {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`/api/tank-documents/${encodeURIComponent(id)}/upload/${encodeURIComponent(type)}`, {
        method: 'POST',
        body: fd
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || 'Upload failed');
      }
      return r.json();
    }
  };

  const state = {
    rows: [],
    filtered: [],
    allValidSites: [],
    allNotValidSites: [],
    renewalDocs: [],
    expiredDocs: []
  };

  function statusFromDate(isoDate) {
    if (!isoDate) return 'unknown';
    const s = String(isoDate);
    const d = new Date(s.includes('T') ? s : (s + 'T00:00:00Z'));
    if (isNaN(d.getTime())) return 'unknown';
    const today = new Date();
    const diffDays = Math.ceil((d.getTime() - today.getTime()) / 86400000);
    if (diffDays < 0) return 'expired';
    if (diffDays <= 30) return 'renewal';
    return 'valid';
  }

  function toUiDate(v) {
    if (v == null || v === '') return '';
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s.includes('T') ? s : (s + 'T00:00:00Z'));
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }

  function aggregatedStatus(r) {
    const all = [
      statusFromDate(r.istifaa_expiry_date),
      statusFromDate(r.amc_expiry_date),
      statusFromDate(r.doe_noc_expiry_date),
      statusFromDate(r.coc_expiry_date),
      statusFromDate(r.tpi_expiry_date),
    ];
    const hasExpired = all.includes('expired');
    const hasUnknown = all.includes('unknown');
    const hasRenewal = all.includes('renewal');
    const hasValid = all.includes('valid');

    if (hasExpired || hasUnknown) return 'expired';
    if (hasRenewal) return 'renewal';
    if (hasValid) return 'valid';
    return 'unknown';
  }

  function allDocumentsValidStrict(r) {
    const statuses = [
      statusFromDate(r.istifaa_expiry_date),
      statusFromDate(r.amc_expiry_date),
      statusFromDate(r.doe_noc_expiry_date),
      statusFromDate(r.coc_expiry_date),
      statusFromDate(r.tpi_expiry_date),
    ];
    return statuses.every(s => s === 'valid');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
  }

  function fmtDate(d) {
    if (!d) return '—';
    const s = String(d);
    const parsed = new Date(s.includes('T') ? s : (s + 'T00:00:00Z'));
    return isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString();
  }

  function docStateCounts(row) {
    const statuses = [
      statusFromDate(row.istifaa_expiry_date),
      statusFromDate(row.amc_expiry_date),
      statusFromDate(row.doe_noc_expiry_date),
      statusFromDate(row.coc_expiry_date),
      statusFromDate(row.tpi_expiry_date),
    ];
    let expired = 0, renewal = 0, valid = 0;
    statuses.forEach(s => {
      if (s === 'expired' || s === 'unknown') expired++;
      else if (s === 'renewal') renewal++;
      else if (s === 'valid') valid++;
    });
    return { expired, renewal, valid };
  }

  let fullMap = null;
  function ensureMap() {
    if (fullMap) return;
    fullMap = L.map('fullMap').setView([24.4539,54.3773], 8);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap',maxZoom:19}).addTo(fullMap);
  }
  function refreshMap() {
    const mapEl = document.getElementById('fullMap');
    if (!mapEl) return;
    ensureMap();
    fullMap.eachLayer(l => { if (l instanceof L.Marker) fullMap.removeLayer(l); });
    const layers = [];
    state.filtered.forEach(p => {
      if (typeof p.latitude === 'number' && typeof p.longitude === 'number') {
        const s = aggregatedStatus(p);
        const color = s === 'expired' ? '#e53e3e' : s === 'renewal' ? '#ed8936' : '#48bb78';
        const icon = L.divIcon({
          html:`<div style="width:32px;height:32px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 0 0 2px ${color},0 6px 18px rgba(0,0,0,0.35)"></div>`,
          iconSize:[32,32], iconAnchor:[16,16]
        });
        const m = L.marker([p.latitude, p.longitude], { icon }).addTo(fullMap);
        const hasFilesCount =
          (p.istifaa_has_file ? 1 : 0) +
          (p.amc_has_file ? 1 : 0) +
          (p.doe_noc_has_file ? 1 : 0) +
          (p.coc_has_file ? 1 : 0) +
          (p.tpi_has_file ? 1 : 0);

        m.bindPopup(`<div style="min-width:240px">
          <div style="font-weight:700">${escapeHtml(p.building_name || p.building_code || '')}</div>
          <div style="font-size:12px;margin-top:6px;">
            Status: <strong>${escapeHtml(aggregatedStatus(p).toUpperCase())}</strong>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:6px;">
            ISTIFAA: ${fmtDate(p.istifaa_expiry_date)} · AMC: ${fmtDate(p.amc_expiry_date)} · DOE NOC: ${fmtDate(p.doe_noc_expiry_date)} · COC: ${fmtDate(p.coc_expiry_date)} · TPI: ${fmtDate(p.tpi_expiry_date)}
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:6px;">
            Files attached: ${hasFilesCount} / 5
          </div>
        </div>`);
        layers.push(m);
      }
    });
    if (layers.length) {
      const g = L.featureGroup(layers);
      try { fullMap.fitBounds(g.getBounds().pad(0.12)); } catch {}
    }
    setTimeout(() => { try { fullMap.invalidateSize(); } catch {} }, 150);
  }

  function updateAlerts(prefix, rowsOverride) {
    const rowsSrc = Array.isArray(rowsOverride) ? rowsOverride : state.filtered;

    const listEl = document.getElementById(prefix+'AlertsList');
    const expired = [];
    const today = new Date();

    rowsSrc.forEach(r => {
      const entries = [
        ['Istifaa', r.istifaa_expiry_date],
        ['AMC', r.amc_expiry_date],
        ['DOE NOC', r.doe_noc_expiry_date],
        ['COC', r.coc_expiry_date],
        ['TPI', r.tpi_expiry_date]
      ];
      entries.forEach(([name, d]) => {
        const hasDate = !!d && !isNaN(new Date((String(d).includes('T') ? d : (d + 'T00:00:00Z'))).getTime());
        if (hasDate) {
          const dd = new Date((String(d).includes('T') ? d : (d + 'T00:00:00Z')));
          const days = Math.ceil((dd - today) / 86400000);
          if (days <= 30) {
            expired.push({
              projectName: r.building_name || r.building_code || r.sn,
              docName: name,
              expiryDate: d,
              message: (days < 0) ? `Expired ${Math.abs(days)} days ago` : `Expires in ${days} days`,
              alertClass: (days <= 7) ? 'critical' : 'warning',
              badgeClass: (days <= 7) ? 'badge-expired' : 'badge-warning',
              priority: days
            });
          }
        } else {
          expired.push({
            projectName: r.building_name || r.building_code || r.sn,
            docName: name,
            expiryDate: null,
            message: 'Expired (no date provided)',
            alertClass: 'critical',
            badgeClass: 'badge-expired',
            priority: -1
          });
        }
      });
    });
    expired.sort((a,b) => a.priority - b.priority);
    if (listEl) {
      listEl.innerHTML = expired.length === 0
        ? '<div style="padding:30px 15px;text-align:center;color:var(--muted);font-size:12px">✅ No alerts</div>'
        : expired.map(a => `<div class="alert-item ${a.alertClass}" onclick="openEditModalByName('${escapeHtml(a.projectName)}')"><h3>${escapeHtml(a.projectName)}</h3><p><strong>${escapeHtml(a.docName)}</strong></p><p>Expiry: ${fmtDate(a.expiryDate)}</p><span class="alert-badge ${a.badgeClass}">${escapeHtml(a.message)}</span></div>`).join('');
    }
    const expCount = expired.filter(e => e.priority < 0).length;
    const expiring = expired.filter(e => e.priority >= 0).length;
    const totalSpanExpired = document.getElementById(prefix+'-stat-expired');
    const totalSpanExpiring = document.getElementById(prefix+'-stat-expiring');
    const totalSpanTotal = document.getElementById(prefix+'-stat-total');
    if (totalSpanExpired) totalSpanExpired.textContent = expCount;
    if (totalSpanExpiring) totalSpanExpiring.textContent = expiring;
    if (totalSpanTotal) totalSpanTotal.textContent = rowsSrc.length;
  }

  function refreshDashboard() {
    const sourceRows = state.rows;

    const types = ['istifaa','amc','doe_noc','coc','tpi'];
    const byType = Object.fromEntries(types.map(t => [t, { expired:0, renewal:0, valid:0, unknown:0 }]));

    const renewalDocs = [];
    const expiredDocs = [];

    sourceRows.forEach(r => {
      const statusMap = {
        istifaa: statusFromDate(r.istifaa_expiry_date),
        amc: statusFromDate(r.amc_expiry_date),
        doe_noc: statusFromDate(r.doe_noc_expiry_date),
        coc: statusFromDate(r.coc_expiry_date),
        tpi: statusFromDate(r.tpi_expiry_date),
      };

      types.forEach(t => {
        const st = statusMap[t];
        byType[t][st] = (byType[t][st] || 0) + 1;
      });

      const docDefs = [
        ['istifaa', 'ISTIFAA', r.istifaa_expiry_date],
        ['amc', 'AMC', r.amc_expiry_date],
        ['doe_noc', 'DOE NOC', r.doe_noc_expiry_date],
        ['coc', 'COC', r.coc_expiry_date],
        ['tpi', 'TPI', r.tpi_expiry_date],
      ];

      docDefs.forEach(([key, label, dateVal]) => {
        const st = statusMap[key];
        if (st === 'renewal') {
          renewalDocs.push({
            sn: r.sn || '',
            building_type: r.building_type || '',
            building_name: r.building_name || '',
            building_code: r.building_code || '',
            document_type: label,
            expiry_date: toUiDate(dateVal),
            status: 'renewal'
          });
        } else if (st === 'expired' || st === 'unknown') {
          expiredDocs.push({
            sn: r.sn || '',
            building_type: r.building_type || '',
            building_name: r.building_name || '',
            building_code: r.building_code || '',
            document_type: label,
            expiry_date: toUiDate(dateVal),
            status: 'expired'
          });
        }
      });
    });

    state.renewalDocs = renewalDocs;
    state.expiredDocs = expiredDocs;

    const boxes = document.getElementById('dashboardBoxes');
    if (!boxes) return;
    const title = { istifaa:'ISTIFAA', amc:'AMC', doe_noc:'DOE NOC', coc:'COC', tpi:'TPI' };
    let html = '';
    types.forEach(t => {
      const s = byType[t];
      const total = (s.expired + s.renewal + s.valid + s.unknown);
      const expiredDisplay = Math.max(0, total - s.valid - s.renewal);
      html += `
        <div class="dashboard-card" style="border-top:4px solid var(--accent)">
          <h4 style="font-size:13px;margin-bottom:12px;color:var(--accent);font-weight:700">${title[t]}</h4>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;text-align:center">
            <div><div style="font-size:24px;font-weight:800;color:#e53e3e">${expiredDisplay}</div><div style="font-size:10px;color:var(--muted)">Expired</div></div>
            <div><div style="font-size:24px;font-weight:800;color:#ed8936">${s.renewal}</div><div style="font-size:10px;color:var(--muted)">Renewal</div></div>
            <div><div style="font-size:24px;font-weight:800;color:#48bb78">${s.valid}</div><div style="font-size:10px;color:var(--muted)">Valid</div></div>
          </div>
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.04);text-align:center">
            <span style="font-size:11px;color:var(--muted)">Total: <strong style="color:var(--text)">${total}</strong></span>
          </div>
        </div>
      `;
    });

    boxes.innerHTML = html;

    let strictValidCount = 0;
    let allNotValidCount = 0;
    let totalDocsRenewal = 0;
    let totalDocsExpired = 0;

    const allValidSites = [];
    const allNotValidSites = [];

    sourceRows.forEach(r => {
      const statuses = [
        statusFromDate(r.istifaa_expiry_date),
        statusFromDate(r.amc_expiry_date),
        statusFromDate(r.doe_noc_expiry_date),
        statusFromDate(r.coc_expiry_date),
        statusFromDate(r.tpi_expiry_date),
      ];

      const allValid = statuses.every(s => s === 'valid');
      if (allValid) {
        strictValidCount++;
        allValidSites.push(r);
      }

      const allNotValid = statuses.every(s => s === 'expired' || s === 'unknown');
      if (allNotValid) {
        allNotValidCount++;
        allNotValidSites.push(r);
      }

      statuses.forEach(s => {
        if (s === 'renewal') totalDocsRenewal++;
        if (s === 'expired' || s === 'unknown') totalDocsExpired++;
      });
    });

    state.allValidSites = allValidSites;
    state.allNotValidSites = allNotValidSites;

    const dashContent = document.getElementById('dashboardContent');
    if (dashContent) {
      let bottomRow = document.getElementById('dashboardSummaryBottom');
      if (!bottomRow) {
        bottomRow = document.createElement('div');
        bottomRow.id = 'dashboardSummaryBottom';
        bottomRow.className = 'dashboard-grid';
        dashContent.appendChild(bottomRow);
      }
      const bottomHtml = `
        <div class="dashboard-card" style="border-top:4px solid var(--accent)">
          <h4 style="font-size:13px;margin-bottom:12px;color:var(--accent);font-weight:700">ALL DOCUMENTS VALID</h4>
          <div style="text-align:center;margin-bottom:8px">
            <div style="font-size:28px;font-weight:800;color:#48bb78">${strictValidCount}</div>
            <div style="font-size:10px;color:var(--muted)">Sites with all documents valid</div>
          </div>
          <div style="text-align:center;margin-top:6px">
            <button type="button" class="nav-btn" style="height:30px;font-size:11px;padding:0 10px" onclick="openSummarySitesModal('allValid')">View sites</button>
          </div>
        </div>
        <div class="dashboard-card" style="border-top:4px solid var(--accent)">
          <h4 style="font-size:13px;margin-bottom:12px;color:var(--accent);font-weight:700">ALL DOCUMENTS NOT VALID</h4>
          <div style="text-align:center;margin-bottom:8px">
            <div style="font-size:28px;font-weight:800;color:#e53e3e">${allNotValidCount}</div>
            <div style="font-size:10px;color:var(--muted)">Sites with all documents expired</div>
          </div>
          <div style="text-align:center;margin-top:6px">
            <button type="button" class="nav-btn" style="height:30px;font-size:11px;padding:0 10px" onclick="openSummarySitesModal('allNotValid')">View sites</button>
          </div>
        </div>
        <div class="dashboard-card" style="border-top:4px solid var(--accent)">
          <h4 style="font-size:13px;margin-bottom:12px;color:var(--accent);font-weight:700">TOTAL DOCUMENTS UNDER RENEWAL</h4>
          <div style="text-align:center;margin-bottom:8px">
            <div style="font-size:28px;font-weight:800;color:#ed8936">${totalDocsRenewal}</div>
            <div style="font-size:10px;color:var(--muted)">Total documents expiring within 30 days</div>
          </div>
          <div style="text-align:center;margin-top:6px">
            <button type="button" class="nav-btn" style="height:30px;font-size:11px;padding:0 10px" onclick="openSummarySitesModal('renewalDocs')">View documents</button>
          </div>
        </div>
        <div class="dashboard-card" style="border-top:4px solid var(--accent)">
          <h4 style="font-size:13px;margin-bottom:12px;color:var(--accent);font-weight:700">TOTAL DOCUMENTS EXPIRED</h4>
          <div style="text-align:center;margin-bottom:8px">
            <div style="font-size:28px;font-weight:800;color:#e53e3e">${totalDocsExpired}</div>
            <div style="font-size:10px;color:var(--muted)">Total expired documents</div>
          </div>
          <div style="text-align:center;margin-top:6px">
            <button type="button" class="nav-btn" style="height:30px;font-size:11px;padding:0 10px" onclick="openSummarySitesModal('expiredDocs')">View documents</button>
          </div>
        </div>
      `;
      bottomRow.innerHTML = bottomHtml;
    }

    updateAlerts('dash', sourceRows);
    updateAlerts('map');
    updateAlerts('list');
  }

  function currentFilters() {
    const term = (document.getElementById('filterSearch')?.value || '').toLowerCase().trim();
    const sf = (document.getElementById('filterStatus')?.value || 'all');
    const df = (document.getElementById('filterDocument')?.value || 'all');
    return { term, sf, df };
  }

  function applyFiltersInternal() {
    const { term, sf, df } = currentFilters();
    state.filtered = (state.rows || []).filter(r => {
      if (term) {
        const hay = `${r.sn || ''} ${r.building_name || ''} ${r.building_code || ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      if (sf && sf !== 'all') {
        if (aggregatedStatus(r) !== sf) return false;
      }
      if (df && df !== 'all') {
        const map = {
          istifaa: r.istifaa_expiry_date,
          amc: r.amc_expiry_date,
          doe_noc: r.doe_noc_expiry_date,
          coc: r.coc_expiry_date,
          tpi: r.tpi_expiry_date
        };
        if (!map[df]) return false;
      }
      return true;
    });
  }

  function renderList() {
    const tbody = document.getElementById('projectsTableBody');
    if (!tbody) return;
    const rows = state.filtered;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:30px;color:var(--muted)">No projects found</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const sAny = aggregatedStatus(r);
      const badge =
        sAny === 'expired' ? '<span class="status-badge status-expired">Expired</span>' :
        sAny === 'renewal' ? '<span class="status-badge status-renewal">Renewal</span>' :
        sAny === 'valid' ? '<span class="status-badge status-valid">Valid</span>' :
        '<span class="status-badge status-valid">Unknown</span>';

      const counts = docStateCounts(r);
      const filesCount =
        (r.istifaa_has_file ? 1 : 0) +
        (r.amc_has_file ? 1 : 0) +
        (r.doe_noc_has_file ? 1 : 0) +
        (r.coc_has_file ? 1 : 0) +
        (r.tpi_has_file ? 1 : 0);

      return `
        <tr data-id="${r.id}">
          <td>${escapeHtml(r.sn || '')}</td>
          <td>${escapeHtml(r.building_name || '')}</td>
          <td>${escapeHtml(r.building_code || '')}</td>
          <td>${badge}</td>
          <td>${counts.expired}</td>
          <td>${counts.renewal}</td>
          <td>${counts.valid}</td>
          <td>${filesCount} / 5</td>
          <td>
            <button class="edit-btn" data-action="edit">✏️ Edit</button>
            <button class="edit-btn" data-action="docs">📄 Documents</button>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('button[data-action="edit"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const tr = btn.closest('tr');
        const id = tr ? tr.getAttribute('data-id') : null;
        if (!id) return;
        const row = state.rows.find(x => String(x.id) === String(id));
        openEditModal(row || null);
      });
    });

    tbody.querySelectorAll('button[data-action="docs"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const tr = btn.closest('tr');
        const id = tr ? tr.getAttribute('data-id') : null;
        if (!id) return;
        const row = state.rows.find(x => String(x.id) === String(id));
        openDocsModal(row || null);
      });
    });
  }

  function buildEditForm(row) {
    return `
      <input type="hidden" id="f-id" value="${row?.id ?? ''}">
      <div class="doc-section">
        <h4>Site & Position</h4>
        <div class="form-row">
          <div class="form-group"><label>Facility Type</label><input type="text" id="f-building_type" value="${row?.building_type || ''}"></div>
          <div class="form-group"><label>Building Code</label><input type="text" id="f-building_code" value="${row?.building_code || ''}"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Building Name</label><input type="text" id="f-building_name" value="${row?.building_name || ''}"></div>
          <div class="form-group"><label>Latitude</label><input type="number" step="any" id="f-lat" value="${row?.latitude ?? ''}"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Longitude</label><input type="number" step="any" id="f-lng" value="${row?.longitude ?? ''}"></div>
          <div class="form-group"><label>Notes</label><input type="text" id="f-notes" value="${row?.notes || ''}"></div>
        </div>
      </div>

      <div class="doc-section">
        <h4>Expiry Dates</h4>
        <div class="form-row">
          <div class="form-group"><label>ISTIFAA Exp Date</label><input type="date" id="f-istifaa" value="${toUiDate(row?.istifaa_expiry_date)}"></div>
          <div class="form-group"><label>AMC Exp Date</label><input type="date" id="f-amc" value="${toUiDate(row?.amc_expiry_date)}"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>DOE NOC Exp Date</label><input type="date" id="f-doe" value="${toUiDate(row?.doe_noc_expiry_date)}"></div>
          <div class="form-group"><label>COC Exp Date</label><input type="date" id="f-coc" value="${toUiDate(row?.coc_expiry_date)}"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>TPI Exp Date</label><input type="date" id="f-tpi" value="${toUiDate(row?.tpi_expiry_date)}"></div>
        </div>
      </div>
    `;
  }

  function fillEditInfoHeader(row, isNew) {
    const info = document.getElementById('editProjectInfo');
    if (!info) return;
    info.innerHTML = `
      <h3 style="margin:0 0 4px 0;color:var(--accent);font-size:14px">${isNew ? 'Add site' : escapeHtml(row.building_name || row.building_code || row.sn)}</h3>
      <p style="margin:0;font-size:11px;color:var(--muted)">${isNew ? '' : `SN: ${escapeHtml(row.sn || '')}`}</p>
    `;
  }

  function openEditModal(row) {
    const modal = document.getElementById('editModal');
    const editDocs = document.getElementById('editDocuments');
    if (!modal || !editDocs) return;

    const isNew = !row;
    fillEditInfoHeader(row || {}, isNew);
    editDocs.innerHTML = buildEditForm(row || null);
    modal.style.display = 'block';

    const deleteBtn = document.getElementById('editDeleteBtn');
    if (deleteBtn) {
      if (isNew) {
        deleteBtn.style.display = 'none';
        deleteBtn.onclick = null;
      } else {
        deleteBtn.style.display = '';
        deleteBtn.onclick = async (e) => {
          e.stopPropagation();
          const id = document.getElementById('f-id')?.value || '';
          if (!id) { alert('Record ID not found.'); return; }
          const ok = confirm('Are you sure you want to delete this entry?');
          if (!ok) return;
          try {
            await API.remove(id);
            closeEditModal();
            await reloadAll();
            alert('🗑️ Deleted');
          } catch (err) {
            alert('Delete failed: ' + (err && err.message || 'Unknown'));
          }
        };
      }
    }
  }

  function closeEditModal() {
    const modal = document.getElementById('editModal');
    if (modal) modal.style.display = 'none';
  }

  async function saveEdit(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const id = document.getElementById('f-id')?.value || '';
    const payload = {
      building_type: document.getElementById('f-building_type')?.value?.trim() || '',
      building_code: document.getElementById('f-building_code')?.value?.trim() || '',
      building_name: document.getElementById('f-building_name')?.value?.trim() || '',
      latitude: document.getElementById('f-lat')?.value,
      longitude: document.getElementById('f-lng')?.value,
      istifaa_expiry_date: document.getElementById('f-istifaa')?.value || '',
      amc_expiry_date: document.getElementById('f-amc')?.value || '',
      doe_noc_expiry_date: document.getElementById('f-doe')?.value || '',
      coc_expiry_date: document.getElementById('f-coc')?.value || '',
      tpi_expiry_date: document.getElementById('f-tpi')?.value || '',
      notes: document.getElementById('f-notes')?.value || ''
    };
    try {
      if (id) await API.update(id, payload);
      else await API.createOrUpsert(payload);
      closeEditModal();
      await reloadAll();
      alert('✅ Saved');
    } catch (err) {
      alert('Save failed: ' + (err && err.message));
    }
  }

  function fillDocsInfoHeader(row) {
    const info = document.getElementById('docsProjectInfo');
    if (!info) return;
    info.innerHTML = `
      <h3 style="margin:0 0 4px 0;color:var(--accent);font-size:14px">${escapeHtml(row.building_name || row.building_code || row.sn || '')}</h3>
      <p style="margin:0;font-size:11px;color:var(--muted)">SN: ${escapeHtml(row.sn || '')} · Code: ${escapeHtml(row.building_code || '')}</p>
    `;
  }

  function fillDocsAttachmentInfo(row) {
    const id = row && row.id;
    const docs = [
      { key: 'istifaa', label: 'ISTIFAA', hasProp: 'istifaa_has_file', nameProp: 'istifaa_file_name', tsProp: 'istifaa_file_uploaded_at' },
      { key: 'amc', label: 'AMC', hasProp: 'amc_has_file', nameProp: 'amc_file_name', tsProp: 'amc_file_uploaded_at' },
      { key: 'doe_noc', label: 'DOE NOC', hasProp: 'doe_noc_has_file', nameProp: 'doe_noc_file_name', tsProp: 'doe_noc_file_uploaded_at' },
      { key: 'coc', label: 'COC', hasProp: 'coc_has_file', nameProp: 'coc_file_name', tsProp: 'coc_file_uploaded_at' },
      { key: 'tpi', label: 'TPI', hasProp: 'tpi_has_file', nameProp: 'tpi_file_name', tsProp: 'tpi_file_uploaded_at' },
    ];
    docs.forEach(doc => {
      const infoEl = document.getElementById(`docs-info-${doc.key}`);
      if (!infoEl) return;
      const has = row && row[doc.hasProp];
      const name = row && row[doc.nameProp];
      const ts = row && row[doc.tsProp];
      if (id && has) {
        const url = `/api/tank-documents/${encodeURIComponent(id)}/file/${encodeURIComponent(doc.key)}`;
        infoEl.innerHTML = `
          <div>
            <a href="${url}" target="_blank" style="color:var(--accent);font-size:12px;text-decoration:none;">📄 View ${doc.label} file</a>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px;">
            ${escapeHtml(name || '')}${ts ? ' · Uploaded: ' + fmtDate(ts) : ''}
          </div>
        `;
      } else {
        infoEl.innerHTML = `<span style="font-size:11px;color:var(--muted)">No file uploaded.</span>`;
      }
      const input = document.getElementById(`docs-file-${doc.key}`);
      if (input) input.value = '';
    });
  }

  function openDocsModal(row) {
    const modal = document.getElementById('docsModal');
    if (!modal) return;
    const idInput = document.getElementById('docs-id');
    if (idInput) idInput.value = row && row.id ? row.id : '';
    fillDocsInfoHeader(row || {});
    fillDocsAttachmentInfo(row || {});
    modal.style.display = 'block';

    // Show/hide delete buttons based on whether a file exists
    const docs = [
      { key: 'istifaa', hasProp: 'istifaa_has_file' },
      { key: 'amc', hasProp: 'amc_has_file' },
      { key: 'doe_noc', hasProp: 'doe_noc_has_file' },
      { key: 'coc', hasProp: 'coc_has_file' },
      { key: 'tpi', hasProp: 'tpi_has_file' },
    ];
    docs.forEach(doc => {
      const btn = document.querySelector(`button[data-doc-delete="${doc.key}"]`);
      if (!btn) return;
      const has = row && row[doc.hasProp];
      btn.style.display = has ? '' : 'none';
    });
  }

  function closeDocsModal() {
    const modal = document.getElementById('docsModal');
    if (modal) modal.style.display = 'none';
  }

  async function saveDocs(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const id = document.getElementById('docs-id')?.value || '';
    if (!id) {
      alert('Record ID not found.');
      return;
    }

    const fileInputs = [
      { key: 'istifaa', el: document.getElementById('docs-file-istifaa') },
      { key: 'amc', el: document.getElementById('docs-file-amc') },
      { key: 'doe_noc', el: document.getElementById('docs-file-doe_noc') },
      { key: 'coc', el: document.getElementById('docs-file-coc') },
      { key: 'tpi', el: document.getElementById('docs-file-tpi') },
    ];

    try {
      for (const fi of fileInputs) {
        if (fi.el && fi.el.files && fi.el.files[0]) {
          const file = fi.el.files[0];
          try {
            await API.uploadFile(id, fi.key, file);
          } catch (err) {
            alert(`${fi.key.toUpperCase()} upload failed: ` + (err && err.message || 'Unknown'));
          }
        }
      }
      closeDocsModal();
      await reloadAll();
      alert('✅ Documents updated');
    } catch (err) {
      alert('Save failed: ' + (err && err.message || 'Unknown'));
    }
  }

  // "Delete" file by telling the server to clear the stored file for that type (set SQL columns to NULL)
  async function deleteDocFile(type) {
    const id = document.getElementById('docs-id')?.value || '';
    if (!id) {
      alert('Record ID not found.');
      return;
    }
    const confirmMsg = `Are you sure you want to delete the ${type.toUpperCase()} file?`;
    if (!confirm(confirmMsg)) return;

    try {
      // Call upload endpoint with a special query flag that the server interprets as "clear file"
      const r = await fetch(`/api/tank-documents/${encodeURIComponent(id)}/upload/${encodeURIComponent(type)}?mode=delete`, {
        method: 'POST'
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || 'Delete failed');
      }

      // Reload all rows and update local state
      await reloadAll();
      const row = state.rows.find(x => String(x.id) === String(id));
      if (row) {
        fillDocsAttachmentInfo(row);

        // Update delete button visibility after deletion
        const hasPropMap = {
          istifaa: 'istifaa_has_file',
          amc: 'amc_has_file',
          doe_noc: 'doe_noc_has_file',
          coc: 'coc_has_file',
          tpi: 'tpi_has_file'
        };
        const hasProp = hasPropMap[type];
        const btn = document.querySelector(`button[data-doc-delete="${type}"]`);
        if (btn && hasProp) {
          btn.style.display = row[hasProp] ? '' : 'none';
        }
      }

      alert('🗑️ File deleted');
    } catch (err) {
      alert('Delete failed: ' + (err && err.message || 'Unknown'));
    }
  }

  function filterAlerts(prefix) {
    const term = (document.getElementById(prefix+'SearchAlerts')?.value || '').toLowerCase();
    document.querySelectorAll('#'+prefix+'AlertsList .alert-item').forEach(i => {
      i.style.display = i.textContent.toLowerCase().includes(term) ? 'block' : 'none';
    });
  }

  function exportToCSV() {
    let csv='SN,Building Name,Building Code,ISTIFAA Exp,AMC Exp,DOE NOC Exp,COC Exp,TPI Exp,Exp Count,Ren Count,Val Count,Files Count,Status\n';
    state.filtered.forEach(r=>{
      const s = aggregatedStatus(r);
      const counts = docStateCounts(r);
      const filesCount =
        (r.istifaa_has_file ? 1 : 0) +
        (r.amc_has_file ? 1 : 0) +
        (r.doe_noc_has_file ? 1 : 0) +
        (r.coc_has_file ? 1 : 0) +
        (r.tpi_has_file ? 1 : 0);
      csv+=[
        r.sn || '',
        (r.building_name || '').replace(/"/g,'""'),
        (r.building_code || '').replace(/"/g,'""'),
        r.istifaa_expiry_date || '',
        r.amc_expiry_date || '',
        r.doe_noc_expiry_date || '',
        r.coc_expiry_date || '',
        r.tpi_expiry_date || '',
        counts.expired,
        counts.renewal,
        counts.valid,
        filesCount,
        s
      ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(',') + '\n';
    });
    const blob=new Blob([csv],{type:'text/csv'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download='documents.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportToExcel() {
    const data = state.filtered.map(r => {
      const counts = docStateCounts(r);
      const filesCount =
        (r.istifaa_has_file ? 1 : 0) +
        (r.amc_has_file ? 1 : 0) +
        (r.doe_noc_has_file ? 1 : 0) +
        (r.coc_has_file ? 1 : 0) +
        (r.tpi_has_file ? 1 : 0);
      return {
        'SN': r.sn || '',
        'Building Name': r.building_name || '',
        'Building Code': r.building_code || '',
        'ISTIFAA Exp': r.istifaa_expiry_date || '',
        'AMC Exp': r.amc_expiry_date || '',
        'DOE NOC Exp': r.doe_noc_expiry_date || '',
        'COC Exp': r.coc_expiry_date || '',
        'TPI Exp': r.tpi_expiry_date || '',
        'Exp Count': counts.expired,
        'Ren Count': counts.renewal,
        'Val Count': counts.valid,
        'Files Count': filesCount,
        'Status': aggregatedStatus(r)
      };
    });
    const ws=XLSX.utils.json_to_sheet(data);
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,'Tank Documents');
    XLSX.writeFile(wb,'tank_documents.xlsx');
  }

  function exportToPDF() {
    const { jsPDF } = window.jspdf || {};
    if (!jsPDF) { alert('PDF library not available'); return; }
    const doc=new jsPDF('l','mm','a4');
    doc.setFontSize(18);
    doc.text('Project Document Tracker',14,20);
    doc.setFontSize(10);
    doc.text('Generated: '+new Date().toLocaleDateString(),14,28);
    const data=state.filtered.map(r=>{
      const counts = docStateCounts(r);
      const filesCount =
        (r.istifaa_has_file ? 1 : 0) +
        (r.amc_has_file ? 1 : 0) +
        (r.doe_noc_has_file ? 1 : 0) +
        (r.coc_has_file ? 1 : 0) +
        (r.tpi_has_file ? 1 : 0);
      return [
        r.sn || '',
        (r.building_name || '').substring(0,20),
        r.building_code || '',
        r.istifaa_expiry_date || '',
        r.amc_expiry_date || '',
        r.doe_noc_expiry_date || '',
        r.coc_expiry_date || '',
        r.tpi_expiry_date || '',
        counts.expired,
        counts.renewal,
        counts.valid,
        filesCount,
        aggregatedStatus(r)
      ];
    });
    doc.autoTable({
      startY:35,
      head:[['SN','Name','Code','ISTIFAA','AMC','DOE NOC','COC','TPI','Exp','Ren','Val','Files','Status']],
      body:data,
      theme:'striped',
      headStyles:{fillColor:[102,126,234]},
      styles:{fontSize:7}
    });
    doc.save('tank_documents.pdf');
  }

  const sidebarStates={dash:false,map:false,list:false};
  function getCurrentScreen(){
    if(document.getElementById('dashboard')?.classList.contains('active'))return'dash';
    if(document.getElementById('map')?.classList.contains('active'))return'map';
    if(document.getElementById('list')?.classList.contains('active'))return'list';
    return'dash';
  }
  function toggleSidebar(s){
    sidebarStates[s]=!sidebarStates[s];
    const sb=document.getElementById(s+'Sidebar');
    const btn=sb?.querySelector('.sidebar-toggle');
    const alertBtn=document.getElementById('alertToggle');
    const screenWrap = s==='dash' ? document.getElementById('dashboardContent') : s==='map' ? document.getElementById('mapContainer') : document.getElementById('listContent');
    if(sidebarStates[s]){
      sb?.classList.add('open');
      if(btn)btn.innerHTML='▶';
      if(alertBtn)alertBtn.innerHTML='✖';
      screenWrap?.classList.add('sidebar-open');
      if (s==='map') setTimeout(()=>{ try { fullMap && fullMap.invalidateSize(); } catch{} }, 300);
    }else{
      sb?.classList.remove('open');
      if(btn)btn.innerHTML='◀';
      if(alertBtn)alertBtn.innerHTML='🔔';
      screenWrap?.classList.remove('sidebar-open');
      if (s==='map') setTimeout(()=>{ try { fullMap && fullMap.invalidateSize(); } catch{} }, 300);
    }
  }

  function showScreen(sn){
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
    document.getElementById(sn)?.classList.add('active');
    const navBtns = Array.from(document.querySelectorAll('.nav-buttons .nav-btn'));
    navBtns.forEach(b => b.classList.remove('active'));
    if (sn === 'dashboard') navBtns[0]?.classList.add('active');
    else if (sn === 'map') navBtns[1]?.classList.add('active');
    else if (sn === 'list') navBtns[2]?.classList.add('active');

    ['dash','map','list'].forEach(s=>{
      const sb=document.getElementById(s+'Sidebar');
      if(sb)sb.classList.remove('open');
      sidebarStates[s]=false;
    });
    const alertBtn=document.getElementById('alertToggle');
    if (alertBtn) alertBtn.innerHTML='🔔';

    if (sn === 'map') { setTimeout(()=>{ try { fullMap && fullMap.invalidateSize(); } catch{}; refreshMap(); }, 100); }
    else if (sn === 'dashboard') refreshDashboard();
    else if (sn === 'list') renderList();
  }

  function applyFilters() {
    applyFiltersInternal();
    renderList();
    updateAlerts('list');
  }

  async function reloadAll() {
    const json = await API.list();
    state.rows = (json.rows || []).map(r => ({
      ...r,
      istifaa_expiry_date: toUiDate(r.istifaa_expiry_date),
      amc_expiry_date: toUiDate(r.amc_expiry_date),
      doe_noc_expiry_date: toUiDate(r.doe_noc_expiry_date),
      coc_expiry_date: toUiDate(r.coc_expiry_date),
      tpi_expiry_date: toUiDate(r.tpi_expiry_date),
    }));
    applyFiltersInternal();
    refreshDashboard();
    refreshMap();
    renderList();
  }

  function openEditModalByName(name) {
    const row = state.rows.find(r => (r.building_name || r.building_code || r.sn) === name);
    openEditModal(row || null);
  }

  function reloadDocumentTracker() {
    reloadAll().catch(err => alert('Reload failed: ' + (err && err.message)));
  }

  function openSummarySitesModal(kind) {
    const modal = document.getElementById('summarySitesModal');
    const titleEl = document.getElementById('summarySitesTitle');
    const bodyEl = document.getElementById('summarySitesBody');
    const infoEl = document.getElementById('summarySitesInfo');
    if (!modal || !titleEl || !bodyEl || !infoEl) return;

    let rows = [];
    let isDocMode = false;

    if (kind === 'allValid') {
      rows = Array.isArray(state.allValidSites) ? state.allValidSites : [];
      titleEl.textContent = 'ALL DOCUMENTS VALID – Sites';
      infoEl.textContent = `Showing all ${rows.length} sites where all documents are valid.`;
      isDocMode = false;
    } else if (kind === 'allNotValid') {
      rows = Array.isArray(state.allNotValidSites) ? state.allNotValidSites : [];
      titleEl.textContent = 'ALL DOCUMENTS NOT VALID – Sites';
      infoEl.textContent = `Showing all ${rows.length} sites where all documents are expired.`;
      isDocMode = false;
    } else if (kind === 'renewalDocs') {
      rows = Array.isArray(state.renewalDocs) ? state.renewalDocs : [];
      titleEl.textContent = 'TOTAL DOCUMENTS UNDER RENEWAL – Documents';
      infoEl.textContent = `Showing all ${rows.length} documents in need of renewal.`;
      isDocMode = true;
    } else if (kind === 'expiredDocs') {
      rows = Array.isArray(state.expiredDocs) ? state.expiredDocs : [];
      titleEl.textContent = 'TOTAL DOCUMENTS EXPIRED – Documents';
      infoEl.textContent = `Showing all ${rows.length} expired documents.`;
      isDocMode = true;
    } else {
      rows = [];
      titleEl.textContent = 'Sites';
      infoEl.textContent = '';
      isDocMode = false;
    }

    if (!rows.length) {
      bodyEl.innerHTML = '<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--muted)">No matching records.</td></tr>';
    } else {
      if (!isDocMode) {
        bodyEl.innerHTML = rows.map(r => {
          const st = aggregatedStatus(r);
          const badge =
            st === 'expired' ? '<span class="status-badge status-expired">Expired</span>' :
            st === 'renewal' ? '<span class="status-badge status-renewal">Renewal</span>' :
            st === 'valid' ? '<span class="status-badge status-valid">Valid</span>' :
            '<span class="status-badge status-valid">Unknown</span>';
          return `
            <tr>
              <td>${escapeHtml(r.sn || '')}</td>
              <td>${escapeHtml(r.building_type || '')}</td>
              <td>${escapeHtml(r.building_name || '')}</td>
              <td>${escapeHtml(r.building_code || '')}</td>
              <td>${badge}</td>
            </tr>
          `;
        }).join('');
      } else {
        bodyEl.innerHTML = rows.map(d => {
          const badge =
            d.status === 'renewal' ? '<span class="status-badge status-renewal">Renewal</span>' :
            '<span class="status-badge status-expired">Expired</span>';
          return `
            <tr>
              <td>${escapeHtml(d.sn || '')}</td>
              <td>${escapeHtml(d.building_type || '')}</td>
              <td>${escapeHtml(d.building_name || '')}</td>
              <td>${escapeHtml(d.building_code || '')}</td>
              <td>
                <div>${escapeHtml(d.document_type || '')}</div>
                <div style="font-size:11px;color:var(--muted);margin-top:2px;">Expiry: ${fmtDate(d.expiry_date)}</div>
                <div style="margin-top:4px;">${badge}</div>
              </td>
            </tr>
          `;
        }).join('');
      }
    }

    modal.style.display = 'block';
  }

  function closeSummarySitesModal() {
    const modal = document.getElementById('summarySitesModal');
    if (modal) modal.style.display = 'none';
  }

  function triggerExcelImport() {
    const input = document.getElementById('excel-import-input');
    if (!input) return;
    input.value = '';
    input.onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        await importExcelFile(file);
      } catch (err) {
        alert('Import failed: ' + (err && err.message || 'Unknown'));
      }
    };
    input.click();
  }

  function normHeader(h) {
    const s = String(h || '').toLowerCase().trim();
    const key = s.replace(/[\s._-]+/g,' ');
    const map = {
      's n': 'sn',
      'serial': 'sn',
      'building type': 'building_type',
      'facility type': 'building_type',
      'type': 'building_type',
      'building code': 'building_code',
      'code': 'building_code',
      'building name': 'building_name',
      'name': 'building_name',
      'istifaa exp date': 'istifaa_expiry_date',
      'istifaa expiry date': 'istifaa_expiry_date',
      'amc exp date': 'amc_expiry_date',
      'amc expiry date': 'amc_expiry_date',
      'doe noc exp date': 'doe_noc_expiry_date',
      'doe noc expiry date': 'doe_noc_expiry_date',
      'coc exp date': 'coc_expiry_date',
      'coc expiry date': 'coc_expiry_date',
      'tpi exp date': 'tpi_expiry_date',
      'tpi expiry date': 'tpi_expiry_date',
      'latitude': 'latitude',
      'longitude': 'longitude',
      'notes': 'notes'
    };
    return map[key] || null;
  }

  function cellToIsoDate(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number') {
      try {
        const d = XLSX.SSF.parse_date_code(v);
        if (d && typeof d.y === 'number') {
          const js = new Date(Date.UTC(d.y, (d.m || 1) - 1, d.d || 1));
          return js.toISOString().slice(0, 10);
        }
      } catch (e) {}
    }
    if (v instanceof Date) {
      if (!isNaN(v.getTime())) return v.toISOString().slice(0, 10);
      return '';
    }
    const s = String(v).trim();
    if (!s) return '';
    const tryParse = new Date(s.includes('T') ? s : (s + 'T00:00:00Z'));
    if (!isNaN(tryParse.getTime())) return tryParse.toISOString().slice(0, 10);
    return '';
  }

  async function importExcelFile(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
    if (!rows || rows.length < 2) throw new Error('No data found in the first sheet');

    const headerRow = rows[0];
    const idxMap = {};
    headerRow.forEach((h, idx) => {
      const key = normHeader(h);
      if (key) idxMap[key] = idx;
    });

    const required = ['building_code', 'building_name'];
    const missing = required.filter(k => !(k in idxMap));
    if (missing.length) {
      throw new Error('Missing required columns: ' + missing.join(', '));
    }

    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const nonEmpty = row.some(v => v != null && String(v).trim() !== '');
      if (!nonEmpty) continue;

      const building_code = row[idxMap['building_code']] != null ? String(row[idxMap['building_code']]).trim() : '';
      const building_name = row[idxMap['building_name']] != null ? String(row[idxMap['building_name']]).trim() : '';

      if (!building_code && !building_name) continue;

      const payload = {
        building_type: idxMap['building_type'] != null ? String(row[idxMap['building_type']] || '').trim() : '',
        building_code,
        building_name,
        latitude: idxMap['latitude'] != null ? row[idxMap['latitude']] : null,
        longitude: idxMap['longitude'] != null ? row[idxMap['longitude']] : null,
        istifaa_expiry_date: idxMap['istifaa_expiry_date'] != null ? cellToIsoDate(row[idxMap['istifaa_expiry_date']]) : '',
        amc_expiry_date: idxMap['amc_expiry_date'] != null ? cellToIsoDate(row[idxMap['amc_expiry_date']]) : '',
        doe_noc_expiry_date: idxMap['doe_noc_expiry_date'] != null ? cellToIsoDate(row[idxMap['doe_noc_expiry_date']]) : '',
        coc_expiry_date: idxMap['coc_expiry_date'] != null ? cellToIsoDate(row[idxMap['coc_expiry_date']]) : '',
        tpi_expiry_date: idxMap['tpi_expiry_date'] != null ? cellToIsoDate(row[idxMap['tpi_expiry_date']]) : '',
        notes: idxMap['notes'] != null ? String(row[idxMap['notes']] || '').trim() : ''
      };
      if (payload.latitude != null && payload.latitude !== '') {
        const n = Number(payload.latitude);
        payload.latitude = isNaN(n) ? null : n;
      }
      if (payload.longitude != null && payload.longitude !== '') {
        const n = Number(payload.longitude);
        payload.longitude = isNaN(n) ? null : n;
      }
      out.push(payload);
    }

    if (!out.length) {
      alert('No valid rows to import.');
      return;
    }

    const res = await API.bulkImport(out);
    const inserted = res.inserted || 0;
    const updated = res.updated || 0;
    const failed = res.failed || 0;
    alert(`✅ Import finished.\nInserted: ${inserted}\nUpdated: ${updated}\nFailed: ${failed}`);

    await reloadAll();
  }

  window.showScreen = showScreen;
  window.toggleSidebar = toggleSidebar;
  window.getCurrentScreen = getCurrentScreen;
  window.filterAlerts = filterAlerts;
  window.applyFilters = applyFilters;
  window.exportToCSV = exportToCSV;
  window.exportToExcel = exportToExcel;
  window.exportToPDF = exportToPDF;
  window.openEditModal = openEditModal;
  window.closeEditModal = closeEditModal;
  window.saveEdit = saveEdit;
  window.reloadDocumentTracker = reloadDocumentTracker;
  window.triggerExcelImport = triggerExcelImport;
  window.openSummarySitesModal = openSummarySitesModal;
  window.closeSummarySitesModal = closeSummarySitesModal;
  window.openDocsModal = openDocsModal;
  window.closeDocsModal = closeDocsModal;
  window.saveDocs = saveDocs;
  window.deleteDocFile = deleteDocFile;

  window.addEventListener('load', () => {
    reloadAll().catch(e => {
      console.error(e);
      alert('Failed to load document tracker.');
    });
  });

})();
