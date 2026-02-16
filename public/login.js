(function () {
  const modal = document.getElementById('login-modal');
  const form = document.getElementById('login-form');
  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');
  const errorEl = document.getElementById('login-error');
  const cancelBtn = document.getElementById('login-cancel');

  function showModal() {
    modal.style.display = 'flex';
    document.body.classList.add('modal-open');
    setTimeout(() => usernameInput.focus(), 50);
  }
  function hideModal() {
    modal.style.display = 'none';
    document.body.classList.remove('modal-open');
  }

  // Show modal on load (same UX)
  showModal();

  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    errorEl.style.display = 'none';

    const u = (usernameInput.value || '').trim();
    const p = (passwordInput.value || '').trim();

    try {
      const resp = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || 'Invalid username or password');
      }
      const j = await resp.json();
      const role = String(j.role || '').trim();

      // Preserve existing app flags and event (no change to downstream behavior)
      try { window._clientAuthenticated = true; } catch {}
      try { window._clientUsername = u; } catch {}
      try { window._clientIsAdmin = (role === 'admin'); } catch {}

      hideModal();
      try { window.dispatchEvent(new Event('app:login')); } catch {}

      // If the app exposes a start function, call it immediately
      try { if (typeof window.appStart === 'function') window.appStart(); } catch {}
    } catch (err) {
      errorEl.textContent = err.message || 'Invalid username or password';
      errorEl.style.display = 'block';
      passwordInput.value = '';
      passwordInput.focus();
    }
  });

  cancelBtn.addEventListener('click', function () {
    try { window._clientAuthenticated = false; } catch {}
    try { window._clientIsAdmin = false; } catch {}
    try { window._clientUsername = ''; } catch {}
    hideModal();
    window.location.reload();
  });

  modal.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      ev.preventDefault();
    }
  });
})();
