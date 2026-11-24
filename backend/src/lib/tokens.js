// Signing and checking login tokens (JWT). Owner: Hana Fady.
//
// - HS256 only: the algorithm is fixed when verifying, so a token that
//   claims "alg: none" or another algorithm is rejected.
// - Short lifetime (1 hour). The token carries only the user id; the
//   role and active flag are read from the database on every request,
//   so a role change or deactivation takes effect immediately.

const jwt = require('jsonwebtoken');

const ISSUER = 'onboarding-portal-api';
const AUDIENCE = 'onboarding-portal';
const LIFETIME = '1h';

function getSecret() {
  const secret = process.env.JWT_SECRET || '';
  if (secret.length < 32) {
    // Fail closed: never sign or accept tokens with a missing or weak secret.
    throw new Error('JWT_SECRET is missing or shorter than 32 characters');
  }
  return secret;
}

function signToken(userId) {
  return jwt.sign({}, getSecret(), {
    algorithm: 'HS256',
    subject: String(userId),
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: LIFETIME,
  });
}

// Returns the user id from a valid token, or null if the token is
// missing, malformed, tampered with, expired or signed differently.
function verifyToken(token) {
  try {
    const payload = jwt.verify(token, getSecret(), {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const id = Number(payload.sub);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch (err) {
    if (err.message.startsWith('JWT_SECRET')) throw err;
    return null;
  }
}

module.exports = { signToken, verifyToken, LIFETIME };
