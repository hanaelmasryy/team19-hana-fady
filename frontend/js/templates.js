// Templates screen. Owner: Hana Fady (issue #10).
// Admin: list, search, create, edit, reorder, duplicate, archive.
// Staff: list, search and read only (the API enforces this too).
// API: /api/templates (see backend/src/routes/templates.js).

(() => {
  const user = auth.requireLogin(['Admin', 'Staff']);
  if (!user) return;
  const isAdmin = user.role === 'Admin';
  const { el, clear, showMessage, hideMessage, formatDate, busy, debounce } = ui;

  const $ = (id) => document.getElementById(id);
  const views = { list: $('list-view'), detail: $('detail-view'), edit: $('edit-view') };
  const pageMessage = $('page-message');
  const MAX_TASKS = 100;

  const VISIBILITY_LABEL = { customer: 'Customer and staff', internal: 'Staff only (internal)' };
  const ACTOR_LABEL = { staff: 'Staff', customer: 'Customer' };

  let current = null; // template open in the detail view

  function show(name) {
    for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
    $('new-template').hidden = !(isAdmin && name === 'list');
  }

  function setUrl(id) {
    const url = id ? `templates.html?id=${id}` : 'templates.html';
    history.replaceState(null, '', url);
  }

  function dueText(days) {
    return days === 0 ? 'Start day' : `Day ${days}`;
  }

  // ---- list ------------------------------------------------------------------------

  async function loadList() {
    hideMessage(pageMessage);
    const params = new URLSearchParams({ status: $('status').value });
    const term = $('search').value.trim();
    if (term) params.set('search', term);
    const tbody = $('template-rows');
    try {
      const templates = await api.get(`/api/templates?${params}`);
      clear(tbody);
      for (const t of templates) {
        const link = el('a', { href: `templates.html?id=${t.id}`, onClick: (e) => { e.preventDefault(); openTemplate(t.id); } }, t.title);
        tbody.append(el('tr', {},
          el('td', {}, link, t.description ? el('div', { className: 'muted small clamp' }, t.description) : null),
          el('td', {}, String(t.taskCount)),
          el('td', {}, `v${t.version}`),
          el('td', {}, el('span', { className: `badge ${t.status}` }, t.status)),
          el('td', {}, formatDate(t.updatedAt))));
      }
      $('empty-list').hidden = templates.length > 0;
    } catch (err) {
      showMessage(pageMessage, err.message, 'error');
    }
  }

  // ---- detail ----------------------------------------------------------------------

  async function openTemplate(id, { keepMessage = false } = {}) {
    if (!keepMessage) hideMessage(pageMessage);
    try {
      current = await api.get(`/api/templates/${id}`);
    } catch (err) {
      showMessage(pageMessage, err.status === 404 ? 'That template does not exist.' : err.message, 'error');
      setUrl(null);
      show('list');
      return;
    }
    setUrl(current.id);
    renderDetail();
    show('detail');
  }

  function renderDetail() {
    const t = current;
    const active = t.status === 'active';
    $('detail-title').textContent = t.title;
    $('detail-meta').textContent =
      `${t.status === 'archived' ? 'Archived' : 'Active'} · version ${t.version} · ${t.tasks.length} task${t.tasks.length === 1 ? '' : 's'} · updated ${formatDate(t.updatedAt)}`;
    $('detail-description').textContent = t.description || '';

    const actions = $('detail-actions');
    clear(actions);
    if (isAdmin) {
      if (active) actions.append(el('button', { type: 'button', onClick: () => openEditor(t) }, 'Edit'));
      actions.append(el('button', { type: 'button', className: 'secondary', onClick: (e) => duplicate(e.currentTarget) }, 'Duplicate'));
      if (active) actions.append(el('button', { type: 'button', className: 'danger', onClick: (e) => archive(e.currentTarget) }, 'Archive'));
    }

    const canReorder = isAdmin && active && t.tasks.length > 1;
    $('order-col').hidden = !canReorder;
    $('reorder-hint').hidden = !canReorder;

    const tbody = $('task-rows');
    clear(tbody);
    t.tasks.forEach((task, i) => {
      const row = el('tr', {},
        el('td', {}, String(i + 1)),
        el('td', {}, task.title),
        el('td', {}, dueText(task.offsetDays)),
        el('td', {}, task.visibility === 'internal'
          ? el('span', { className: 'badge internal' }, 'Staff only')
          : 'Customer and staff'),
        el('td', {}, ACTOR_LABEL[task.actor]));
      if (canReorder) {
        row.append(el('td', { className: 'order-buttons' },
          el('button', { type: 'button', className: 'icon', 'aria-label': `Move "${task.title}" up`, disabled: i === 0, onClick: (e) => move(i, -1, e.currentTarget) }, '↑'),
          el('button', { type: 'button', className: 'icon', 'aria-label': `Move "${task.title}" down`, disabled: i === t.tasks.length - 1, onClick: (e) => move(i, 1, e.currentTarget) }, '↓')));
      }
      tbody.append(row);
    });
  }

  async function move(index, step, button) {
    const ids = current.tasks.map((x) => x.id);
    [ids[index], ids[index + step]] = [ids[index + step], ids[index]];
    await busy(button, async () => {
      try {
        current = await api.patch(`/api/templates/${current.id}/order`, { taskIds: ids });
        renderDetail();
        showMessage(pageMessage, `Order saved (version ${current.version}).`);
      } catch (err) {
        showMessage(pageMessage, err.message, 'error');
        if (err.status === 409 || err.status === 400) openTemplate(current.id, { keepMessage: true });
      }
    });
  }

  async function duplicate(button) {
    const title = prompt('Title for the copy:', `Copy of ${current.title}`.slice(0, 150));
    if (title === null) return;
    await busy(button, async () => {
      try {
        const copy = await api.post(`/api/templates/${current.id}/duplicate`, title.trim() ? { title: title.trim() } : {});
        await openTemplate(copy.id);
        showMessage(pageMessage, `Copy created: "${copy.title}".`);
      } catch (err) {
        showMessage(pageMessage, err.message, 'error');
      }
    });
  }

  async function archive(button) {
    if (!confirm(`Archive "${current.title}"?\n\nNo new plans can start from it. Plans already running keep their tasks. This can't be undone, but you can duplicate it later.`)) return;
    await busy(button, async () => {
      try {
        await api.patch(`/api/templates/${current.id}/archive`);
        await openTemplate(current.id);
        showMessage(pageMessage, 'Template archived.');
      } catch (err) {
        showMessage(pageMessage, err.message, 'error');
      }
    });
  }

  // ---- create / edit ---------------------------------------------------------------

  let editingId = null;

  function taskRow(task = { title: '', offsetDays: 0, visibility: 'customer', actor: 'staff' }) {
    const visibility = el('select', { className: 'f-visibility', 'aria-label': 'Visible to' },
      el('option', { value: 'customer' }, VISIBILITY_LABEL.customer),
      el('option', { value: 'internal' }, VISIBILITY_LABEL.internal));
    const actor = el('select', { className: 'f-actor', 'aria-label': 'Done by' },
      el('option', { value: 'staff' }, 'Staff'),
      el('option', { value: 'customer' }, 'Customer'));
    visibility.value = task.visibility;
    actor.value = task.actor;

    // A customer can't do a task they can't see.
    const syncRule = () => {
      const internal = visibility.value === 'internal';
      actor.querySelector('option[value="customer"]').disabled = internal;
      if (internal) actor.value = 'staff';
    };
    visibility.addEventListener('change', syncRule);
    syncRule();

    const row = el('div', { className: 'task-row' },
      el('span', { className: 'task-number', 'aria-hidden': 'true' }),
      el('input', { className: 'f-task-title', 'aria-label': 'Task title', maxlength: '200', value: task.title, placeholder: 'Task title' }),
      el('label', { className: 'inline' }, 'Day ',
        el('input', { className: 'f-offset', type: 'number', min: '0', max: '365', step: '1', value: String(task.offsetDays), 'aria-label': 'Due day after start' })),
      visibility,
      actor,
      el('span', { className: 'row-buttons' },
        el('button', { type: 'button', className: 'icon', 'aria-label': 'Move up', onClick: () => shift(row, -1) }, '↑'),
        el('button', { type: 'button', className: 'icon', 'aria-label': 'Move down', onClick: () => shift(row, 1) }, '↓'),
        el('button', { type: 'button', className: 'icon danger-text', 'aria-label': 'Remove task', onClick: () => { row.remove(); renumber(); } }, '✕')));
    return row;
  }

  function shift(row, step) {
    const sibling = step < 0 ? row.previousElementSibling : row.nextElementSibling;
    if (!sibling) return;
    if (step < 0) sibling.before(row); else sibling.after(row);
    renumber();
    row.querySelector(step < 0 ? '[aria-label="Move up"]' : '[aria-label="Move down"]').focus();
  }

  function renumber() {
    const rows = [...$('task-editor').children];
    rows.forEach((r, i) => { r.querySelector('.task-number').textContent = `${i + 1}.`; });
    $('add-task').disabled = rows.length >= MAX_TASKS;
  }

  function openEditor(template) {
    hideMessage(pageMessage);
    hideMessage($('form-error'));
    editingId = template ? template.id : null;
    $('form-title').textContent = template ? `Edit: ${template.title}` : 'New template';
    $('form-note').textContent = template
      ? `Saving creates version ${template.version + 1}. Plans already running keep their own copy of the tasks.`
      : 'The template starts at version 1.';
    $('f-title').value = template ? template.title : '';
    $('f-description').value = template && template.description ? template.description : '';
    const editor = $('task-editor');
    clear(editor);
    const tasks = template && template.tasks.length ? template.tasks : [undefined];
    for (const task of tasks) editor.append(taskRow(task));
    renumber();
    show('edit');
    $('f-title').focus();
  }

  // Reads the form into the body the API expects. Returns { body } or { error }.
  function readForm() {
    const title = $('f-title').value.trim();
    if (!title) return { error: 'Give the template a title.', focus: $('f-title') };
    const rows = [...$('task-editor').children];
    if (rows.length === 0) return { error: 'Add at least one task.', focus: $('add-task') };
    const tasks = [];
    for (const [i, row] of rows.entries()) {
      const titleInput = row.querySelector('.f-task-title');
      const offsetInput = row.querySelector('.f-offset');
      const taskTitle = titleInput.value.trim();
      if (!taskTitle) return { error: `Task ${i + 1} needs a title.`, focus: titleInput };
      const offset = Number(offsetInput.value);
      if (!Number.isInteger(offset) || offset < 0 || offset > 365) {
        return { error: `Task ${i + 1}: the due day must be a whole number from 0 to 365.`, focus: offsetInput };
      }
      tasks.push({
        title: taskTitle,
        offsetDays: offset,
        visibility: row.querySelector('.f-visibility').value,
        actor: row.querySelector('.f-actor').value,
      });
    }
    const description = $('f-description').value.trim();
    return { body: { title, description: description || null, tasks } };
  }

  async function save(event) {
    event.preventDefault();
    const formError = $('form-error');
    hideMessage(formError);
    const { body, error, focus } = readForm();
    if (error) {
      formError.textContent = error;
      formError.hidden = false;
      if (focus) focus.focus();
      return;
    }
    await busy($('save-template'), async () => {
      try {
        const saved = editingId
          ? await api.put(`/api/templates/${editingId}`, body)
          : await api.post('/api/templates', body);
        await openTemplate(saved.id);
        showMessage(pageMessage, editingId ? `Saved as version ${saved.version}.` : 'Template created.');
      } catch (err) {
        formError.textContent = err.status === 409 ? 'This template was archived, so it can no longer be edited.' : err.message;
        formError.hidden = false;
      }
    });
  }

  // ---- wiring ----------------------------------------------------------------------

  $('filters').addEventListener('submit', (e) => { e.preventDefault(); loadList(); });
  $('status').addEventListener('change', loadList);
  $('search').addEventListener('input', debounce(loadList, 300));
  $('back-to-list').addEventListener('click', (e) => { e.preventDefault(); setUrl(null); show('list'); loadList(); });
  $('new-template').addEventListener('click', () => openEditor(null));
  $('add-task').addEventListener('click', () => {
    const row = taskRow();
    $('task-editor').append(row);
    renumber();
    row.querySelector('.f-task-title').focus();
  });
  $('template-form').addEventListener('submit', save);
  $('cancel-edit').addEventListener('click', () => {
    if (editingId) openTemplate(editingId); else { show('list'); loadList(); }
  });

  const startId = new URLSearchParams(location.search).get('id');
  if (startId && /^[1-9][0-9]{0,9}$/.test(startId)) openTemplate(startId);
  else { show('list'); loadList(); }
})();
