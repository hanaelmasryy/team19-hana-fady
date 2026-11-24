-- =====================================================================
-- Customer Onboarding Checklist Portal (Team 19) - database roles
-- Owner: Hana Fady (database setup lead)
--
-- Run AFTER schema.sql, as the Neon project owner (neondb_owner),
-- once on the dev branch and once on the main branch.
--
-- Before running, replace the three CHANGE_ME passwords with long random
-- values (Neon rejects weak passwords for roles created in SQL). Example:
--     node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
-- Never commit the real passwords. They only go into the connection
-- strings stored in Vercel environment variables.
--
-- Three roles, least privilege (proposal sections 4.4 and 6.2):
--   app_rw        -> DATABASE_URL           the API's normal role
--   dashboard_ro  -> DASHBOARD_DATABASE_URL dashboard read-only queries
--   notifier      -> NOTIFIER_DATABASE_URL  daily job: read + add notifications
-- =====================================================================

BEGIN;

CREATE ROLE app_rw       WITH LOGIN PASSWORD 'CHANGE_ME_APP_RW';
CREATE ROLE dashboard_ro WITH LOGIN PASSWORD 'CHANGE_ME_DASHBOARD_RO';
CREATE ROLE notifier     WITH LOGIN PASSWORD 'CHANGE_ME_NOTIFIER';

-- Start from nothing, then grant only what each role needs.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM app_rw, dashboard_ro, notifier;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM app_rw, dashboard_ro, notifier;
GRANT USAGE ON SCHEMA public TO app_rw, dashboard_ro, notifier;

-- ---------------------------------------------------------------------
-- app_rw: the Express API
-- Full read/write on application tables, but the audit log is
-- insert-only: no UPDATE or DELETE, so entries cannot be changed.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
    users, login_attempts, templates, template_tasks,
    onboarding_plans, tasks, internal_notes, notifications
TO app_rw;
GRANT SELECT, INSERT ON audit_log TO app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;

-- ---------------------------------------------------------------------
-- dashboard_ro: dashboard and audit-log read APIs
-- Read-only. Cannot see password hashes, emails or internal notes.
-- ---------------------------------------------------------------------
GRANT SELECT (id, name, role, active) ON users TO dashboard_ro;
GRANT SELECT ON templates, onboarding_plans, tasks, audit_log TO dashboard_ro;

-- ---------------------------------------------------------------------
-- notifier: the daily notification job
-- Reads plans and tasks, reads user name/email to address messages,
-- and can only ADD rows to notifications.
-- ---------------------------------------------------------------------
GRANT SELECT (id, name, email, role, active) ON users TO notifier;
GRANT SELECT ON onboarding_plans, tasks TO notifier;
GRANT SELECT, INSERT ON notifications TO notifier;
GRANT USAGE, SELECT ON SEQUENCE notifications_id_seq TO notifier;

-- ---------------------------------------------------------------------
-- Let the owner switch into these roles. Needed on Neon so check.sql
-- can test each role with SET ROLE (otherwise every "can" check fails).
-- This gives the roles no extra rights; the owner already has full access.
-- ---------------------------------------------------------------------
GRANT app_rw, dashboard_ro, notifier TO neondb_owner;

COMMIT;
