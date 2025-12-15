const btn = document.getElementById('btn');
const spinner = document.getElementById('spinner');
const btnText = document.getElementById('btn-text');
const errorEl = document.getElementById('error');
const resultEl = document.getElementById('result');
const deviceNameEl = document.getElementById('deviceName');
const levelEl = document.getElementById('level');
const timeEl = document.getElementById('time');
const termEl = document.getElementById('term');

async function fetchTank(terminalId, friendly) {
  // UI state
  errorEl.style.display = 'none';
  resultEl.style.display = 'none';
  btn.disabled = true;
  spinner.style.display = 'inline-block';
  btnText.textContent = 'Loading...';

  try {
    const url = `/api/tank?terminalId=${encodeURIComponent(terminalId)}`;
    const resp = await fetch(url, { cache: 'no-store' });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || err.message || resp.statusText || 'SOAP error');
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

    deviceNameEl.textContent = friendly;
    levelEl.textContent = value;
    timeEl.textContent = `${dd}-${mm}-${yyyy} ${timeStr}`;
    termEl.textContent = terminalId;

    resultEl.style.display = 'block';
  } catch (err) {
    errorEl.textContent = err.message || 'Unknown error';
    errorEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
    btnText.textContent = 'Get Level';
  }
}

document.getElementById('btn').addEventListener('click', () => {
  const select = document.getElementById('device');
  const terminalId = select.value;
  if (!terminalId) {
    errorEl.textContent = 'Please select a terminalId.';
    errorEl.style.display = 'block';
    return;
  }
  const friendly = select.options[select.selectedIndex].text;
  fetchTank(terminalId, friendly);
});