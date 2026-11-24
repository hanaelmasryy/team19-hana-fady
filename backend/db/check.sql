-- =====================================================================
-- Database security and rule checks (evidence for proposal 6.2 / 6.4)
-- Owner: Hana Fady
--
-- Run after schema.sql and roles.sql, as the database owner:
--     psql "<owner connection string>" -f backend/db/check.sql
-- Every line of output should say PASS. Nothing is kept: the whole
-- script runs in one transaction that is rolled back at the end.
--
-- roles.sql already lets the owner switch into the three roles. If you
-- set the roles up with an older roles.sql, first run once:
--     GRANT app_rw, dashboard_ro, notifier TO neondb_owner;
-- =====================================================================

BEGIN;

-- Sample data for the checks
INSERT INTO users (id, name, email, password_hash, role) VALUES
  (9001, 'Check Admin',    'check-admin@example.com',    'x', 'Admin'),
  (9002, 'Check Staff',    'check-staff@example.com',    'x', 'Staff'),
  (9003, 'Check Customer', 'check-customer@example.com', 'x', 'Customer');
INSERT INTO templates (id, title, created_by) VALUES (9001, 'Check template', 9001);
INSERT INTO onboarding_plans (id, template_id, template_version, customer_id, title, start_date)
  VALUES (9001, 9001, 1, 9003, 'Check plan', CURRENT_DATE);
INSERT INTO tasks (id, plan_id, title, position, visibility, actor, assignee_id, due_date)
  VALUES (9001, 9001, 'Check task', 1, 'customer', 'customer', 9003, CURRENT_DATE);
INSERT INTO internal_notes (plan_id, author_id, body) VALUES (9001, 9002, 'secret note');
INSERT INTO audit_log (actor_id, action, result) VALUES (9001, 'check', 'allowed');

-- Helper: run a statement as a role and report whether it was allowed.
CREATE FUNCTION pg_temp.expect(role_name TEXT, stmt TEXT, should_work BOOLEAN, label TEXT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  worked BOOLEAN := TRUE;
BEGIN
  BEGIN
    IF role_name IS NOT NULL THEN
      EXECUTE format('SET LOCAL ROLE %I', role_name);
    END IF;
    EXECUTE stmt;
    RAISE EXCEPTION 'rollback_probe';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM <> 'rollback_probe' THEN worked := FALSE; END IF;
  END;
  RESET ROLE;
  RETURN CASE WHEN worked = should_work THEN 'PASS  ' ELSE 'FAIL  ' END || label;
END $$;

SELECT result AS "check" FROM (VALUES
  -- dashboard_ro: read-only, no secrets, no notes
  (pg_temp.expect('dashboard_ro', 'SELECT id, name, role, active FROM users', TRUE,  'dashboard_ro can read user names and roles')),
  (pg_temp.expect('dashboard_ro', 'SELECT password_hash FROM users',          FALSE, 'dashboard_ro cannot read password hashes')),
  (pg_temp.expect('dashboard_ro', 'SELECT email FROM users',                  FALSE, 'dashboard_ro cannot read emails')),
  (pg_temp.expect('dashboard_ro', 'SELECT * FROM internal_notes',             FALSE, 'dashboard_ro cannot read internal notes')),
  (pg_temp.expect('dashboard_ro', 'SELECT count(*) FROM tasks',               TRUE,  'dashboard_ro can read tasks')),
  (pg_temp.expect('dashboard_ro', $q$UPDATE tasks SET status = 'Done', completed_at = now()$q$, FALSE, 'dashboard_ro cannot change tasks')),
  (pg_temp.expect('dashboard_ro', 'DELETE FROM onboarding_plans',             FALSE, 'dashboard_ro cannot delete plans')),

  -- notifier: read plans/tasks, add notifications only
  (pg_temp.expect('notifier', 'SELECT count(*) FROM tasks',                   TRUE,  'notifier can read tasks')),
  (pg_temp.expect('notifier', $q$INSERT INTO notifications (user_id, plan_id, task_id, type, channel) VALUES (9003, 9001, 9001, 'overdue', 'in_app')$q$, TRUE, 'notifier can add a notification')),
  (pg_temp.expect('notifier', 'UPDATE notifications SET read_at = now()',     FALSE, 'notifier cannot change notifications')),
  (pg_temp.expect('notifier', $q$UPDATE tasks SET title = 'x'$q$,             FALSE, 'notifier cannot change tasks')),
  (pg_temp.expect('notifier', 'SELECT * FROM internal_notes',                 FALSE, 'notifier cannot read internal notes')),
  (pg_temp.expect('notifier', 'SELECT password_hash FROM users',              FALSE, 'notifier cannot read password hashes')),

  -- app_rw: normal API role, audit log insert-only
  (pg_temp.expect('app_rw', $q$INSERT INTO audit_log (action, result) VALUES ('login', 'allowed')$q$, TRUE, 'app_rw can add audit entries')),
  (pg_temp.expect('app_rw', $q$UPDATE audit_log SET result = 'allowed'$q$,    FALSE, 'app_rw cannot edit audit entries')),
  (pg_temp.expect('app_rw', 'DELETE FROM audit_log',                          FALSE, 'app_rw cannot delete audit entries')),
  (pg_temp.expect('app_rw', $q$UPDATE templates SET title = 'Edited'$q$,      TRUE,  'app_rw can edit templates')),
  (pg_temp.expect('app_rw', 'CREATE TABLE sneaky (id INT)',                   FALSE, 'app_rw cannot create tables')),

  -- Data rules enforced by the database itself
  (pg_temp.expect(NULL, $q$INSERT INTO template_tasks (template_id, title, position, visibility, actor) VALUES (9001, 'x', 1, 'internal', 'customer')$q$, FALSE, 'customer cannot be the actor of an internal task')),
  (pg_temp.expect(NULL, $q$INSERT INTO template_tasks (template_id, title, position, visibility, actor, offset_days) VALUES (9001, 'x', 1, 'customer', 'staff', -1)$q$, FALSE, 'negative due-date offset rejected')),
  (pg_temp.expect(NULL, $q$INSERT INTO users (name, email, password_hash, role) VALUES ('x', 'Mixed@Example.com', 'x', 'Staff')$q$, FALSE, 'emails must be stored in lower case')),
  (pg_temp.expect(NULL, $q$INSERT INTO users (name, email, password_hash, role) VALUES ('x', 'check-staff@example.com', 'x', 'Staff')$q$, FALSE, 'duplicate email rejected')),
  (pg_temp.expect(NULL, $q$INSERT INTO users (name, email, password_hash, role) VALUES ('x', 'role@example.com', 'x', 'Owner')$q$, FALSE, 'unknown role rejected')),
  (pg_temp.expect(NULL, $q$UPDATE onboarding_plans SET status = 'Cancelled' WHERE id = 9001$q$, FALSE, 'cancelling a plan needs a reason')),
  (pg_temp.expect(NULL, $q$UPDATE tasks SET status = 'Done' WHERE id = 9001$q$, FALSE, 'a Done task must record completed_at')),
  (pg_temp.expect(NULL, $q$INSERT INTO notifications (user_id, plan_id, task_id, type, channel) VALUES (9003, 9001, 9001, 'assigned', 'email'), (9003, 9001, 9001, 'assigned', 'email')$q$, FALSE, 'duplicate notification on the same day rejected'))
) AS t(result);

ROLLBACK;
