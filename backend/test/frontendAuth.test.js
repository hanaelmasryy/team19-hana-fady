// Unit tests for the browser login helpers in frontend/js/auth.js (issue #10).
// They run under Node with the rest of the tests; no browser or database needed.

const { test } = require('node:test');
const assert = require('node:assert');
const auth = require('../../frontend/js/auth.js');

function fakeToken(payload) {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.signature`;
}

test('tokenExpiry reads exp from the token (in milliseconds)', () => {
  assert.strictEqual(auth.tokenExpiry(fakeToken({ sub: '1', exp: 1800000000 })), 1800000000 * 1000);
});

test('tokenExpiry returns null for anything that is not a usable token', () => {
  for (const bad of [undefined, null, '', 'abc', 'a.b', 'a.b.c', fakeToken({ sub: '1' }), fakeToken({ exp: 'soon' })]) {
    assert.strictEqual(auth.tokenExpiry(bad), null, String(bad));
  }
});

test('isExpired: expired, about to expire and unreadable tokens count as expired', () => {
  const now = 1_000_000_000_000;
  const inSeconds = (s) => fakeToken({ sub: '1', exp: Math.floor(now / 1000) + s });
  assert.strictEqual(auth.isExpired(inSeconds(3600), now), false);
  assert.strictEqual(auth.isExpired(inSeconds(-1), now), true);
  assert.strictEqual(auth.isExpired(inSeconds(10), now), true); // within the 30 s margin
  assert.strictEqual(auth.isExpired('garbage', now), true);
});

test('each role sees only its own pages', () => {
  const hrefs = (role) => auth.pagesFor(role).map((p) => p.href);
  assert.ok(hrefs('Admin').includes('users.html'));
  assert.ok(hrefs('Admin').includes('audit.html'));
  assert.ok(!hrefs('Staff').includes('users.html'));
  assert.ok(!hrefs('Staff').includes('audit.html'));
  assert.deepStrictEqual(hrefs('Customer').sort(), ['home.html', 'plans.html']);
  assert.deepStrictEqual(hrefs('Intruder'), []);
});

test('canOpen matches the page list', () => {
  assert.strictEqual(auth.canOpen('Admin', 'users.html'), true);
  assert.strictEqual(auth.canOpen('Customer', 'users.html'), false);
  assert.strictEqual(auth.canOpen('Customer', 'plans.html'), true);
  assert.strictEqual(auth.canOpen('Admin', 'not-a-page.html'), false);
});

test('safeNext only allows pages of this site (no open redirect)', () => {
  assert.strictEqual(auth.safeNext('plans.html'), 'plans.html');
  assert.strictEqual(auth.safeNext('plans.html?id=12'), 'plans.html?id=12');
  for (const bad of [
    'https://evil.example/login.html',
    '//evil.example/a.html',
    'javascript:alert(1)',
    '../secret.html',
    'plans.html#x',
    '',
    null,
  ]) {
    assert.strictEqual(auth.safeNext(bad), null, String(bad));
  }
});
