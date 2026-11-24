// Template & Workflow Rules - Owner: Hana Fady (issue #5)
//
//   POST  /api/templates              Admin         create template with its tasks and rules   201
//   GET   /api/templates              Admin, Staff  list or search (?search=&status=active|archived|all) 200
//   GET   /api/templates/:id          Admin, Staff  one template with its ordered tasks         200
//   PUT   /api/templates/:id          Admin         edit template and task rules (version + 1)  200
//   PATCH /api/templates/:id/archive  Admin         archive (blocks new plans only)             200
//   PATCH /api/templates/:id/order    Admin         reorder tasks (version + 1)                 200   (issue #7)
//   POST  /api/templates/:id/duplicate Admin        copy a template and its tasks               201   (issue #7)
//
// Errors: 400 bad input, 401 not logged in, 403 wrong role,
//         404 unknown template, 409 editing or reordering an archived template.
// Running plans never change: they keep their own copy of the tasks
// (made by Plan & Task Management when a plan starts).

const express = require('express');
const pool = require('../db/pool');
const { inTransaction } = require('../db/transaction');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { validateTemplate, validateOrder, validateDuplicate, parseId } = require('../lib/templateRules');
const { searchPattern } = require('../lib/search');

const router = express.Router();

function toTemplate(row, tasks) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      position: t.position,
      offsetDays: t.offset_days,
      visibility: t.visibility,
      actor: t.actor,
    })),
  };
}

async function loadTemplate(client, id) {
  const { rows } = await client.query(
    `SELECT id, title, description, status, version, created_at, updated_at
       FROM templates WHERE id = $1`,
    [id]
  );
  if (!rows[0]) return null;
  const tasks = await client.query(
    `SELECT id, title, position, offset_days, visibility, actor
       FROM template_tasks WHERE template_id = $1 ORDER BY position`,
    [id]
  );
  return toTemplate(rows[0], tasks.rows);
}

async function insertTasks(client, templateId, tasks) {
  for (const t of tasks) {
    await client.query(
      `INSERT INTO template_tasks (template_id, title, position, offset_days, visibility, actor)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [templateId, t.title, t.position, t.offsetDays, t.visibility, t.actor]
    );
  }
}

// ---- create --------------------------------------------------------------
router.post('/templates', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const input = validateTemplate(req.body);
    if (input.error) return res.status(400).json({ error: input.error });
    const { title, description, tasks } = input.value;

    const template = await inTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO templates (title, description, created_by) VALUES ($1, $2, $3) RETURNING id`,
        [title, description, req.user.id]
      );
      await insertTasks(client, rows[0].id, tasks);
      return loadTemplate(client, rows[0].id);
    });

    await recordAudit({ actorId: req.user.id, action: 'template_create', entity: 'template', entityId: template.id, result: 'allowed', ip: req.ip });
    return res.status(201).json(template);
  } catch (err) {
    return next(err);
  }
});

// ---- list ------------------------------------------------------------------
router.get('/templates', requireAuth, requireRole('Admin', 'Staff'), async (req, res, next) => {
  try {
    const status = req.query.status || 'active';
    if (!['active', 'archived', 'all'].includes(status)) {
      return res.status(400).json({ error: "status must be 'active', 'archived' or 'all'" });
    }
    // Search matches the title or description, ignoring letter case.
    const search = searchPattern(req.query.search);
    if (search.error) return res.status(400).json({ error: search.error });
    const { rows } = await pool.db().query(
      `SELECT t.id, t.title, t.description, t.status, t.version, t.updated_at,
              COUNT(tt.id)::int AS task_count
         FROM templates t
         LEFT JOIN template_tasks tt ON tt.template_id = t.id
        WHERE ($1 = 'all' OR t.status = $1)
          AND ($2::text IS NULL OR t.title ILIKE $2 OR t.description ILIKE $2)
        GROUP BY t.id
        ORDER BY t.title, t.id`,
      [status, search.value]
    );
    return res.json(rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status,
      version: r.version,
      updatedAt: r.updated_at,
      taskCount: r.task_count,
    })));
  } catch (err) {
    return next(err);
  }
});

// ---- get one -------------------------------------------------------------
router.get('/templates/:id', requireAuth, requireRole('Admin', 'Staff'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const template = id && (await loadTemplate(pool.db(), id));
    if (!template) return res.status(404).json({ error: 'Template not found' });
    return res.json(template);
  } catch (err) {
    return next(err);
  }
});

// ---- edit (replaces title, description and the whole task list) ----------
router.put('/templates/:id', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Template not found' });
    const input = validateTemplate(req.body);
    if (input.error) return res.status(400).json({ error: input.error });
    const { title, description, tasks } = input.value;

    const outcome = await inTransaction(async (client) => {
      // Lock the row so two edits at once can't both bump the same version.
      const { rows } = await client.query('SELECT status FROM templates WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) return { status: 404 };
      if (rows[0].status === 'archived') return { status: 409 };

      await client.query(
        `UPDATE templates
            SET title = $2, description = $3, version = version + 1, updated_at = now()
          WHERE id = $1`,
        [id, title, description]
      );
      await client.query('DELETE FROM template_tasks WHERE template_id = $1', [id]);
      await insertTasks(client, id, tasks);
      return { status: 200, template: await loadTemplate(client, id) };
    });

    if (outcome.status === 404) return res.status(404).json({ error: 'Template not found' });
    if (outcome.status === 409) return res.status(409).json({ error: 'Archived templates cannot be edited' });

    await recordAudit({ actorId: req.user.id, action: 'template_update', entity: 'template', entityId: id, result: 'allowed', ip: req.ip });
    return res.json(outcome.template);
  } catch (err) {
    return next(err);
  }
});

// ---- archive -----------------------------------------------------------------
router.patch('/templates/:id/archive', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Template not found' });
    const { rowCount } = await pool.db().query(
      `UPDATE templates SET status = 'archived', updated_at = now() WHERE id = $1`,
      [id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Template not found' });

    await recordAudit({ actorId: req.user.id, action: 'template_archive', entity: 'template', entityId: id, result: 'allowed', ip: req.ip });
    return res.json(await loadTemplate(pool.db(), id));
  } catch (err) {
    return next(err);
  }
});

// ---- reorder tasks (issue #7) --------------------------------------------------
// Body: { "taskIds": [12, 10, 11] } - every task of the template, in the new order.
router.patch('/templates/:id/order', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Template not found' });
    const input = validateOrder(req.body);
    if (input.error) return res.status(400).json({ error: input.error });
    const taskIds = input.value;

    const outcome = await inTransaction(async (client) => {
      const { rows } = await client.query('SELECT status FROM templates WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) return { status: 404 };
      if (rows[0].status === 'archived') return { status: 409 };

      const current = await client.query('SELECT id FROM template_tasks WHERE template_id = $1', [id]);
      const currentIds = new Set(current.rows.map((r) => r.id));
      if (currentIds.size !== taskIds.length || !taskIds.every((t) => currentIds.has(t))) {
        return { status: 400 };
      }

      // New position = place in the list. The unique (template_id, position)
      // rule is checked at COMMIT, so positions can be swapped in one step.
      await client.query(
        `UPDATE template_tasks tt
            SET position = o.position
           FROM unnest($2::int[]) WITH ORDINALITY AS o(task_id, position)
          WHERE tt.id = o.task_id AND tt.template_id = $1`,
        [id, taskIds]
      );
      await client.query(
        'UPDATE templates SET version = version + 1, updated_at = now() WHERE id = $1',
        [id]
      );
      return { status: 200, template: await loadTemplate(client, id) };
    });

    if (outcome.status === 404) return res.status(404).json({ error: 'Template not found' });
    if (outcome.status === 409) return res.status(409).json({ error: 'Archived templates cannot be edited' });
    if (outcome.status === 400) {
      return res.status(400).json({ error: 'taskIds must list every task of this template exactly once' });
    }

    await recordAudit({ actorId: req.user.id, action: 'template_reorder', entity: 'template', entityId: id, result: 'allowed', ip: req.ip });
    return res.json(outcome.template);
  } catch (err) {
    return next(err);
  }
});

// ---- duplicate (issue #7) ------------------------------------------------------
// Body (optional): { "title": "New name" }. Default title: "Copy of <title>".
// Works on archived templates too, so an old template can be brought back as a
// new active one. The copy starts at version 1.
router.post('/templates/:id/duplicate', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Template not found' });
    const input = validateDuplicate(req.body);
    if (input.error) return res.status(400).json({ error: input.error });

    const copy = await inTransaction(async (client) => {
      const { rows } = await client.query('SELECT title, description FROM templates WHERE id = $1', [id]);
      if (!rows[0]) return null;
      const title = input.value || `Copy of ${rows[0].title}`.slice(0, 150);

      const created = await client.query(
        `INSERT INTO templates (title, description, created_by) VALUES ($1, $2, $3) RETURNING id`,
        [title, rows[0].description, req.user.id]
      );
      const newId = created.rows[0].id;
      await client.query(
        `INSERT INTO template_tasks (template_id, title, position, offset_days, visibility, actor)
         SELECT $2, title, position, offset_days, visibility, actor
           FROM template_tasks WHERE template_id = $1`,
        [id, newId]
      );
      return loadTemplate(client, newId);
    });

    if (!copy) return res.status(404).json({ error: 'Template not found' });

    await recordAudit({ actorId: req.user.id, action: 'template_duplicate', entity: 'template', entityId: copy.id, result: 'allowed', ip: req.ip });
    return res.status(201).json(copy);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
