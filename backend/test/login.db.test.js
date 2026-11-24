// Login tests against a real database (issue #3).
//
// Runs only when DATABASE_URL is set (from backend/.env). Use the DEV
// branch, never production. The tests create users with emails ending in
// @example.test, then deactivate them and clear their login attempts.
// (Users can't be deleted because their audit entries point to them.)

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
const bcrypt = require('bcryptjs');

let app;
let pool;
const run = crypto.randomBytes(4).toString('hex');
const PASSWORD = `Pw-${crypto.randomBytes(8).toString('hex')}`;
const created = [];

// Each test uses its own pretend client IP, so lockouts don't leak between tests.
const fromIp = (n) => ({ 'X-Forwarded-For': `203.0.113.${n}` });

async function makeUser(label, { role = 'Admin', active = true } = {}) {
  const email = `test-${label}-${run}@example.test`;
  const hash = await bcrypt.hash(PASSWORD, 4); // low cost: fast tests
  const { rows } = await pool.db().query(
    `INSERT INTO users (name, email, password_hash, role, active)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [`Test ${label}`, email, hash, role, active]
  );
  created.push(email);
  return { id: rows[0].id, email };
}

before(async () => {
  if (SKIP) return;
  app = require('../src/app');
  pool = require('../src/db/pool');
});

after(async () => {
  if (SKIP) return;
  await pool.db().query('DELETE FROM login_attempts WHERE email LIKE $1', [`%-${run}@example.test`]);
  await pool.db().query('UPDATE users SET active = false WHERE email = ANY($1)', [created]);
  await pool.db().end();
});

const login = (body, ip) => request(app).post('/api/auth/login').set(fromIp(ip)).send(body);

test('correct email and password -> 200 with token and user', { skip: SKIP }, async () => {
  const u = await makeUser('ok');
  const res = await login({ email: u.email, password: PASSWORD }, 1);
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.token.split('.').length === 3);
  assert.deepStrictEqual(res.body.user, { id: u.id, name: 'Test ok', role: 'Admin' });
  assert.ok(!JSON.stringify(res.body).includes('password'));
});

test('email is case-insensitive', { skip: SKIP }, async () => {
  const u = await makeUser('case');
  const res = await login({ email: u.email.toUpperCase(), password: PASSWORD }, 2);
  assert.strictEqual(res.status, 200);
});

test('wrong password and unknown email give the same 401 message', { skip: SKIP }, async () => {
  const u = await makeUser('wrong');
  const a = await login({ email: u.email, password: 'wrong-password' }, 3);
  const b = await login({ email: `nobody-${run}@example.test`, password: 'wrong-password' }, 3);
  assert.strictEqual(a.status, 401);
  assert.strictEqual(b.status, 401);
  assert.strictEqual(a.body.error, b.body.error);
});

test('missing or non-text fields -> 400', { skip: SKIP }, async () => {
  assert.strictEqual((await login({ email: 'a@b.c' }, 4)).status, 400);
  assert.strictEqual((await login({ email: 123, password: 'x' }, 4)).status, 400);
  assert.strictEqual((await login({}, 4)).status, 400);
});

test('deactivated account cannot log in, even with the right password', { skip: SKIP }, async () => {
  const u = await makeUser('inactive', { active: false });
  const res = await login({ email: u.email, password: PASSWORD }, 5);
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.error, 'Invalid email or password');
});

test('5 failed attempts lock the account for this IP -> 429, even with the right password', { skip: SKIP }, async () => {
  const u = await makeUser('lock');
  for (let i = 1; i <= 4; i += 1) {
    assert.strictEqual((await login({ email: u.email, password: 'bad' }, 6)).status, 401);
  }
  const fifth = await login({ email: u.email, password: 'bad' }, 6);
  assert.strictEqual(fifth.status, 429);
  assert.ok(Number(fifth.headers['retry-after']) > 0);

  const correctButLocked = await login({ email: u.email, password: PASSWORD }, 6);
  assert.strictEqual(correctButLocked.status, 429);

  // A different IP is not blocked by this lock.
  assert.strictEqual((await login({ email: u.email, password: PASSWORD }, 7)).status, 200);
});

test('successful login resets the failure counter', { skip: SKIP }, async () => {
  const u = await makeUser('reset');
  for (let i = 1; i <= 3; i += 1) await login({ email: u.email, password: 'bad' }, 8);
  assert.strictEqual((await login({ email: u.email, password: PASSWORD }, 8)).status, 200);
  for (let i = 1; i <= 4; i += 1) {
    assert.strictEqual((await login({ email: u.email, password: 'bad' }, 8)).status, 401);
  }
});

test('logins and failures are written to the audit log', { skip: SKIP }, async () => {
  const u = await makeUser('audit');
  await login({ email: u.email, password: 'bad' }, 9);
  await login({ email: u.email, password: PASSWORD }, 9);
  const { rows } = await pool.db().query(
    `SELECT action, result FROM audit_log WHERE actor_id = $1 ORDER BY id`,
    [u.id]
  );
  assert.deepStrictEqual(rows, [
    { action: 'login_failed', result: 'denied' },
    { action: 'login', result: 'allowed' },
  ]);
});

test('the token from login opens a protected route', { skip: SKIP }, async () => {
  const express = require('express');
  const { requireAuth } = require('../src/middleware/auth');
  const mini = express();
  mini.get('/me', requireAuth, (req, res) => res.json(req.user));

  const u = await makeUser('token', { role: 'Staff' });
  const { body } = await login({ email: u.email, password: PASSWORD }, 10);
  const res = await request(mini).get('/me').set('Authorization', `Bearer ${body.token}`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { id: u.id, name: 'Test token', role: 'Staff' });
});
