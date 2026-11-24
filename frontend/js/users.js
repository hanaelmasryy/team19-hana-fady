// User accounts screen (Admin only). Owner: Hana Fady (issue #10).
// Create accounts, change role, rename, deactivate and reactivate.
// API: /api/users (see backend/src/routes/users.js). Users are never deleted.

(() => {
  const user = auth.requireLogin(['Admin']);
  if (!user) return;
  const { el, clear, showMessage, hideMessage, formatDate, busy, debounce } = ui;

  const $ = (id) => document.getElementById(id);
  const pageMessage = $('page-message');
  const ROLES = ['Admin', 'Staff', 'Customer'];

  // ---- list ------------------------------------------------------------------------

  async function loadList() {
    const params = new URLSearchParams({ active: $('active-filter').value });
    if ($('role-filter').value) params.set('role', $('role-filter').value);
    const term = $('search').value.trim();
    if (term) params.set('search', term);
    try {
      const users = await api.get(`/api/users?${params}`);
      const tbody = $('user-rows');
      clear(tbody);
      for (const u of users) tbody.append(userRow(u));
      $('empty-list').hidden = users.length > 0;
    } catch (err) {
      showMessage(pageMessage, err.message, 'error');
    }
  }

  function userRow(u) {
    const self = u.id === user.id;

    const roleSelect = el('select', { 'aria-label': `Role of ${u.name}`, disabled: self || !u.active },
      ...ROLES.map((r) => el('option', { value: r }, r)));
    roleSelect.value = u.role;
    roleSelect.addEventListener('change', () => changeRole(u, roleSelect));

    const actions = el('td', { className: 'actions' },
      el('button', { type: 'button', className: 'secondary small', onClick: (e) => rename(u, e.currentTarget) }, 'Rename'));
    if (self) {
      actions.append(el('span', { className: 'muted small' }, 'This is you'));
    } else if (u.active) {
      actions.append(el('button', { type: 'button', className: 'danger small', onClick: (e) => setActive(u, false, e.currentTarget) }, 'Deactivate'));
    } else {
      actions.append(el('button', { type: 'button', className: 'small', onClick: (e) => setActive(u, true, e.currentTarget) }, 'Reactivate'));
    }

    return el('tr', { className: u.active ? '' : 'inactive' },
      el('td', {}, u.name),
      el('td', {}, u.email),
      el('td', {}, roleSelect),
      el('td', {}, el('span', { className: `badge ${u.active ? 'active' : 'archived'}` }, u.active ? 'Active' : 'Deactivated')),
      el('td', {}, formatDate(u.createdAt)),
      actions);
  }

  // Shows the API's message for refusals such as "At least one active Admin
  // is required" or "You cannot change your own role or deactivate yourself".
  function report(err) {
    showMessage(pageMessage, err.message, 'error');
  }

  async function changeRole(u, select) {
    const role = select.value;
    if (!confirm(`Change ${u.name}'s role from ${u.role} to ${role}?\n\nIt applies to their very next action, even if they are logged in now.`)) {
      select.value = u.role;
      return;
    }
    select.disabled = true;
    try {
      await api.patch(`/api/users/${u.id}`, { role });
      showMessage(pageMessage, `${u.name} is now ${role}.`);
      await loadList();
    } catch (err) {
      select.value = u.role;
      select.disabled = false;
      report(err);
    }
  }

  async function setActive(u, active, button) {
    const question = active
      ? `Reactivate ${u.name}? They will be able to log in again.`
      : `Deactivate ${u.name}?\n\nThey are logged out at once and can't log in. Their history stays (accounts are never deleted), and you can reactivate them later.`;
    if (!confirm(question)) return;
    await busy(button, async () => {
      try {
        await api.patch(`/api/users/${u.id}`, { active });
        showMessage(pageMessage, active ? `${u.name} was reactivated.` : `${u.name} was deactivated.`);
        await loadList();
      } catch (err) {
        report(err);
      }
    });
  }

  async function rename(u, button) {
    const name = prompt(`New name for ${u.name}:`, u.name);
    if (name === null || name.trim() === u.name) return;
    if (!name.trim()) {
      showMessage(pageMessage, 'The name cannot be empty.', 'error');
      return;
    }
    await busy(button, async () => {
      try {
        await api.patch(`/api/users/${u.id}`, { name: name.trim() });
        showMessage(pageMessage, 'Name updated.');
        await loadList();
      } catch (err) {
        report(err);
      }
    });
  }

  // ---- create ----------------------------------------------------------------------

  // 16 random characters from the browser's secure random generator.
  // Similar-looking characters (0/O, 1/l/I) are left out so it's easy to read out.
  function generatePassword(length = 16) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_!@#%';
    const limit = 256 - (256 % chars.length); // avoid modulo bias
    let out = '';
    while (out.length < length) {
      const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
      for (const b of bytes) {
        if (b < limit && out.length < length) out += chars[b % chars.length];
      }
    }
    return out;
  }

  function setPasswordVisible(show) {
    $('u-password').type = show ? 'text' : 'password';
    $('show-password').textContent = show ? 'Hide' : 'Show';
    $('show-password').setAttribute('aria-pressed', String(show));
  }

  function openCreate() {
    hideMessage(pageMessage);
    hideMessage($('form-error'));
    $('user-form').reset();
    setPasswordVisible(false);
    $('create-view').hidden = false;
    $('new-user').hidden = true;
    $('u-name').focus();
  }

  function closeCreate() {
    $('user-form').reset();
    setPasswordVisible(false);
    $('create-view').hidden = true;
    $('new-user').hidden = false;
  }

  async function create(event) {
    event.preventDefault();
    const formError = $('form-error');
    hideMessage(formError);
    const body = {
      name: $('u-name').value.trim(),
      email: $('u-email').value.trim(),
      role: $('u-role').value,
      password: $('u-password').value,
    };
    let problem = null;
    if (!body.name) problem = ['Enter the person\'s name.', 'u-name'];
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) problem = ['Enter a valid email address.', 'u-email'];
    else if (body.password.length < 12) problem = ['The password must be at least 12 characters. Use Generate for a strong one.', 'u-password'];
    if (problem) {
      formError.textContent = problem[0];
      formError.hidden = false;
      $(problem[1]).focus();
      return;
    }
    await busy($('create-user'), async () => {
      try {
        const created = await api.post('/api/users', body);
        closeCreate();
        showMessage(pageMessage, `Account created for ${created.name} (${created.role}). Give them their password privately.`);
        await loadList();
      } catch (err) {
        formError.textContent = err.status === 409 ? 'An account with this email already exists.' : err.message;
        formError.hidden = false;
      }
    });
  }

  // ---- wiring ----------------------------------------------------------------------

  $('new-user').addEventListener('click', openCreate);
  $('cancel-create').addEventListener('click', closeCreate);
  $('user-form').addEventListener('submit', create);
  $('generate-password').addEventListener('click', () => {
    $('u-password').value = generatePassword();
    setPasswordVisible(true); // so the Admin can copy it for the new user
  });
  $('show-password').addEventListener('click', () => setPasswordVisible($('u-password').type === 'password'));
  $('filters').addEventListener('submit', (e) => { e.preventDefault(); loadList(); });
  $('role-filter').addEventListener('change', loadList);
  $('active-filter').addEventListener('change', loadList);
  $('search').addEventListener('input', debounce(loadList, 300));

  loadList();
})();
