// Basic API tests that need no database.
// Run with: npm test

const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

process.env.CORS_ORIGINS = 'https://frontend.example.com';
const app = require('../src/app');

test('GET /api/health returns ok', async () => {
  const res = await request(app).get('/api/health');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { status: 'ok' });
});

test('unknown API route returns 404 JSON', async () => {
  const res = await request(app).get('/api/does-not-exist');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, 'Not found');
});

test('malformed JSON returns 400 without internal details', async () => {
  const res = await request(app)
    .post('/api/anything')
    .set('Content-Type', 'application/json')
    .send('{"broken":');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'Invalid JSON body');
  assert.ok(!JSON.stringify(res.body).includes('SyntaxError'));
});

test('CORS allows the configured frontend origin', async () => {
  const res = await request(app)
    .get('/api/health')
    .set('Origin', 'https://frontend.example.com');
  assert.strictEqual(res.headers['access-control-allow-origin'], 'https://frontend.example.com');
});

test('CORS lets the frontend read Retry-After (login lockout time)', async () => {
  const res = await request(app)
    .get('/api/health')
    .set('Origin', 'https://frontend.example.com');
  assert.match(res.headers['access-control-expose-headers'] || '', /Retry-After/);
});

test('CORS does not allow other origins', async () => {
  const res = await request(app)
    .get('/api/health')
    .set('Origin', 'https://evil.example.com');
  assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
});

test('X-Powered-By header is not sent', async () => {
  const res = await request(app).get('/api/health');
  assert.strictEqual(res.headers['x-powered-by'], undefined);
});

test('security headers are sent on every API response (#12)', async () => {
  for (const path of ['/api/health', '/api/does-not-exist']) {
    const res = await request(app).get(path);
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff', path);
    assert.strictEqual(res.headers['x-frame-options'], 'DENY', path);
    assert.strictEqual(res.headers['referrer-policy'], 'no-referrer', path);
    assert.strictEqual(res.headers['cache-control'], 'no-store', path);
    assert.match(res.headers['content-security-policy'] || '', /default-src 'none'/, path);
    assert.match(res.headers['content-security-policy'] || '', /frame-ancestors 'none'/, path);
    assert.match(res.headers['strict-transport-security'] || '', /max-age=\d+/, path);
  }
});

test('security headers are also sent on errors (malformed JSON)', async () => {
  const res = await request(app)
    .post('/api/anything')
    .set('Content-Type', 'application/json')
    .send('{"broken":');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(res.headers['cache-control'], 'no-store');
});
