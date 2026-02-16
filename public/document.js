// Document Tracker (SQL-backed) front-end
// Exposes global functions used by inline HTML: showScreen, toggleSidebar, getCurrentScreen,
// filterAlerts, applyFilters, exportToCSV, exportToExcel, exportToPDF, openEditModal, closeEditModal, saveEdit, reloadDocumentTracker.
//
// CHANGE: SN is now auto-generated server-side for new sites. The edit modal no longer includes an SN input,
// and saveEdit does not send an SN in the payload.

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
    }
  };

  const state = {
    rows: [],
    filtered: []
  };

  function statusFromDate(isoDate) {
    if (!isoDate) return 'valid';
    const today = new Date();
    const d = new Date(isoDate + 'T00:00:00Z');
    const diffDays = Math.ceil((d.getTime() - today.getTime()) / 86400000);
    if (diffDays < 0) return 'expired';
    if (diffDays <= 30) return 'renewal';
    return 'valid';
  }

  function aggregatedStatus(r) {
    const all = [
      statusFromDate(r.istifaa_expiry_date),
      statusFromDate(r.amc_expiry_date),
      statusFromDate(r.doe_noc_expiry_date),
      statusFromDate(r.coc_expiry_date),
      statusFromDate(r.tpi_expiry_date),
    ];
    return all.includes('expired') ? 'expired' : (all.includes('renewal') ? 'renewal' : 'valid');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
  }

  // Map
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
        m.bindPopup(`<div style="min-width:240px">
          <div style="font-weight:700">${escapeHtml(p.building_name || p.building_code || p.sn)}</div>
          <div style="font-size:12px;color:var(--muted)">SN: ${escapeHtml(p.sn || '��')}</div>
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

  // Alerts/Dashboard
  function updateAlerts(prefix) {
    const listEl = document.getElementById(prefix+'AlertsList');
    const expired = [];
    const today = new Date();
    state.filtered.forEach(r => {
      [
        ['Istifaa', r.istifaa_expiry_date],
        ['AMC', r.amc_expiry_date],
        ['DOE NOC', r.doe_noc_expiry_date],
        ['COC', r.coc_expiry_date],
        ['TPI', r.tpi_expiry_date]
      ].forEach(([name, d]) => {
        if (!d) return;
        const dd = new Date(d + 'T00:00:00Z');
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
      });
    });
    expired.sort((a,b) => a.priority - b.priority);
    if (listEl) {
      listEl.innerHTML = expired.length === 0
        ? '<div style="padding:30px 15px;text-align:center;color:var(--muted);font-size:12px">✅ No alerts</div>'
        : expired.map(a => `<div class="alert-item ${a.alertClass}" onclick="openEditModalByName('${escapeHtml(a.projectName)}')"><h3>${escapeHtml(a.projectName)}</h3><p><strong>${escapeHtml(a.docName)}</strong></p><p>Expiry: ${new Date(a.expiryDate + 'T00:00:00Z').toLocaleDateString()}</p><span class="alert-badge ${a.badgeClass}">${escapeHtml(a.message)}</span></div>`).join('');
    }
    const expCount = expired.filter(e => e.priority < 0).length;
    const expiring = expired.filter(e => e.priority >= 0).length;
    const totalSpanExpired = document.getElementById(prefix+'-stat-expired');
    const totalSpanExpiring = document.getElementById(prefix+'-stat-expiring');
    const totalSpanTotal = document.getElementById(prefix+'-stat-total');
    if (totalSpanExpired) totalSpanExpired.textContent = expCount;
    if (totalSpanExpiring) totalSpanExpiring.textContent = expiring;
    if (totalSpanTotal) totalSpanTotal.textContent = state.filtered.length;
  }

  function refreshDashboard() {
    const types = ['istifaa','amc','doe_noc','coc','tpi'];
    const byType = Object.fromEntries(types.map(t => [t, { expired:0, renewal:0, valid:0 }]));
    state.filtered.forEach(r => {
      const map = {
        istifaa: statusFromDate(r.istifaa_expiry_date),
        amc: statusFromDate(r.amc_expiry_date),
        doe_noc: statusFromDate(r.doe_noc_expiry_date),
        coc: statusFromDate(r.coc_expiry_date),
        tpi: statusFromDate(r.tpi_expiry_date),
      };
      types.forEach(t => { byType[t][map[t]]++; });
    });
    const boxes = document.getElementById('dashboardBoxes');
    if (!boxes) return;
    const title = { istifaa:'ISTIFAA', amc:'AMC', doe_noc:'DOE NOC', coc:'COC', tpi:'TPI' };
    let html = '';
    types.forEach(t => {
      const s = byType[t];
      html += `
        <div class="dashboard-card" style="border-top:4px solid var(--accent)">
          <h4 style="font-size:13px;margin-bottom:12px;color:var(--accent);font-weight:700">${title[t]}</h4>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;text-align:center">
            <div><div style="font-size:24px;font-weight:800;color:#e53e3e">${s.expired}</div><div style="font-size:10px;color:var(--muted)">Expired</div></div>
            <div><div style="font-size:24px;font-weight:800;color:#ed8936">${s.renewal}</div><div style="font-size:10px;color:var(--muted)">Renewal</div></div>
            <div><div style="font-size:24px;font-weight:800;color:#48bb78">${s.valid}</div><div style="font-size:10px;color:var(--muted)">Valid</div></div>
          </div>
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.04);text-align:center">
            <span style="font-size:11px;color:var(--muted)">Total: <strong style="color:var(--text)">${s.expired+s.renewal+s.valid}</strong></span>
          </div>
        </div>
      `;
    });
    boxes.innerHTML = html;
    updateAlerts('dash');
    updateAlerts('map');
    updateAlerts('list');
  }

  // List rendering with filters
  function currentFilters() {
    const term = (document.getElementById('filterSearch')?.value || '').toLowerCase().trim();
    const sf = (document.getElementById('filterStatus')?.value || 'all');
    const df = (document.getElementById('filterDocument')?.value || 'all');
    return { term, sf, df };
  }

  function applyFiltersInternal() {
    const { term, sf, df } = currentFilters();
    state.filtered = (state.rows || []).filter(r => {
      // search across SN / building_name / building_code
      if (term) {
        const hay = `${r.sn || ''} ${r.building_name || ''} ${r.building_code || ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      // status
      if (sf && sf !== 'all') {
        if (aggregatedStatus(r) !== sf) return false;
      }
      // document filter: include row if that doc has a date (or always true if 'all')
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
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:30px;color:var(--muted)">No projects found</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const sAny = aggregatedStatus(r);
      const badge =
        sAny === 'expired' ? '<span class="status-badge status-expired">Expired</span>' :
        sAny === 'renewal' ? '<span class="status-badge status-renewal">Renewal</span>' :
        '<span class="status-badge status-valid">Valid</span>';

      const eDate = d => d ? new Date(d + 'T00:00:00Z').toLocaleDateString() : '—';

      return `
        <tr data-id="${r.id}">
          <td>${escapeHtml(r.sn || '')}</td>
          <td>${escapeHtml(r.building_name || '')}</td>
          <td>${escapeHtml(r.building_code || '')}</td>
          <td>${badge}</td>
          <td>${escapeHtml(eDate(r.istifaa_expiry_date))}</td>
          <td>${escapeHtml(eDate(r.amc_expiry_date))}</td>
          <td>${escapeHtml(eDate(r.doe_noc_expiry_date))}</td>
          <td><button class="edit-btn" data-action="edit">✏️ Edit</button></td>
        </tr>
      `;
    }).join('');

    // Wire edit buttons
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
  }

  // Edit modal
  function buildEditForm(row) {
    return `
      <input type="hidden" id="f-id" value="${row?.id ?? ''}">
      <div class="doc-section">
        <h4>Site & Position</h4>
        <div class="form-row">
          <div class="form-group"><label>Building Type</label><input type="text" id="f-building_type" value="${row?.building_type || ''}"></div>
          <div class="form-group"><label>Building Code</label><input type="text" id="f-building_code" value="${row?.building_code || ''}"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Building Name</label><input type="text" id="f-building_name" value="${row?.building_name || ''}"></div>
          <div class="form-group"><label>Latitude</label><input type="number" step="0.000001" id="f-lat" value="${row?.latitude ?? ''}"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Longitude</label><input type="number" step="0.000001" id="f-lng" value="${row?.longitude ?? ''}"></div>
          <div class="form-group"><label>Notes</label><input type="text" id="f-notes" value="${row?.notes || ''}"></div>
        </div>
      </div>

      <div class="doc-section">
        <h4>Expiry Dates</h4>
        <div class="form-row">
          <div class="form-group"><label>ISTIFAA Exp Date</label><input type="date" id="f-istifaa" value="${row?.istifaa_expiry_date || ''}"></div>
          <div class="form-group"><label>AMC Exp Date</label><input type="date" id="f-amc" value="${row?.amc_expiry_date || ''}"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>DOE NOC Exp Date</label><input type="date" id="f-doe" value="${row?.doe_noc_expiry_date || ''}"></div>
          <div class="form-group"><label>COC Exp Date</label><input type="date" id="f-coc" value="${row?.coc_expiry_date || ''}"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>TPI Exp Date</label><input type="date" id="f-tpi" value="${row?.tpi_expiry_date || ''}"></div>
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

  // Alerts filtering (sidebar search boxes)
  function filterAlerts(prefix) {
    const term = (document.getElementById(prefix+'SearchAlerts')?.value || '').toLowerCase();
    document.querySelectorAll('#'+prefix+'AlertsList .alert-item').forEach(i => {
      i.style.display = i.textContent.toLowerCase().includes(term) ? 'block' : 'none';
    });
  }

  // Export helpers (use current filtered rows)
  function exportToCSV() {
    let csv='SN,Building Name,Building Code,ISTIFAA Exp,AMC Exp,DOE NOC Exp,COC Exp,TPI Exp,Status\n';
    state.filtered.forEach(r=>{
      const s = aggregatedStatus(r);
      csv+=[
        r.sn || '',
        (r.building_name || '').replace(/"/g,'""'),
        (r.building_code || '').replace(/"/g,'""'),
        r.istifaa_expiry_date || '',
        r.amc_expiry_date || '',
        r.doe_noc_expiry_date || '',
        r.coc_expiry_date || '',
        r.tpi_expiry_date || '',
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
    const data = state.filtered.map(r => ({
      'SN': r.sn || '',
      'Building Name': r.building_name || '',
      'Building Code': r.building_code || '',
      'ISTIFAA Exp': r.istifaa_expiry_date || '',
      'AMC Exp': r.amc_expiry_date || '',
      'DOE NOC Exp': r.doe_noc_expiry_date || '',
      'COC Exp': r.coc_expiry_date || '',
      'TPI Exp': r.tpi_expiry_date || '',
      'Status': aggregatedStatus(r)
    }));
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
    const data=state.filtered.map(r=>[
      r.sn || '',
      (r.building_name || '').substring(0,20),
      r.building_code || '',
      r.istifaa_expiry_date || '',
      r.amc_expiry_date || '',
      r.doe_noc_expiry_date || '',
      r.coc_expiry_date || '',
      r.tpi_expiry_date || '',
      aggregatedStatus(r)
    ]);
    doc.autoTable({
      startY:35,
      head:[['SN','Name','Code','ISTIFAA','AMC','DOE NOC','COC','TPI','Status']],
      body:data,
      theme:'striped',
      headStyles:{fillColor:[102,126,234]},
      styles:{fontSize:7}
    });
    doc.save('tank_documents.pdf');
  }

  // Sidebar toggling (compatible with existing HTML)
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
    // update nav button active state
    const navBtns = Array.from(document.querySelectorAll('.nav-buttons .nav-btn'));
    navBtns.forEach(b => b.classList.remove('active'));
    if (sn === 'dashboard') navBtns[0]?.classList.add('active');
    else if (sn === 'map') navBtns[1]?.classList.add('active');
    else if (sn === 'list') navBtns[2]?.classList.add('active');

    // close sidebars when switching
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

  // Public filter apply (wired to controls)
  function applyFilters() {
    applyFiltersInternal();
    renderList();
    updateAlerts('list');
  }

  // Reload all from API
  async function reloadAll() {
    const json = await API.list();
    state.rows = json.rows || [];
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

  // Expose globals used by inline HTML
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

  // Boot
  window.addEventListener('load', () => {
    reloadAll().catch(e => {
      console.error(e);
      alert('Failed to load document tracker.');
    });
  });
})();
