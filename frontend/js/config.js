// Address of the Express API. No secrets ever go in frontend files.
// Local development uses the local API; the deployed site uses the
// API's Vercel URL (Jana sets this when the Vercel projects exist).
window.APP_CONFIG = {
  API_URL:
    location.hostname === 'localhost' || location.hostname === '127.0.0.1'
      ? 'http://localhost:3000'
      : 'https://team19-api.vercel.app',
};
