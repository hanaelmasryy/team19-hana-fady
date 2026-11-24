// Shows whether the frontend can reach the API (useful after each deploy).
(async () => {
  const el = document.getElementById('api-status');
  try {
    const data = await window.api.get('/api/health');
    el.textContent = data.status === 'ok' ? 'connected' : 'unexpected response';
    el.className = data.status === 'ok' ? 'ok' : 'error';
  } catch {
    el.textContent = 'not reachable';
    el.className = 'error';
  }
})();
