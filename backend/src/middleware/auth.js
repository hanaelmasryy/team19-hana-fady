// Security middleware used by every protected route. Owner: Hana Fady.
//
//   requireAuth          -> 401 if the token is missing, invalid or expired,
//                           or the user no longer exists or is deactivated
//   requireRole(...)     -> 403 if the user's role is not allowed (audited)
//
// Usage in a route file:
//   const { requireAuth, requireRole } = require('../middleware/auth');
//   router.post('/templates', requireAuth, requireRole('Admin'), handler);
//
// After requireAuth, req.user = { id, name, role } read fresh from the
// database, so role changes and deactivation apply immediately.
// Ownership checks ("is this my plan?") stay in each route, because only
// the route knows which record is being accessed.

const pool = require('../db/pool');
const { verifyToken } = require('../lib/tokens');
const { recordAudit } = require('../lib/audit');

function readBearerToken(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
  return match ? match[1] : null;
}

async function requireAuth(req, res, next) {
  try {
    const token = readBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userId = verifyToken(token);
    if (!userId) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { rows } = await pool.db().query(
      'SELECT id, name, role, active FROM users WHERE id = $1',
      [userId]
    );
    const user = rows[0];
    if (!user || !user.active) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = { id: user.id, name: user.name, role: user.role };
    return next();
  } catch (err) {
    return next(err);
  }
}

function requireRole(...allowedRoles) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      await recordAudit({
        actorId: req.user.id,
        action: 'access_denied',
        entity: 'route',
        entityId: `${req.method} ${req.baseUrl}${req.route ? req.route.path : req.path}`,
        result: 'denied',
        ip: req.ip,
      });
      return res.status(403).json({ error: 'You do not have permission to do this' });
    }
    return next();
  };
}

module.exports = { requireAuth, requireRole };
