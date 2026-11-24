-- =====================================================================
-- Customer Onboarding Checklist Portal (Team 19) - database schema
-- Owner: Hana Fady (database setup lead)
--
-- Run this FIRST, as the Neon project owner (neondb_owner), on the dev
-- branch, then on the main (production) branch. Then run roles.sql.
-- The script is safe to re-run on an empty database only.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Users (Auth & identity - shared task, Hana Fady)
-- Accounts are created by an Admin only. Users are deactivated, never deleted.
-- ---------------------------------------------------------------------
CREATE TABLE users (
    id             SERIAL PRIMARY KEY,
    name           TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    email          TEXT        NOT NULL CHECK (email = lower(email) AND char_length(email) <= 254),
    password_hash  TEXT        NOT NULL,
    role           TEXT        NOT NULL CHECK (role IN ('Admin', 'Staff', 'Customer')),
    active         BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_email_unique UNIQUE (email)
);

-- Failed-login counter. Stored in Neon because serverless memory is not
-- shared between requests. No foreign key: attempts are recorded even for
-- emails that do not exist (so the response cannot reveal which emails exist).
CREATE TABLE login_attempts (
    email          TEXT        NOT NULL,
    ip_address     TEXT        NOT NULL,
    failed_count   INTEGER     NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    last_failed_at TIMESTAMPTZ,
    locked_until   TIMESTAMPTZ,
    PRIMARY KEY (email, ip_address)
);

-- ---------------------------------------------------------------------
-- Template & Workflow Rules (Hana Fady)
-- ---------------------------------------------------------------------
CREATE TABLE templates (
    id           SERIAL PRIMARY KEY,
    title        TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 150),
    description  TEXT        CHECK (char_length(description) <= 2000),
    status       TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    version      INTEGER     NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by   INTEGER     REFERENCES users (id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Each template task carries its workflow rules:
--   visibility: who can see it  (internal = staff only, customer = customer can see it)
--   actor:      who completes it (staff or customer)
--   offset_days: due date = plan start date + offset_days
CREATE TABLE template_tasks (
    id           SERIAL PRIMARY KEY,
    template_id  INTEGER NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
    title        TEXT    NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    position     INTEGER NOT NULL CHECK (position >= 1),
    offset_days  INTEGER NOT NULL DEFAULT 0 CHECK (offset_days BETWEEN 0 AND 365),
    visibility   TEXT    NOT NULL CHECK (visibility IN ('internal', 'customer')),
    actor        TEXT    NOT NULL CHECK (actor IN ('staff', 'customer')),
    -- A customer can only complete a task they can see.
    CONSTRAINT template_tasks_actor_visible CHECK (NOT (actor = 'customer' AND visibility = 'internal')),
    -- Deferred so a reorder can swap positions inside one transaction.
    CONSTRAINT template_tasks_position_unique UNIQUE (template_id, position) DEFERRABLE INITIALLY DEFERRED
);

-- ---------------------------------------------------------------------
-- Plan & Task Management (Hana Anwar)
-- ---------------------------------------------------------------------
CREATE TABLE onboarding_plans (
    id                SERIAL PRIMARY KEY,
    template_id       INTEGER     NOT NULL REFERENCES templates (id),
    template_version  INTEGER     NOT NULL,
    customer_id       INTEGER     NOT NULL REFERENCES users (id),
    title             TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 150),
    start_date        DATE        NOT NULL,
    status            TEXT        NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Completed', 'Cancelled')),
    cancel_reason     TEXT        CHECK (char_length(cancel_reason) <= 500),
    created_by        INTEGER     REFERENCES users (id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT plans_cancel_reason CHECK (status <> 'Cancelled' OR cancel_reason IS NOT NULL)
);

-- Tasks are copied from template_tasks when a plan starts, so later
-- template edits or archiving never change a running plan.
CREATE TABLE tasks (
    id                SERIAL PRIMARY KEY,
    plan_id           INTEGER     NOT NULL REFERENCES onboarding_plans (id) ON DELETE CASCADE,
    template_task_id  INTEGER     REFERENCES template_tasks (id) ON DELETE SET NULL,
    title             TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    position          INTEGER     NOT NULL CHECK (position >= 1),
    visibility        TEXT        NOT NULL CHECK (visibility IN ('internal', 'customer')),
    actor             TEXT        NOT NULL CHECK (actor IN ('staff', 'customer')),
    assignee_id       INTEGER     REFERENCES users (id),
    due_date          DATE        NOT NULL,
    status            TEXT        NOT NULL DEFAULT 'Not Started' CHECK (status IN ('Not Started', 'In Progress', 'Done')),
    completed_at      TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT tasks_actor_visible CHECK (NOT (actor = 'customer' AND visibility = 'internal')),
    CONSTRAINT tasks_done_has_time CHECK ((status = 'Done') = (completed_at IS NOT NULL))
);

-- Internal notes live in their own table and are only returned by
-- staff-only endpoints. They are never joined into customer responses.
CREATE TABLE internal_notes (
    id          SERIAL PRIMARY KEY,
    plan_id     INTEGER     NOT NULL REFERENCES onboarding_plans (id) ON DELETE CASCADE,
    task_id     INTEGER     REFERENCES tasks (id) ON DELETE CASCADE,
    author_id   INTEGER     NOT NULL REFERENCES users (id),
    body        TEXT        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Dashboard & Monitoring (Jana Hossam)
-- ---------------------------------------------------------------------
-- In-app notifications (always) plus email records (when EMAIL_ENABLED).
-- The daily job writes here through the notifier role, which can only
-- read plans/tasks and INSERT rows into this table.
CREATE TABLE notifications (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER     NOT NULL REFERENCES users (id),
    plan_id          INTEGER     NOT NULL REFERENCES onboarding_plans (id) ON DELETE CASCADE,
    task_id          INTEGER     REFERENCES tasks (id) ON DELETE CASCADE,
    type             TEXT        NOT NULL CHECK (type IN ('assigned', 'overdue', 'at_risk')),
    channel          TEXT        NOT NULL CHECK (channel IN ('in_app', 'email')),
    delivery_status  TEXT        NOT NULL DEFAULT 'sent' CHECK (delivery_status IN ('sent', 'failed', 'skipped')),
    notify_date      DATE        NOT NULL DEFAULT CURRENT_DATE,
    read_at          TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one notification per user, plan, task, type, channel and day.
-- This is what stops the daily job from sending duplicates.
CREATE UNIQUE INDEX notifications_once_per_day
    ON notifications (user_id, plan_id, COALESCE(task_id, 0), type, channel, notify_date);

-- Insert-only security log. The app role gets SELECT and INSERT only
-- (see roles.sql), so entries cannot be edited or deleted by the API.
CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    actor_id    INTEGER     REFERENCES users (id),
    action      TEXT        NOT NULL CHECK (char_length(action) BETWEEN 1 AND 60),
    entity      TEXT        CHECK (char_length(entity) <= 60),
    entity_id   TEXT        CHECK (char_length(entity_id) <= 60),
    result      TEXT        NOT NULL CHECK (result IN ('allowed', 'denied')),
    ip_address  TEXT        CHECK (char_length(ip_address) <= 64),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Indexes for the common lookups
-- ---------------------------------------------------------------------
CREATE INDEX template_tasks_template_idx ON template_tasks (template_id, position);
CREATE INDEX plans_customer_idx          ON onboarding_plans (customer_id);
CREATE INDEX plans_status_idx            ON onboarding_plans (status);
CREATE INDEX tasks_plan_idx              ON tasks (plan_id, position);
CREATE INDEX tasks_assignee_idx          ON tasks (assignee_id);
CREATE INDEX tasks_due_open_idx          ON tasks (due_date) WHERE status <> 'Done';
CREATE INDEX notes_plan_idx              ON internal_notes (plan_id);
CREATE INDEX notifications_user_idx      ON notifications (user_id, read_at);
CREATE INDEX audit_created_idx           ON audit_log (created_at DESC);
CREATE INDEX audit_actor_idx             ON audit_log (actor_id);

COMMIT;
