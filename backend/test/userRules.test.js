// Unit tests for the user-account input rules (issue #6). No database needed.

const { test } = require('node:test');
const assert = require('node:assert');
const { validateNewUser, validateUserUpdate } = require('../src/lib/userRules');

const good = { name: '  Sara Ali ', email: ' Sara@Example.COM ', password: 'a-long-password-123', role: 'Staff' };

test('valid new user is cleaned: name trimmed, email lowercased', () => {
  const { value, error } = validateNewUser(good);
  assert.strictEqual(error, undefined);
  assert.deepStrictEqual(value, { name: 'Sara Ali', email: 'sara@example.com', password: 'a-long-password-123', role: 'Staff' });
});

test('extra fields such as password_hash or id are ignored (no mass assignment)', () => {
  const { value } = validateNewUser({ ...good, password_hash: 'x', id: 1, active: false });
  assert.deepStrictEqual(Object.keys(value).sort(), ['email', 'name', 'password', 'role']);
});

test('missing or bad fields are rejected with a clear message', () => {
  assert.match(validateNewUser({ ...good, name: '   ' }).error, /name/);
  assert.match(validateNewUser({ ...good, name: 'x'.repeat(101) }).error, /100/);
  assert.match(validateNewUser({ ...good, email: 'not-an-email' }).error, /email/);
  assert.match(validateNewUser({ ...good, email: 'a b@c.d' }).error, /email/);
  assert.match(validateNewUser({ ...good, password: 'short' }).error, /at least 12/);
  assert.match(validateNewUser({ ...good, password: 'x'.repeat(201) }).error, /at most 200/);
  assert.match(validateNewUser({ ...good, password: 123456789012345 }).error, /password/);
  assert.match(validateNewUser({ ...good, role: 'admin' }).error, /role/);
  assert.match(validateNewUser({ ...good, role: 'Superuser' }).error, /role/);
  assert.match(validateNewUser([]).error, /JSON object/);
  assert.match(validateNewUser(null).error, /JSON object/);
});

test('update accepts any of name, role, active', () => {
  assert.deepStrictEqual(validateUserUpdate({ role: 'Customer' }).value, { role: 'Customer' });
  assert.deepStrictEqual(validateUserUpdate({ active: false }).value, { active: false });
  assert.deepStrictEqual(validateUserUpdate({ name: ' New ' }).value, { name: 'New' });
});

test('update rejects empty bodies, bad values and fields it does not handle', () => {
  assert.match(validateUserUpdate({}).error, /at least one/);
  assert.match(validateUserUpdate({ email: 'x@y.z' }).error, /at least one/);
  assert.match(validateUserUpdate({ password: 'new-password-123' }).error, /at least one/);
  assert.match(validateUserUpdate({ active: 'false' }).error, /true or false/);
  assert.match(validateUserUpdate({ role: 'Owner' }).error, /role/);
});
