// Tests for the token, role and active-user middleware (issue #4).
// No database needed: the database is replaced by a small fake, so these
// tests run anywhere, including CI.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256-signing';

const pool = require('../src/db/pool');
const { signToken } = require('../src/lib/tokens');
const { requireAuth, requireRole } = require('../src/middleware/auth');

// ---- fake database ---------------------------------------------------
let users;
let auditRows;
pool.db = () => ({
  async query(sql, params) {
    if (sql.includes('FROM users WHERE id')) {
      const u = users[params[0]];
      return { rows: u ? [u] : [] };
    }
    if (sql.includes('INSERT INTO audit_log')) {
      auditRows.push({ actorId: params[0], action: params[1], result: params[4] });
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  },
});

beforeEach(() => {
  users = {
    1: { id: 1, name: 'Admin One', role: 'Admin', active: true },
    2: { id: 2, name: 'Staff Two', role: 'Staff', active: true },
    3: { id: 3, name: 'Gone Three', role: 'Admin', active: false },
  };
  auditRows = [];
});

// ---- tiny app using the middleware -------------------------------------
const app = express();
app.get('/admin-only', requireAuth, requireRole('Admin'), (req, res) => res.json(req.user));
app.get('/any-user', requireAuth, (req, res) => res.json(req.user));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(500).json({ error: 'Internal server error' }));

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

// ---- requireAuth ---------------------------------------------------------
test('no token -> 401', async () => {
  const res = await request(app).get('/any-user');
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.error, 'Authentication required');
});

test('wrong header format -> 401', async () => {
  const res = await request(app).get('/any-user').set('Authorization', `Token ${signToken(1)}`);
  assert.strictEqual(res.status, 401);
});

test('garbage token -> 401', async () => {
  const res = await request(app).get('/any-user').set(bearer('not.a.token'));
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.error, 'Invalid or expired token');
});

test('token signed with a different secret -> 401', async () => {
  const forged = jwt.sign({}, 'some-other-secret-that-is-also-long-enough', {
    algorithm: 'HS256', subject: '1', issuer: 'onboarding-portal-api', audience: 'onboarding-portal', expiresIn: '1h',
  });
  const res = await request(app).get('/any-user').set(bearer(forged));
  assert.strictEqual(res.status, 401);
});

test('tampered token (payload changed) -> 401', async () => {
  const [header, , signature] = signToken(2).split('.');
  const fakePayload = Buffer.from(JSON.stringify({ sub: '1' })).toString('base64url');
  const res = await request(app).get('/any-user').set(bearer(`${header}.${fakePayload}.${signature}`));
  assert.strictEqual(res.status, 401);
});

test('expired token -> 401', async () => {
  const expired = jwt.sign(
    { sub: '1', iss: 'onboarding-portal-api', aud: 'onboarding-portal', exp: Math.floor(Date.now() / 1000) - 10 },
    process.env.JWT_SECRET,
    { algorithm: 'HS256' }
  );
  const res = await request(app).get('/any-user').set(bearer(expired));
  assert.strictEqual(res.status, 401);
});

test('"alg: none" token -> 401', async () => {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${part({ alg: 'none', typ: 'JWT' })}.${part({ sub: '1', iss: 'onboarding-portal-api', aud: 'onboarding-portal' })}.`;
  const res = await request(app).get('/any-user').set(bearer(unsigned));
  assert.strictEqual(res.status, 401);
});

test('valid token for an active user -> 200 with user read from the database', async () => {
  const res = await request(app).get('/any-user').set(bearer(signToken(2)));
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { id: 2, name: 'Staff Two', role: 'Staff' });
});

test('deactivated user with a still-valid token -> 401', async () => {
  const res = await request(app).get('/any-user').set(bearer(signToken(3)));
  assert.strictEqual(res.status, 401);
});

test('deleted user with a still-valid token -> 401', async () => {
  const res = await request(app).get('/any-user').set(bearer(signToken(99)));
  assert.strictEqual(res.status, 401);
});

// ---- requireRole ---------------------------------------------------------
test('Admin route with Admin token -> 200', async () => {
  const res = await request(app).get('/admin-only').set(bearer(signToken(1)));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(auditRows.length, 0);
});

test('Admin route with Staff token -> 403 and the denial is audited', async () => {
  const res = await request(app).get('/admin-only').set(bearer(signToken(2)));
  assert.strictEqual(res.status, 403);
  assert.deepStrictEqual(auditRows, [{ actorId: 2, action: 'access_denied', result: 'denied' }]);
});

test('role change applies immediately (role comes from the database, not the token)', async () => {
  const token = signToken(1);
  users[1].role = 'Staff';
  const res = await request(app).get('/admin-only').set(bearer(token));
  assert.strictEqual(res.status, 403);
});

// ---- configuration -------------------------------------------------------
test('missing or short JWT_SECRET fails closed (500, no access)', async () => {
  const token = signToken(1);
  const saved = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'short';
  try {
    const res = await request(app).get('/any-user').set(bearer(token));
    assert.strictEqual(res.status, 500);
  } finally {
    process.env.JWT_SECRET = saved;
  }
});
