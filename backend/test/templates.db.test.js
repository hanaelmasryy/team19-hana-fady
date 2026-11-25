// Template endpoint tests against a real database (issue #5).
// Runs only when DATABASE_URL is set (backend/.env, DEV branch).
// Cleans up: deletes the templates it creates and deactivates its users.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

try {
  process.loadEnvFile(`${__dirname}/../.env`);
} catch {
  // no .env file
}
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256-signing';
}
const SKIP = process.env.DATABASE_URL ? false : 'DATABASE_URL not set; database tests skipped';

const request = require('supertest');

let app;
let pool;
let signToken;
const run = crypto.randomBytes(4).toString('hex');
const tokens = {};
const userEmails = [];
const templateIds = [];

const as = (role) => ({ Authorization: `Bearer ${tokens[role]}` });
const sample = (over = {}) => ({
  title: `Test template ${run}`,
  description: 'Created by automated tests',
  tasks: [
    { title: 'Kick-off call', offsetDays: 0, visibility: 'customer', actor: 'staff' },
    { title: 'Upload company documents', offsetDays: 3, visibility: 'customer', actor: 'customer' },
    { title: 'Internal credit check', offsetDays: 5, visibility: 'internal', actor: 'staff' },
  ],
  ...over,
});

async function createTemplate(body = sample()) {
  const res = await request(app).post('/api/templates').set(as('Admin')).send(body);
  if (res.status === 201) templateIds.push(res.body.id);
  return res;
}

before(async () => {
  if (SKIP) return;
  app = require('../src/app');
  pool = require('../src/db/pool');
  ({ signToken } = require('../src/lib/tokens'));
  for (const role of ['Admin', 'Staff', 'Customer']) {
    const email = `test-tpl-${role.toLowerCase()}-${run}@example.test`;
    const { rows } = await pool.db().query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, 'not-a-real-hash', $3) RETURNING id`,
      [`Test ${role}`, email, role]
    );
    userEmails.push(email);
    tokens[role] = signToken(rows[0].id);
  }
});

after(async () => {
  if (SKIP) return;
  await pool.db().query('DELETE FROM templates WHERE id = ANY($1)', [templateIds]);
  await pool.db().query('UPDATE users SET active = false WHERE email = ANY($1)', [userEmails]);
  await pool.db().end();
});

test('Admin creates a template with task rules -> 201', { skip: SKIP }, async () => {
  const res = await createTemplate();
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.status, 'active');
  assert.strictEqual(res.body.version, 1);
  assert.deepStrictEqual(
    res.body.tasks.map((t) => [t.position, t.title, t.offsetDays, t.visibility, t.actor]),
    [
      [1, 'Kick-off call', 0, 'customer', 'staff'],
      [2, 'Upload company documents', 3, 'customer', 'customer'],
      [3, 'Internal credit check', 5, 'internal', 'staff'],
    ]
  );
});

test('not logged in -> 401; Staff or Customer creating -> 403', { skip: SKIP }, async () => {
  assert.strictEqual((await request(app).post('/api/templates').send(sample())).status, 401);
  assert.strictEqual((await request(app).post('/api/templates').set(as('Staff')).send(sample())).status, 403);
  assert.strictEqual((await request(app).post('/api/templates').set(as('Customer')).send(sample())).status, 403);
});

test('invalid rules -> 400 and nothing is saved', { skip: SKIP }, async () => {
  // Count only this test's own title: other test files add templates in
  // parallel, so a whole-table count is not stable.
  const title = `Invalid rules ${run}`;
  const bad = sample({ title, tasks: [{ title: 'x', offsetDays: 1, visibility: 'internal', actor: 'customer' }] });
  const res = await createTemplate(bad);
  assert.strictEqual(res.status, 400);
  const saved = await pool.db().query('SELECT COUNT(*)::int AS n FROM templates WHERE title = $1', [title]);
  assert.strictEqual(saved.rows[0].n, 0);
});

test('Staff can list and read templates; Customer cannot', { skip: SKIP }, async () => {
  const { body: created } = await createTemplate();
  const list = await request(app).get('/api/templates').set(as('Staff'));
  assert.strictEqual(list.status, 200);
  const mine = list.body.find((t) => t.id === created.id);
  assert.strictEqual(mine.taskCount, 3);

  const one = await request(app).get(`/api/templates/${created.id}`).set(as('Staff'));
  assert.strictEqual(one.status, 200);
  assert.strictEqual(one.body.tasks.length, 3);

  assert.strictEqual((await request(app).get('/api/templates').set(as('Customer'))).status, 403);
  assert.strictEqual((await request(app).get(`/api/templates/${created.id}`).set(as('Customer'))).status, 403);
});

test('unknown or malformed id -> 404', { skip: SKIP }, async () => {
  assert.strictEqual((await request(app).get('/api/templates/999999999').set(as('Admin'))).status, 404);
  assert.strictEqual((await request(app).get('/api/templates/abc').set(as('Admin'))).status, 404);
  assert.strictEqual((await request(app).put('/api/templates/999999999').set(as('Admin')).send(sample())).status, 404);
});

test('edit replaces the tasks and increases the version', { skip: SKIP }, async () => {
  const { body: created } = await createTemplate();
  const res = await request(app)
    .put(`/api/templates/${created.id}`)
    .set(as('Admin'))
    .send(sample({ title: `Edited ${run}`, tasks: [{ title: 'Only task', offsetDays: 1, visibility: 'customer', actor: 'customer' }] }));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.version, 2);
  assert.strictEqual(res.body.title, `Edited ${run}`);
  assert.deepStrictEqual(res.body.tasks.map((t) => t.title), ['Only task']);

  assert.strictEqual(
    (await request(app).put(`/api/templates/${created.id}`).set(as('Staff')).send(sample())).status,
    403
  );
});

test('archive hides it from the default list and blocks edits (409)', { skip: SKIP }, async () => {
  const { body: created } = await createTemplate();
  const archived = await request(app).patch(`/api/templates/${created.id}/archive`).set(as('Admin'));
  assert.strictEqual(archived.status, 200);
  assert.strictEqual(archived.body.status, 'archived');

  const active = await request(app).get('/api/templates').set(as('Admin'));
  assert.ok(!active.body.some((t) => t.id === created.id));
  const all = await request(app).get('/api/templates?status=all').set(as('Admin'));
  assert.ok(all.body.some((t) => t.id === created.id));

  const edit = await request(app).put(`/api/templates/${created.id}`).set(as('Admin')).send(sample());
  assert.strictEqual(edit.status, 409);

  assert.strictEqual((await request(app).patch(`/api/templates/${created.id}/archive`).set(as('Staff'))).status, 403);
});

test('template changes are written to the audit log', { skip: SKIP }, async () => {
  const { body: created } = await createTemplate();
  await request(app).patch(`/api/templates/${created.id}/archive`).set(as('Admin'));
  const { rows } = await pool.db().query(
    `SELECT action FROM audit_log WHERE entity = 'template' AND entity_id = $1 ORDER BY id`,
    [String(created.id)]
  );
  assert.deepStrictEqual(rows.map((r) => r.action), ['template_create', 'template_archive']);
});

// ---- issue #7: search, reorder, duplicate -------------------------------------

test('search finds templates by title or description, ignoring case', { skip: SKIP }, async () => {
  const { body: created } = await createTemplate(sample({ title: `Searchable ${run}`, description: `KYC-${run} steps` }));
  const byTitle = await request(app).get(`/api/templates?search=${encodeURIComponent(`searchable ${run}`)}`).set(as('Staff'));
  assert.strictEqual(byTitle.status, 200);
  assert.deepStrictEqual(byTitle.body.map((t) => t.id), [created.id]);
  const byDescription = await request(app).get(`/api/templates?search=kyc-${run}`).set(as('Admin'));
  assert.deepStrictEqual(byDescription.body.map((t) => t.id), [created.id]);

  // Wildcards and SQL-looking text are just text: no error, no extra matches.
  const percent = await request(app).get(`/api/templates?search=%25${run}`).set(as('Admin'));
  assert.strictEqual(percent.status, 200);
  assert.strictEqual(percent.body.length, 0);
  const injection = await request(app).get(`/api/templates?search=${encodeURIComponent("' OR 1=1 --")}`).set(as('Admin'));
  assert.strictEqual(injection.status, 200);
  assert.strictEqual(injection.body.length, 0);

  assert.strictEqual((await request(app).get(`/api/templates?search=${'x'.repeat(101)}`).set(as('Admin'))).status, 400);
  assert.strictEqual((await request(app).get('/api/templates?search=x').set(as('Customer'))).status, 403);
});

test('search combines with status', { skip: SKIP }, async () => {
  const { body: created } = await createTemplate(sample({ title: `Old ${run}` }));
  await request(app).patch(`/api/templates/${created.id}/archive`).set(as('Admin'));
  const active = await request(app).get(`/api/templates?search=${encodeURIComponent(`old ${run}`)}`).set(as('Admin'));
  assert.strictEqual(active.body.length, 0);
  const archived = await request(app).get(`/api/templates?search=${encodeURIComponent(`old ${run}`)}&status=archived`).set(as('Admin'));
  assert.deepStrictEqual(archived.body.map((t) => t.id), [created.id]);
});

test('reorder puts tasks in the new order and increases the version', { skip: SKIP }, async () => {
  const { body: created } = await createTemplate();
  const [a, b, c] = created.tasks.map((t) => t.id);
  const res = await request(app).patch(`/api/templates/${created.id}/order`).set(as('Admin')).send({ taskIds: [c, a, b] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.version, 2);
  assert.deepStrictEqual(res.body.tasks.map((t) => [t.id, t.position]), [[c, 1], [a, 2], [b, 3]]);
  // Task rules travel with the task.
  assert.strictEqual(res.body.tasks[0].visibility, 'internal');
});

test('reorder rejects a list that does not match the template tasks -> 400', { skip: SKIP }, async () => {
  const { body: created } = await createTemplate();
  const { body: other } = await createTemplate();
  const [a, b, c] = created.tasks.map((t) => t.id);
  const send = (taskIds) => request(app).patch(`/api/templates/${created.id}/order`).set(as('Admin')).send({ taskIds });
  assert.strictEqual((await send([a, b])).status, 400); // missing one
  assert.strictEqual((await send([a, b, c, other.tasks[0].id])).status, 400); // extra task
  assert.strictEqual((await send([a, b, other.tasks[0].id])).status, 400); // task from another template
  assert.strictEqual((await send([a, a, b])).status, 400); // repeated
  // Nothing changed.
  const { body: after } = await request(app).get(`/api/templates/${created.id}`).set(as('Admin'));
  assert.deepStrictEqual(after.tasks.map((t) => t.id), [a, b, c]);
  assert.strictEqual(after.version, 1);
});

test('reorder: archived -> 409, unknown -> 404, not Admin -> 403', { skip: SKIP }, async () => {
  const { body: created } = await createTemplate();
  const ids = created.tasks.map((t) => t.id);
  assert.strictEqual((await request(app).patch(`/api/templates/${created.id}/order`).set(as('Staff')).send({ taskIds: ids })).status, 403);
  assert.strictEqual((await request(app).patch('/api/templates/999999999/order').set(as('Admin')).send({ taskIds: ids })).status, 404);
  await request(app).patch(`/api/templates/${created.id}/archive`).set(as('Admin'));
  assert.strictEqual((await request(app).patch(`/api/templates/${created.id}/order`).set(as('Admin')).send({ taskIds: ids })).status, 409);
});

test('duplicate copies the template and its task rules as a new active template', { skip: SKIP }, async () => {
  const { body: source } = await createTemplate();
  const res = await request(app).post(`/api/templates/${source.id}/duplicate`).set(as('Admin'));
  assert.strictEqual(res.status, 201);
  templateIds.push(res.body.id);
  assert.notStrictEqual(res.body.id, source.id);
  assert.strictEqual(res.body.title, `Copy of ${source.title}`);
  assert.strictEqual(res.body.status, 'active');
  assert.strictEqual(res.body.version, 1);
  const rules = (t) => t.tasks.map((x) => [x.position, x.title, x.offsetDays, x.visibility, x.actor]);
  assert.deepStrictEqual(rules(res.body), rules(source));
  // New task rows, not shared with the source.
  assert.ok(res.body.tasks.every((t) => !source.tasks.some((s) => s.id === t.id)));
});

test('duplicate accepts a new title and works on archived templates', { skip: SKIP }, async () => {
  const { body: source } = await createTemplate();
  await request(app).patch(`/api/templates/${source.id}/archive`).set(as('Admin'));
  const res = await request(app).post(`/api/templates/${source.id}/duplicate`).set(as('Admin')).send({ title: `Revived ${run}` });
  assert.strictEqual(res.status, 201);
  templateIds.push(res.body.id);
  assert.strictEqual(res.body.title, `Revived ${run}`);
  assert.strictEqual(res.body.status, 'active');
});

test('duplicate: unknown -> 404, not Admin -> 403, bad title -> 400', { skip: SKIP }, async () => {
  const { body: source } = await createTemplate();
  assert.strictEqual((await request(app).post('/api/templates/999999999/duplicate').set(as('Admin'))).status, 404);
  assert.strictEqual((await request(app).post('/api/templates/abc/duplicate').set(as('Admin'))).status, 404);
  assert.strictEqual((await request(app).post(`/api/templates/${source.id}/duplicate`).set(as('Staff'))).status, 403);
  assert.strictEqual((await request(app).post(`/api/templates/${source.id}/duplicate`).set(as('Customer'))).status, 403);
  assert.strictEqual((await request(app).post(`/api/templates/${source.id}/duplicate`).set(as('Admin')).send({ title: 'x'.repeat(151) })).status, 400);
});

test('reorder and duplicate are written to the audit log', { skip: SKIP }, async () => {
  const { body: source } = await createTemplate();
  const ids = source.tasks.map((t) => t.id).reverse();
  await request(app).patch(`/api/templates/${source.id}/order`).set(as('Admin')).send({ taskIds: ids });
  const { body: copy } = await request(app).post(`/api/templates/${source.id}/duplicate`).set(as('Admin'));
  templateIds.push(copy.id);
  const { rows } = await pool.db().query(
    `SELECT action, entity_id FROM audit_log
      WHERE action IN ('template_reorder', 'template_duplicate') AND entity_id = ANY($1) ORDER BY id`,
    [[String(source.id), String(copy.id)]]
  );
  assert.deepStrictEqual(rows, [
    { action: 'template_reorder', entity_id: String(source.id) },
    { action: 'template_duplicate', entity_id: String(copy.id) },
  ]);
});
