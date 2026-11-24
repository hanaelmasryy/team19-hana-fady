// Auth & identity - input validation for Admin user accounts. Owner: Hana Fady (issue #6).
//
// Pure functions (no database), so the rules can be unit-tested anywhere.
// Only the fields listed here are ever read from the request body, so a
// client cannot set password_hash, id, created_at or similar ("mass
// assignment" protection).

const ROLES = ['Admin', 'Staff', 'Customer'];
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 200;

function cleanName(value) {
  if (typeof value !== 'string') return { error: 'name is required' };
  const name = value.trim();
  if (!name) return { error: 'name is required' };
  if (name.length > 100) return { error: 'name must be at most 100 characters' };
  return { value: name };
}

function cleanEmail(value) {
  if (typeof value !== 'string') return { error: 'email is required' };
  const email = value.trim().toLowerCase();
  // Simple shape check: something@something.something, no spaces.
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: 'email must be a valid email address' };
  }
  return { value: email };
}

function cleanPassword(value) {
  if (typeof value !== 'string') return { error: 'password is required' };
  if (value.length < MIN_PASSWORD) {
    return { error: `password must be at least ${MIN_PASSWORD} characters` };
  }
  if (value.length > MAX_PASSWORD) {
    return { error: `password must be at most ${MAX_PASSWORD} characters` };
  }
  return { value };
}

function cleanRole(value) {
  if (!ROLES.includes(value)) return { error: "role must be 'Admin', 'Staff' or 'Customer'" };
  return { value };
}

function isObject(body) {
  return body && typeof body === 'object' && !Array.isArray(body);
}

// POST /api/users  body: { name, email, password, role }
function validateNewUser(body) {
  if (!isObject(body)) return { error: 'Request body must be a JSON object' };
  const name = cleanName(body.name);
  if (name.error) return name;
  const email = cleanEmail(body.email);
  if (email.error) return email;
  const password = cleanPassword(body.password);
  if (password.error) return password;
  const role = cleanRole(body.role);
  if (role.error) return role;
  return { value: { name: name.value, email: email.value, password: password.value, role: role.value } };
}

// PATCH /api/users/:id  body: any of { name, role, active }
// Email and password are not changed here (password reset is out of scope).
function validateUserUpdate(body) {
  if (!isObject(body)) return { error: 'Request body must be a JSON object' };
  const value = {};
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (name.error) return name;
    value.name = name.value;
  }
  if (body.role !== undefined) {
    const role = cleanRole(body.role);
    if (role.error) return role;
    value.role = role.value;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') return { error: 'active must be true or false' };
    value.active = body.active;
  }
  if (Object.keys(value).length === 0) {
    return { error: 'Send at least one of: name, role, active' };
  }
  return { value };
}

module.exports = { validateNewUser, validateUserUpdate, ROLES, MIN_PASSWORD };
