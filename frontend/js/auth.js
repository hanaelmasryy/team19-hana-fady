// Login session helpers shared by every page. Owner: Hana Fady (issue #10).
//
// How a page uses this (see docs/frontend-guide.md):
//   <script src="js/config.js"></script>
//   <script src="js/auth.js"></script>
//   <script src="js/api.js"></script>
//   <script src="js/my-page.js"></script>
// and at the top of my-page.js:
//   const user = auth.requireLogin(['Admin', 'Staff']);   // redirects if not allowed
//   if (!user) return;  (inside a function) - the browser is already leaving the page
//
// Security notes:
// - The token is kept in sessionStorage: it is gone when the tab closes and
//   is never put in a URL or cookie.
// - The role saved here only decides which links and pages the browser shows.
//   The API checks the role from the database on every request, so editing
//   sessionStorage cannot give anyone more access.

(function (root) {
  const TOKEN_KEY = 'onboarding_token';
  const USER_KEY = 'onboarding_user';
  const LOGIN_PAGE = 'login.html';
  const HOME_PAGE = 'home.html';

  // Pages in the portal and who may open them. When you add a page, add it
  // here (and set ready: true once the file exists), so it appears in the menu.
  const PAGES = [
    { href: 'home.html', label: 'Home', roles: ['Admin', 'Staff', 'Customer'], ready: true },
    { href: 'plans.html', label: 'Onboarding plans', roles: ['Admin', 'Staff', 'Customer'], ready: false }, // Hana Anwar
    { href: 'templates.html', label: 'Templates', roles: ['Admin', 'Staff'], ready: true }, // Hana Fady
    { href: 'users.html', label: 'Users', roles: ['Admin'], ready: true }, // Hana Fady
    { href: 'dashboard.html', label: 'Dashboard', roles: ['Admin', 'Staff'], ready: false }, // Jana
    { href: 'audit.html', label: 'Audit log', roles: ['Admin'], ready: false }, // Jana
  ];

  // ---- pure helpers (no browser needed; unit-tested in backend/test) ----------

  // Reads the expiry time from a JWT without checking the signature. Only used
  // to log the user out in the browser when the token has expired; the API
  // always does the real check.
  function tokenExpiry(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const json = typeof atob === 'function'
        ? atob(padded)
        : Buffer.from(padded, 'base64').toString('utf8');
      const payload = JSON.parse(json);
      return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
    } catch {
      return null;
    }
  }

  function isExpired(token, now = Date.now()) {
    const exp = tokenExpiry(token);
    // 30 seconds early, so a request doesn't start with a token about to expire.
    return exp === null || exp - 30000 <= now;
  }

  function pagesFor(role) {
    return PAGES.filter((p) => p.roles.includes(role));
  }

  function canOpen(role, page) {
    const entry = PAGES.find((p) => p.href === page);
    return Boolean(entry && entry.roles.includes(role));
  }

  // Only allow returning to a page of this site after login (no open redirect
  // to another website through ?next=).
  function safeNext(next) {
    if (typeof next !== 'string') return null;
    return /^[a-z0-9-]+\.html(\?[\w=&%-]*)?$/i.test(next) ? next : null;
  }

  // ---- session (browser) -------------------------------------------------------------

  function storage() {
    try {
      return root.sessionStorage;
    } catch {
      return null; // storage blocked by the browser
    }
  }

  function saveSession(token, user) {
    const s = storage();
    if (!s) return false;
    s.setItem(TOKEN_KEY, token);
    s.setItem(USER_KEY, JSON.stringify({ id: user.id, name: user.name, role: user.role }));
    return true;
  }

  function clearSession() {
    const s = storage();
    if (!s) return;
    s.removeItem(TOKEN_KEY);
    s.removeItem(USER_KEY);
  }

  function getToken() {
    const s = storage();
    const token = s ? s.getItem(TOKEN_KEY) : null;
    if (token && isExpired(token)) {
      clearSession();
      return null;
    }
    return token;
  }

  function getUser() {
    const s = storage();
    if (!s || !getToken()) return null;
    try {
      const user = JSON.parse(s.getItem(USER_KEY));
      return user && user.id && user.role ? user : null;
    } catch {
      return null;
    }
  }

  function currentPage() {
    const name = root.location.pathname.split('/').pop();
    return name || 'index.html';
  }

  function goToLogin(reason) {
    clearSession();
    const params = new URLSearchParams();
    const here = currentPage();
    if (here !== LOGIN_PAGE && here !== 'index.html') params.set('next', here + root.location.search);
    if (reason) params.set('reason', reason);
    const query = params.toString();
    root.location.replace(LOGIN_PAGE + (query ? `?${query}` : ''));
  }

  // Call at the top of every protected page. Returns the user, or null after
  // starting a redirect (to login, or to home if the role may not open the page).
  function requireLogin(allowedRoles) {
    const user = getUser();
    if (!user) {
      goToLogin('login');
      return null;
    }
    if (Array.isArray(allowedRoles) && !allowedRoles.includes(user.role)) {
      root.location.replace(HOME_PAGE);
      return null;
    }
    renderHeader(user);
    return user;
  }

  function logout() {
    clearSession();
    root.location.replace(`${LOGIN_PAGE}?reason=logout`);
  }

  // Fills the top bar: menu links for this role, the user's name and Log out.
  // Uses textContent only (no innerHTML), so names from the database can't run as script.
  function renderHeader(user) {
    const bar = root.document.querySelector('.topbar');
    if (!bar || bar.querySelector('.nav')) return;
    const here = currentPage();

    const nav = root.document.createElement('nav');
    nav.className = 'nav';
    nav.setAttribute('aria-label', 'Main');
    for (const page of pagesFor(user.role)) {
      if (!page.ready) continue;
      const a = root.document.createElement('a');
      a.href = page.href;
      a.textContent = page.label;
      if (page.href === here) a.setAttribute('aria-current', 'page');
      nav.appendChild(a);
    }

    const who = root.document.createElement('span');
    who.className = 'who';
    who.textContent = `${user.name} (${user.role})`;

    const out = root.document.createElement('button');
    out.type = 'button';
    out.className = 'link-button';
    out.textContent = 'Log out';
    out.addEventListener('click', logout);

    const right = root.document.createElement('div');
    right.className = 'user-menu';
    right.append(who, out);
    bar.append(nav, right);
  }

  const auth = {
    TOKEN_KEY, PAGES, LOGIN_PAGE, HOME_PAGE,
    tokenExpiry, isExpired, pagesFor, canOpen, safeNext,
    saveSession, clearSession, getToken, getUser,
    requireLogin, logout, goToLogin, renderHeader,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = auth; // for tests
  if (root && root.document) root.auth = auth;
})(typeof window !== 'undefined' ? window : globalThis);
