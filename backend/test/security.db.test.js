// Login and token security tests on the real API routes (issue #8).
//
// The middleware tests (middleware.test.js) check each token rule against a
// fake database. These tests run the same attacks against the real routes
// and the real DEV database, so a route that forgets requireAuth or
// requireRole, or a response that leaks data, is caught here.
//
// Runs only when DATABASE_URL is set (backend/.env, DEV branch).
// Test users have emails ending in @example.test and are deactivated at the end.

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
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

let app;
let pool;
let signToken;
const run = crypto.randomBytes(4).toString('hex');
const PASSWORD = `Pw-${crypto.randomBytes(8).toString('hex')}`;
const users = {};
const emails = [];
let templateId;

const ISS = 'onboarding-portal-api';
const AUD = 'onboarding-portal';
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const fromIp = (n) => ({ 'X-Forwarded-For': `203.0.113.${n}` });

// Every route owned by Template & Workflow Rules and Auth & identity, with
// the roles allowed to call it. Used to check 401 and 403 on all of them.
const ROUTES = [
  { method: 'get', path: () => '/api/users', roles: ['Admin'] },
  { method: 'post', path: () => '/api/users', roles: ['Admin'], body: {} },
  { method: 'get', path: () => `/api/users/${users.Staff.id}`, roles: ['Admin'] },
  { method: 'patch', path: () => `/api/users/${users.Staff.id}`, roles: ['Admin'], body: { name: 'x' } },
  { method: 'get', path: () => '/api/templates', roles: ['Admin', 'Staff'] },
  { method: 'post', path: () => '/api/templates', roles: ['Admin'], body: {} },
  { method: 'get', path: () => `/api/templates/${templateId}`, roles: ['Admin', 'Staff'] },
  { method: 'put', path: () => `/api/templates/${templateId}`, roles: ['Admin'], body: {} },
  { method: 'patch', path: () => `/api/templates/${templateId}/archive`, roles: ['Admin'] },
  { method: 'patch', path: () => `/api/templates/${templateId}/order`, roles: ['Admin'], body: {} },
  { method: 'post', path: () => `/api/templates/${templateId}/duplicate`, roles: ['Admin'], body: { title: 'x' } },
];

const call = (route, headers = {}) => {
  const req = request(app)[route.method](route.path()).set(headers);
  return route.body ? req.send(route.body) : req;
};

async function makeUser(role, { active = true } = {}) {
  const email = `test-sec-${role.toLowerCase()}-${active ? 'on' : 'off'}-${run}@example.test`;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const { rows } = await pool.db().query(
    `INSERT INTO users (name, email, password_hash, role, active) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [`Test ${role}`, email, hash, role, active]
  );
  emails.push(email);
  return { id: rows[0].id, email, token: signToken(rows[0].id) };
}

before(async () => {
  if (SKIP) return;
  app = require('../src/app');
  pool = require('../src/db/pool');
  ({ signToken } = require('../src/lib/tokens'));
  users.Admin = await makeUser('Admin');
  users.Staff = await makeUser('Staff');
  users.Customer = await makeUser('Customer');
  users.Inactive = await makeUser('Admin', { active: false });

  const { rows } = await pool.db().query(
    `INSERT INTO templates (title, created_by) VALUES ($1, $2) RETURNING id`,
    [`Security test ${run}`, users.Admin.id]
  );
  templateId = rows[0].id;
  await pool.db().query(
    `INSERT INTO template_tasks (template_id, title, position, visibility, actor) VALUES ($1, 'Only task', 1, 'customer', 'staff')`,
    [templateId]
  );
});

after(async () => {
  if (SKIP) return;
  await pool.db().query('DELETE FROM templates WHERE id = $1', [templateId]);
  await pool.db().query('DELETE FROM login_attempts WHERE email = ANY($1)', [emails]);
  await pool.db().query('UPDATE users SET active = false WHERE email = ANY($1)', [emails]);
  await pool.db().end();
});

// ---- missing, malformed and forged tokens ----------------------------------

test('every protected route -> 401 without a token', { skip: SKIP }, async () => {
  for (const route of ROUTES) {
    const res = await call(route);
    assert.strictEqual(res.status, 401, `${route.method.toUpperCase()} ${route.path()}`);
    assert.deepStrictEqual(res.body, { error: 'Authentication required' });
  }
});

test('token in the wrong place or format -> 401', { skip: SKIP }, async () => {
  const t = users.Admin.token;
  const get = (headers, path = '/api/users') => request(app).get(path).set(headers);
  assert.strictEqual((await get({ Authorization: t })).status, 401); // no "Bearer"
  assert.strictEqual((await get({ Authorization: `Basic ${t}` })).status, 401);
  assert.strictEqual((await get({ Authorization: `Bearer ${t} extra` })).status, 401);
  assert.strictEqual((await get({}, `/api/users?token=${t}`)).status, 401); // tokens are not read from the URL
  assert.strictEqual((await get({ Cookie: `token=${t}` })).status, 401); // or from cookies
});

test('expired, tampered, wrongly signed and "alg: none" tokens -> 401 on real routes', { skip: SKIP }, async () => {
  const secret = process.env.JWT_SECRET;
  const sub = String(users.Admin.id);
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const valid = users.Admin.token;
  const [h, , s] = valid.split('.');

  const bad = {
    expired: jwt.sign({ sub, iss: ISS, aud: AUD, exp: Math.floor(Date.now() / 1000) - 5 }, secret, { algorithm: 'HS256' }),
    otherSecret: jwt.sign({ sub, iss: ISS, aud: AUD }, 'a-different-secret-that-is-also-long-enough', { algorithm: 'HS256', expiresIn: '1h' }),
    wrongIssuer: jwt.sign({ sub, iss: 'someone-else', aud: AUD }, secret, { algorithm: 'HS256', expiresIn: '1h' }),
    wrongAudience: jwt.sign({ sub, iss: ISS, aud: 'another-app' }, secret, { algorithm: 'HS256', expiresIn: '1h' }),
    hs512: jwt.sign({ sub, iss: ISS, aud: AUD }, secret, { algorithm: 'HS512', expiresIn: '1h' }),
    // Payload swapped to claim the Customer is user 1 (signature no longer matches).
    tampered: `${h}.${part({ sub: String(users.Customer.id), iss: ISS, aud: AUD, exp: Math.floor(Date.now() / 1000) + 3600 })}.${s}`,
    algNone: `${part({ alg: 'none', typ: 'JWT' })}.${part({ sub, iss: ISS, aud: AUD })}.`,
    noSubject: jwt.sign({ iss: ISS, aud: AUD }, secret, { algorithm: 'HS256', expiresIn: '1h' }),
    unknownUser: jwt.sign({}, secret, { algorithm: 'HS256', subject: '2147483000', issuer: ISS, audience: AUD, expiresIn: '1h' }),
  };
  for (const [name, token] of Object.entries(bad)) {
    const res = await request(app).get('/api/users').set(bearer(token));
    assert.strictEqual(res.status, 401, name);
    assert.deepStrictEqual(res.body, { error: 'Invalid or expired token' }, name);
  }
});

test('deactivated user -> 401 on every route, even with a token that has not expired', { skip: SKIP }, async () => {
  for (const route of ROUTES) {
    const res = await call(route, bearer(users.Inactive.token));
    assert.strictEqual(res.status, 401, `${route.method.toUpperCase()} ${route.path()}`);
  }
});

// ---- wrong role ------------------------------------------------------------------

test('every route refuses roles that are not allowed -> 403, and each refusal is audited', { skip: SKIP }, async () => {
  const start = await pool.db().query('SELECT COALESCE(MAX(id), 0) AS id FROM audit_log');
  let denials = 0;
  for (const route of ROUTES) {
    for (const role of ['Admin', 'Staff', 'Customer']) {
      if (route.roles.includes(role)) continue;
      const res = await call(route, bearer(users[role].token));
      assert.strictEqual(res.status, 403, `${role} ${route.method.toUpperCase()} ${route.path()}`);
      assert.deepStrictEqual(res.body, { error: 'You do not have permission to do this' });
      denials += 1;
    }
  }
  const { rows } = await pool.db().query(
    `SELECT COUNT(*)::int AS n FROM audit_log
      WHERE id > $1 AND action = 'access_denied' AND result = 'denied'
        AND actor_id = ANY($2)`,
    [start.rows[0].id, [users.Staff.id, users.Customer.id]]
  );
  assert.strictEqual(rows[0].n, denials);
});

test('a Staff user cannot make themselves Admin', { skip: SKIP }, async () => {
  const res = await request(app).patch(`/api/users/${users.Staff.id}`).set(bearer(users.Staff.token)).send({ role: 'Admin' });
  assert.strictEqual(res.status, 403);
  const { rows } = await pool.db().query('SELECT role FROM users WHERE id = $1', [users.Staff.id]);
  assert.strictEqual(rows[0].role, 'Staff');
});

// ---- login brute force and what gets logged -----------------------------------

test('lockout: 429 with Retry-After, correct password still refused, lockout audited', { skip: SKIP }, async () => {
  const u = users.Customer;
  const login = (password) => request(app).post('/api/auth/login').set(fromIp(70)).send({ email: u.email, password });
  for (let i = 0; i < 4; i += 1) assert.strictEqual((await login('wrong-password')).status, 401);
  const fifth = await login('wrong-password');
  assert.strictEqual(fifth.status, 429);
  assert.ok(Number(fifth.headers['retry-after']) > 0);
  assert.strictEqual((await login(PASSWORD)).status, 429);

  const { rows } = await pool.db().query(
    `SELECT action FROM audit_log WHERE actor_id = $1 AND action IN ('login_failed', 'login_locked') ORDER BY id`,
    [u.id]
  );
  assert.deepStrictEqual(rows.map((r) => r.action), ['login_failed', 'login_failed', 'login_failed', 'login_failed', 'login_failed', 'login_locked']);
});

test('lockout response is the same for an email that does not exist', { skip: SKIP }, async () => {
  const ghost = `ghost-${run}@example.test`;
  emails.push(ghost);
  const login = () => request(app).post('/api/auth/login').set(fromIp(71)).send({ email: ghost, password: 'wrong-password' });
  for (let i = 0; i < 4; i += 1) assert.strictEqual((await login()).status, 401);
  const res = await login();
  assert.strictEqual(res.status, 429);
  assert.deepStrictEqual(res.body, { error: 'Too many failed attempts. Try again later.' });
});

test('the audit log never stores typed emails or passwords from login attempts', { skip: SKIP }, async () => {
  const start = await pool.db().query('SELECT COALESCE(MAX(id), 0) AS id FROM audit_log');
  const typed = `typo-${run}@example.test`;
  await request(app).post('/api/auth/login').set(fromIp(72)).send({ email: typed, password: `secret-${run}` });
  await request(app).post('/api/auth/login').set(fromIp(72)).send({ email: users.Staff.email, password: `secret-${run}` });
  const { rows } = await pool.db().query(
    `SELECT COUNT(*)::int AS n FROM audit_log
      WHERE id > $4 AND action LIKE 'login%'
        AND (entity_id LIKE $1 OR entity_id LIKE $2 OR entity_id LIKE $3)`,
    [`%${run}@example.test`, `%secret-${run}%`, '%@%', start.rows[0].id]
  );
  assert.strictEqual(rows[0].n, 0);
});

test('login response and user responses never contain the password hash', { skip: SKIP }, async () => {
  const login = await request(app).post('/api/auth/login').set(fromIp(73)).send({ email: users.Staff.email, password: PASSWORD });
  assert.strictEqual(login.status, 200);
  assert.ok(!JSON.stringify(login.body).includes('$2'));
  const list = await request(app).get('/api/users?active=all').set(bearer(users.Admin.token));
  assert.ok(!JSON.stringify(list.body).includes('password'));
  assert.ok(!JSON.stringify(list.body).includes('$2'));
});

test('error responses have no stack traces or SQL details', { skip: SKIP }, async () => {
  const cases = [
    request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":'),
    request(app).get('/api/templates/1%27%20OR%201=1').set(bearer(users.Admin.token)),
    // Larger than a Postgres INTEGER: must be 404, not a 500 from the database.
    request(app).get('/api/templates/9999999999').set(bearer(users.Admin.token)),
    request(app).get('/api/users/2147483648').set(bearer(users.Admin.token)),
    request(app).patch('/api/templates/9999999999/order').set(bearer(users.Admin.token)).send({ taskIds: [1] }),
    request(app).post('/api/users').set(bearer(users.Admin.token)).send({ name: 'x', email: "a'@b.c", password: 'short', role: 'Admin' }),
  ];
  for (const res of await Promise.all(cases)) {
    assert.ok([400, 404].includes(res.status), String(res.status));
    assert.deepStrictEqual(Object.keys(res.body), ['error']);
    assert.ok(!/at .+\.js|SELECT|INSERT|syntax/i.test(res.body.error), res.body.error);
  }
});
