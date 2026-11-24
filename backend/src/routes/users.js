// Auth & identity (shared task): Admin user accounts. Owner: Hana Fady (issue #6)
//
//   POST  /api/users      Admin  create an account and give it a role        201
//   GET   /api/users      Admin  list users (?role=&active=&search=)          200
//   GET   /api/users/:id  Admin  one user                                     200
//   PATCH /api/users/:id  Admin  change name or role, deactivate/reactivate   200
//
// Errors: 400 bad input, 401 not logged in, 403 not Admin, 404 unknown user,
//         409 email already used, or a change that would lock everyone out
//         (changing your own role, deactivating yourself, removing the last
//         active Admin), or a role change while the user still owns work
//         (open staff tasks -> can't become Customer; customer of an Active
//         plan -> can't become Staff/Admin).
//
// Rules from the proposal: accounts are created only by an Admin (no
// self-registration), users are never deleted (audit entries point to
// them), and password_hash is never returned. Deactivation takes effect
// at once: requireAuth reads the active flag on every request, so the
// user's existing token stops working immediately.

const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { inTransaction } = require('../db/transaction');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { validateNewUser, validateUserUpdate, ROLES } = require('../lib/userRules');
const { parseId } = require('../lib/templateRules');
const { searchPattern } = require('../lib/search');

const router = express.Router();

const BCRYPT_COST = 12;
const USER_COLUMNS = 'id, name, email, role, active, created_at, updated_at';

// Whitelist of fields sent to the client. password_hash is never selected.
function toUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const audit = (req, action, entityId, result = 'allowed') =>
  recordAudit({ actorId: req.user.id, action, entity: 'user', entityId, result, ip: req.ip });

// ---- create ------------------------------------------------------------------
router.post('/users', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const input = validateNewUser(req.body);
    if (input.error) return res.status(400).json({ error: input.error });
    const { name, email, password, role } = input.value;

    const hash = await bcrypt.hash(password, BCRYPT_COST);
    let row;
    try {
      const { rows } = await pool.db().query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, $4)
         RETURNING ${USER_COLUMNS}`,
        [name, email, hash, role]
      );
      row = rows[0];
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A user with this email already exists' });
      }
      throw err;
    }

    await audit(req, 'user_create', row.id);
    return res.status(201).json(toUser(row));
  } catch (err) {
    return next(err);
  }
});

// ---- list ------------------------------------------------------------------------
router.get('/users', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const { role, active, search } = req.query;
    if (role !== undefined && !ROLES.includes(role)) {
      return res.status(400).json({ error: "role must be 'Admin', 'Staff' or 'Customer'" });
    }
    if (active !== undefined && !['true', 'false', 'all'].includes(active)) {
      return res.status(400).json({ error: "active must be 'true', 'false' or 'all'" });
    }
    const term = searchPattern(search);
    if (term.error) return res.status(400).json({ error: term.error });
    const activeFilter = active === undefined ? 'true' : active; // default: active users only

    const { rows } = await pool.db().query(
      `SELECT ${USER_COLUMNS}
         FROM users
        WHERE ($1::text IS NULL OR role = $1)
          AND ($2 = 'all' OR active = ($2 = 'true'))
          AND ($3::text IS NULL OR name ILIKE $3 OR email ILIKE $3)
        ORDER BY name, id`,
      [role || null, activeFilter, term.value]
    );
    return res.json(rows.map(toUser));
  } catch (err) {
    return next(err);
  }
});

// ---- get one ---------------------------------------------------------------------
router.get('/users/:id', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'User not found' });
    const { rows } = await pool.db().query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    return res.json(toUser(rows[0]));
  } catch (err) {
    return next(err);
  }
});

// ---- update: name, role, active -------------------------------------------------
router.patch('/users/:id', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'User not found' });
    const input = validateUserUpdate(req.body);
    if (input.error) return res.status(400).json({ error: input.error });
    const changes = input.value;

    const outcome = await inTransaction(async (client) => {
      const { rows } = await client.query(
        'SELECT id, role, active FROM users WHERE id = $1 FOR UPDATE',
        [id]
      );
      const current = rows[0];
      if (!current) return { status: 404 };

      const roleChanges = changes.role !== undefined && changes.role !== current.role;
      const activeChanges = changes.active !== undefined && changes.active !== current.active;

      // An Admin cannot lock themselves out.
      if (id === req.user.id && (roleChanges || (activeChanges && !changes.active))) {
        return { status: 409, error: 'You cannot change your own role or deactivate yourself' };
      }

      // There must always be at least one active Admin.
      const losesAdmin = current.role === 'Admin' && current.active
        && ((roleChanges && changes.role !== 'Admin') || (activeChanges && !changes.active));
      if (losesAdmin) {
        const others = await client.query(
          `SELECT id FROM users WHERE role = 'Admin' AND active AND id <> $1 FOR UPDATE`,
          [id]
        );
        if (others.rows.length === 0) {
          return { status: 409, error: 'At least one active Admin is required' };
        }
      }

      // A role change must not leave work with someone who can no longer do
      // it, or let a customer read the staff side of their own plan
      // (review of PR #32). Deactivation is still allowed: the dashboard's
      // "inactive owners" list shows that work for reassignment.
      if (roleChanges) {
        const wasStaffSide = current.role !== 'Customer';
        const willBeStaffSide = changes.role !== 'Customer';
        if (wasStaffSide && !willBeStaffSide) {
          const open = await client.query(
            `SELECT COUNT(*)::int AS n
               FROM tasks t JOIN onboarding_plans p ON p.id = t.plan_id
              WHERE t.assignee_id = $1 AND t.actor = 'staff'
                AND t.status <> 'Done' AND p.status = 'Active'`,
            [id]
          );
          if (open.rows[0].n > 0) {
            const n = open.rows[0].n;
            return {
              status: 409,
              error: `This user still has ${n} open staff task${n === 1 ? '' : 's'} on active plans. Reassign ${n === 1 ? 'it' : 'them'} before making them a Customer.`,
            };
          }
        }
        if (!wasStaffSide && willBeStaffSide) {
          const plans = await client.query(
            `SELECT COUNT(*)::int AS n FROM onboarding_plans WHERE customer_id = $1 AND status = 'Active'`,
            [id]
          );
          if (plans.rows[0].n > 0) {
            const n = plans.rows[0].n;
            return {
              status: 409,
              error: `This user is the customer of ${n} active onboarding plan${n === 1 ? '' : 's'}. Complete or cancel ${n === 1 ? 'it' : 'them'} before giving them a staff role.`,
            };
          }
        }
      }

      const { rows: updated } = await client.query(
        `UPDATE users
            SET name = COALESCE($2, name),
                role = COALESCE($3, role),
                active = COALESCE($4, active),
                updated_at = now()
          WHERE id = $1
          RETURNING ${USER_COLUMNS}`,
        [id, changes.name ?? null, changes.role ?? null, changes.active ?? null]
      );
      return { status: 200, user: updated[0], roleChanges, activeChanges };
    });

    if (outcome.status === 404) return res.status(404).json({ error: 'User not found' });
    if (outcome.status === 409) {
      await audit(req, 'user_update', id, 'denied');
      return res.status(409).json({ error: outcome.error });
    }

    // One audit entry per kind of change, so role changes and deactivations
    // are easy to find (proposal 6.2 "Logging").
    if (outcome.roleChanges) await audit(req, 'user_role_change', id);
    if (outcome.activeChanges) await audit(req, outcome.user.active ? 'user_reactivate' : 'user_deactivate', id);
    if (changes.name !== undefined) await audit(req, 'user_update', id);

    return res.json(toUser(outcome.user));
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
