// Login page. Owner: Hana Fady (issue #10).
// Sends email + password to POST /api/auth/login, saves the token for this
// tab only, then opens the page the user asked for (or home).

(() => {
  const form = document.getElementById('login-form');
  const email = document.getElementById('email');
  const password = document.getElementById('password');
  const button = document.getElementById('login-button');
  const errorBox = document.getElementById('login-error');
  const notice = document.getElementById('login-notice');
  const toggle = document.getElementById('toggle-password');

  const params = new URLSearchParams(location.search);
  const next = auth.safeNext(params.get('next')) || auth.HOME_PAGE;

  // Already logged in (e.g. opened login.html again): go straight on.
  if (auth.getUser()) {
    location.replace(next);
    return;
  }

  const notices = {
    logout: 'You have been logged out.',
    expired: 'Your session has ended. Please log in again.',
    login: 'Please log in to continue.',
  };
  if (notices[params.get('reason')]) {
    notice.textContent = notices[params.get('reason')];
    notice.hidden = false;
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  toggle.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
    toggle.setAttribute('aria-pressed', String(show));
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    const emailValue = email.value.trim();
    if (!emailValue || !password.value) {
      showError('Enter your email and password.');
      (emailValue ? password : email).focus();
      return;
    }

    button.disabled = true;
    button.textContent = 'Logging in…';
    try {
      const { token, user } = await api.post('/api/auth/login', {
        email: emailValue,
        password: password.value,
      });
      if (!auth.saveSession(token, user)) {
        showError('Your browser is blocking storage for this site, so you cannot stay logged in.');
        return;
      }
      password.value = '';
      // Only go to a page this role may open; otherwise home.
      location.replace(auth.canOpen(user.role, next.split('?')[0]) ? next : auth.HOME_PAGE);
    } catch (err) {
      password.value = '';
      if (err.status === 429) {
        const minutes = Math.max(1, Math.ceil((err.retryAfter || 900) / 60));
        showError(`Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
      } else if (err.status === 401) {
        // Same message for a wrong email, wrong password or deactivated account,
        // so the page doesn't reveal which accounts exist.
        showError('Invalid email or password.');
      } else if (err.status === 400) {
        showError('Check the email address and try again.');
      } else if (err.status === 0) {
        showError(err.message);
      } else {
        showError('Something went wrong. Please try again.');
      }
      password.focus();
    } finally {
      button.disabled = false;
      button.textContent = 'Log in';
    }
  });
})();
