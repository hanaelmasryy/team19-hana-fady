# Threat model and security review (final, Week 5)

Customer Onboarding Checklist Portal · Team 19 · Owner: Hana Fady (issues #9 and #12)
Status: **final**. Draft in Week 3 (#9); reviewed and updated in Week 5 (#12) after all Week 3–4 work was merged. The review results are in section 5.

This document takes the 11 threats from proposal section 6.4 and records, for each one,
what is **already implemented** in the code, how it is **tested**, and what is still
**open**. File paths are relative to `backend/` unless stated otherwise.

Status key: ✅ implemented and tested · 🟡 partly done · ⏳ planned (owner and week given)

## 1. System and trust boundaries

```
Browser (HTML/CSS/JS on Vercel, strict Content-Security-Policy)
   │  HTTPS, Bearer token in the Authorization header
   ▼
Express API (one Vercel Function)  ── trust boundary: every request is checked here
   │  requireAuth → requireRole → ownership check in the route
   ├── app_rw        → Neon Postgres (all application tables; audit_log insert-only)
   ├── dashboard_ro  → Neon Postgres (read-only, no emails, no password hashes, no notes)
   └── notifier      → Neon Postgres (reads plans/tasks, can only add notifications)
Vercel Cron ──(CRON_SECRET)──► /api/jobs/notifications
```

AWS version on Floci (Weeks 4–5, `infra/floci/`, PR #55):

```
IAM role per service ── STS session (1 h) ──► rds generate-db-auth-token (15 min)
   team19-api       ── rds-db:connect ONLY as app_rw ───────┐
   team19-dashboard ── rds-db:connect ONLY as dashboard_ro ─┼─► RDS PostgreSQL team19-db
   team19-notifier  ── rds-db:connect ONLY as notifier ─────┘   (IAM-only logins, encrypted,
   team19-db-admin  ── snapshots/tags of team19-db only; DENY    not public, deletion protection,
                       on data access, settings changes, delete) master password in Secrets Manager)
```

Plan events on SQS (Hana Anwar, `infra/floci/sqs/`, PR #58):

```
team19-api ── sqs:SendMessage ONLY ──► team19-plan-events (encrypted) ── after 3 failed tries ──► team19-plan-events-dlq
                                              │
team19-notifier ── Receive/Delete ONLY ◄──────┘ ── IAM login as notifier ──► RDS: notifications
```

Assets to protect: customer plans and tasks, staff-only internal notes and internal tasks,
user accounts and password hashes, the JWT secret and database passwords, and the audit log.

Actors: Admin, Staff, Customer (all logged in), and an attacker who is either outside
(no account) or a logged-in Customer trying to reach more than their own data.

## 2. Threats and controls

| # | Threat (proposal 6.4) | Controls in place | Evidence (code / tests) | Status |
|---|---|---|---|---|
| 1 | Password theft or brute-force login | bcryptjs hashes (cost 12). Same `401 Invalid email or password` for a wrong email, wrong password or deactivated account. A dummy hash is checked for unknown emails, so timing does not reveal valid emails. 5 failures in 15 min from one email + IP → `429` with `Retry-After` for 15 min; the counter is in Neon (`login_attempts`), not in memory. Accounts are created only by an Admin (minimum password length 12); there is no self-registration. | `src/routes/auth.js`, `src/routes/users.js`, `src/lib/userRules.js`; `test/login.db.test.js`, `test/security.db.test.js` (lockout, same response for unknown email) | ✅ |
| 2 | User opens another customer's plan ID (IDOR) | Role checked by `requireRole` on every route. Plan routes check ownership and return `404` (not `403`) for plans that are not yours, so IDs cannot be probed. Malformed IDs are also `404`. | `src/middleware/auth.js`; plan routes (Hana Anwar, PR #31); `test/security.db.test.js` (403 on every template/user route for the wrong role) | ✅ plan, task and note routes check ownership and answer `404` for others' records (Hana Anwar, PRs #31 and #46: `test/plans.db.test.js`, `test/tasks.db.test.js`, `test/notes.db.test.js`). Live: every protected route refuses a request without a token (deployed regression, folder 3) |
| 3 | Internal notes leak through JSON | Internal tasks are filtered for customers in plan queries (PR #31). Responses are built from a whitelist (`toTemplate`, `toUser`), never `SELECT *`. `dashboard_ro` and `notifier` have no access to `internal_notes`. | `db/roles.sql`, `db/check.sql`; PR #31 | ✅ notes are Admin/Staff only and customers never get internal tasks (PR #46, `test/notes.db.test.js`, `test/plans.db.test.js`); `dashboard_ro`/`notifier` cannot read notes (`check.sql`, also on RDS in Floci) |
| 4 | SQL injection / malicious input | Every query uses parameters (`$1`, `$2`); no SQL is built from user text. Input is validated before use (`templateRules.js`, `userRules.js`): types, lengths, allowed values, 1–100 tasks. Search text is escaped so `%` and `_` are literal. JSON body limit 100 kb; bad JSON → `400`. Only known fields are read from the body, so a client cannot set `password_hash`, `id` or `active` on create. | `src/lib/search.js`, `src/lib/*Rules.js`; `test/templates.db.test.js` (`' OR 1=1 --` search), `test/userRules.test.js` (mass assignment), `test/security.db.test.js` (no SQL in errors) | ✅ |
| 5 | Exposed database, JWT or email API secret | Secrets only in Vercel environment variables and the git-ignored `backend/.env`; `.env.example` has placeholders only. The API refuses to start signing tokens if `JWT_SECRET` is missing or shorter than 32 characters. **Rotate on exposure** was used for real: on 17 Nov the role passwords were rotated on Neon dev and main after they appeared in a chat/screenshot, and the SQL editor history was cleared. | `.gitignore`, `src/lib/tokens.js`; `test/middleware.test.js` (weak secret fails closed) | ✅ In the Floci version the RDS master password is generated by RDS and kept only in Secrets Manager; the app roles have no passwords at all (IAM tokens), and the app roles are denied `GetSecretValue` on it (PR #55). See finding R2 in section 5 for the live database connection. |
| 6 | Misconfigured CORS or deployment settings | CORS allowlist from `CORS_ORIGINS` only; `X-Powered-By` off; no stack traces in error responses; HTTPS from Vercel. `trust proxy` is set to 1 hop so `req.ip` is the real client behind Vercel. | `src/app.js`; `test/app.test.js`, `test/security.db.test.js` | ✅ Checked on the live site (deployed regression, folders 1–2): only our website's origin is allowed, preflights from other sites get no permission, no stack traces or SQL in errors, `413` over 100 kb. Security headers added in Week 5 (finding R1) |
| 7 | Forged, stolen or expired token (including theft through XSS) | HS256 only (an `alg: none` or HS512 token is rejected), fixed issuer and audience, 1-hour lifetime, user id in `sub` only. Role and `active` are read from the database on every request, so a role change or deactivation applies to the next request. Tokens are accepted only in the `Authorization: Bearer` header (not in the URL or a cookie, so no CSRF). The frontend keeps the token in `sessionStorage` and writes text with `textContent`, not `innerHTML`. | `src/lib/tokens.js`, `src/middleware/auth.js`, `frontend/js/api.js`; `test/middleware.test.js`, `test/security.db.test.js` (expired, tampered, wrong secret/issuer/audience, `alg: none`, no subject, unknown user, deactivated user on every route) | ✅ Screens (#51, #52) use `textContent` only; the website now sends a strict Content-Security-Policy (`script-src 'self'`, no inline scripts, may only call our API), which blocks injected scripts even if an XSS bug appeared. Live: forged, malformed, expired and URL tokens are refused (deployed regression, folder 4) |
| 8 | Over-privileged database access | Three roles with least privilege; `audit_log` is insert-only for `app_rw`; `dashboard_ro` cannot see emails or password hashes; `notifier` can only add notifications. Separate dev and main branches with different passwords. `check.sql` proves 26 allow/deny rules. Since Week 3 the login audit entries store the user id, not the typed email, so emails don't reach `dashboard_ro` through the audit log. | `db/roles.sql`, `db/check.sql` (26/26 PASS on dev and main), `src/routes/auth.js`; `test/security.db.test.js` (no emails in audit rows) | ✅ AWS version done (PR #55): one IAM role per service, each may only `rds-db:connect` as its own DB user; the app roles are IAM-only in the database (`rds_iam`); `check.sql` 26/26 also on RDS; 46/46 Floci checks under IAM enforcement; the db-admin cannot change settings (finding R5) |
| 9 | Unauthorized call to the daily job or email flooding | `CRON_SECRET` checked in constant time and failing closed, notifier role can only insert, one notification per user/task/type/day (unique key). | Jana, PR #49: job tests in `test/dashboard.db.test.js` (wrong, near-miss and missing secret → `401`, audited; second run adds nothing) | ✅ PR #49 merged (24 Nov) |
| 10 | Customer changes a task they may not change (or reopens a Done task) | Template rule enforced at creation: a customer cannot be the actor of an internal task (checked in code and by a database constraint). Only the task's owner moves it forward (Not Started → In Progress → Done); only an Admin reopens a Done task; cancelled plans are read-only. | `src/lib/templateRules.js`, `db/schema.sql`; Hana Anwar, PR #46: `src/lib/planRules.js`, `test/planRules.test.js`, `test/tasks.db.test.js` | ✅ |
| 11 | Misuse goes unnoticed or is denied later | Insert-only `audit_log` with actor, action, record, result, IP and time. Logged so far: login, login_failed, login_inactive, login_locked, access_denied (every 403), template create/update/archive/reorder/duplicate, user create/role change/deactivate/reactivate/update (including refused self-lockout attempts). Passwords, tokens and note text are never logged. | `src/lib/audit.js`; audit checks in `test/login.db.test.js`, `test/templates.db.test.js`, `test/users.db.test.js`, `test/security.db.test.js` | ✅ Admin-only read API `GET /api/audit` on the read-only role (Jana, PR #45); plan and task events audited (Hana Anwar, PR #46) |

## 3. Extra threats found while building

| # | Threat | Control | Status |
|---|---|---|---|
| E1 | An Admin locks everyone out (demotes or deactivates the last Admin, or themselves) | `PATCH /api/users/:id` refuses with `409`: no changing your own role, no deactivating yourself, always at least one active Admin (checked inside a transaction with row locks). The refusal is audited. | ✅ `src/routes/users.js`, `test/users.db.test.js` |
| E2 | Privilege escalation through the users API (Staff makes themselves Admin) | Whole `/api/users` API is Admin-only; role is read from the database, not the token. | ✅ `test/security.db.test.js` |
| E3 | Account enumeration through the Admin API | Only an Admin can list users or learn that an email exists (`409` on create). | ✅ accepted |
| E4 | Two Admins edit or reorder the same template at once | Edit and reorder lock the template row (`FOR UPDATE`) and bump the version in one transaction. | ✅ `src/routes/templates.js` |
| E5 | A role change leaves work with the wrong person: Staff → Customer while assigned open staff tasks (no one can complete them), or Customer → Staff/Admin while the customer of an Active plan (they could then read the internal tasks and staff notes of their own plan) | `PATCH /api/users/:id` refuses both with `409` and a message saying what to do first (reassign the tasks / complete or cancel the plan); the refusal is audited. Deactivation is still allowed, and the open work shows up on the dashboard's inactive-owner list. Found in Hana Anwar's review of PR #32 | ✅ `src/routes/users.js`, `test/users.db.test.js` |
| E6 | Plan events on the SQS queue (AWS version): a stolen API session reads, deletes or purges events; the notifier injects fake events; a malformed or hostile message is saved or retried forever; events contain personal data | One least-privilege inline policy per role, scoped to the one queue ARN: `team19-api` may only `SendMessage`, `team19-notifier` may only receive/delete/change visibility; dashboard and db-admin get no SQS rights, and the existing explicit denies (`iam:*`, `sts:AssumeRole`) still apply. Both queues encrypted (SSE). Payloads carry ids only. The worker keeps only whitelisted fields of valid events, deletes a message only after saving it, and never logs bodies; anything else goes to the dead-letter queue after 3 tries. Saves are idempotent (`ON CONFLICT DO NOTHING`), so at-least-once delivery adds no duplicates. Hana Anwar, PR #58 | ✅ `infra/floci/sqs/test-sqs.sh`, GitHub Actions *Floci – plan events on SQS*: 28/28 (refusals per role, end to end API → SQS → worker → RDS, duplicates, injected value ends in the DLQ with nothing saved) |

## 4. Known limits (residual risk)

1. **Lockout is per email + IP.** One attacker IP cannot lock a real user out from other IPs (good against denial of service), but an attacker spreading guesses across many IPs is only slowed by bcrypt, not blocked. A per-account limit across all IPs, or a CAPTCHA, would be the next step; out of scope for this course.
2. **Tokens cannot be revoked one by one.** A stolen token works until it expires (max 1 hour) unless the user is deactivated. Changing `JWT_SECRET` logs everyone out.
3. **`sessionStorage` is readable by script.** If an XSS bug were introduced, the token could be stolen. Reduced in Week 5: the `textContent` rule plus a strict Content-Security-Policy (no inline or third-party scripts) means injected script would not run.
4. **No MFA, password reset or SSO** (listed as beyond the MVP in the proposal). A forgotten password needs an Admin.
5. **Admin accounts are powerful.** There is no second approval for role changes; this is covered by the audit log instead.
6. **Old audit rows from Week 2 may contain emails** in `entity_id` for failed logins (written before the Week 3 fix). On dev they are test data. The audit log is insert-only, so they stay; check main before go-live.
7. **Floci is an emulator.** Floci 2.5 checks RDS management API calls against `Resource: "*"`, so resource-scoped RDS permissions (the db-admin's snapshot and tag rights on `team19-db` only) are proven with the IAM policy simulator rather than a live call. Database logins (`rds-db:connect` per DB user) are enforced live.
8. **Role checks on the live site need test accounts.** The deployed regression runs the Staff/Customer role checks only when two low-privilege live test accounts are given as repository secrets (never an Admin). The same role rules are tested on every route against the dev database (`test/security.db.test.js`, Postman 103/103).
9. **Plan events (SQS).** Events are sent after the database commit, so an event is lost if the API process stops between the commit and the send (no outbox table); if the queue is unreachable, the API writes the notification directly instead, so in that case `app_rw` still needs to add notifications. Access is controlled by the roles' identity policies only; on real AWS a queue (resource) policy and an `aws:SecureTransport` deny would be added as a second layer (Floci serves plain HTTP locally).

## 5. Security review (Week 5, issue #12)

### 5.1 What was checked
| Check | Where | Result (24 Nov 2026) |
|---|---|---|
| Unit and database tests (all services) | `cd backend && npm test`, Neon **dev** | **174 / 175 pass**. The one failure is the known whole-table count in `dashboard.db.test.js` ("summary: counts go up…"), already fixed in Jana's PR #49 |
| Login, users, templates incl. security rules | `npm run postman` (Newman), local API on dev | **103 / 103** (PR #54) |
| Regression against the **deployed** API and website | `docs/postman/deployed-regression.postman_collection.json`, GitHub Actions *Deployed security regression* (after every deploy and daily) | Before this PR: CORS, 401 on all 22 protected routes, forged/expired/URL tokens, no error details, `413` – all pass; failures listed below as R1–R2 |
| Cloud: RDS + IAM on Floci | `infra/floci/test.sh`, GitHub Actions *Floci – RDS and IAM security tests* | **46 / 46** (PR #55, R5 fix in #59) |
| Cloud: plan events on SQS (Floci) | `infra/floci/sqs/test-sqs.sh`, GitHub Actions *Floci – plan events on SQS* | **28 / 28** (Hana Anwar, PR #58) |
| Database grants | `backend/db/check.sql` | **26 / 26** on Neon dev, main and on RDS (Floci) |

### 5.2 Findings
| # | Finding | Severity | Fix | Status |
|---|---|---|---|---|
| R1 | The live API sent no security headers (`Cache-Control: public` on JSON responses, no `nosniff`, no anti-framing), and the website had no Content-Security-Policy (known limit 3). | Medium | API: middleware in `src/app.js` adds `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, HSTS on every response, errors included (`test/app.test.js`). Website: `frontend/vercel.json` adds a strict CSP (`script-src 'self'`, `connect-src` only our API, `object-src 'none'`, `frame-ancestors 'none'`), `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS | ✅ this PR; checked on the live site by the deployed regression after deploy |
| R2 | On the live site, a login with an unknown email returned `500 Internal server error` instead of `401`. It fails before any password is checked, at the first database query, so the deployed API most likely cannot use the **main** database (for example a role password rotated after the Vercel `DATABASE_URL` was set). Every other live check fails earlier with `401`, so nothing else showed it. | High (no one can log in on the live site) | Check the Vercel runtime log for `/api/auth/login` and update `DATABASE_URL`, `DASHBOARD_DATABASE_URL`, `NOTIFIER_DATABASE_URL` for the **main** branch; then re-run the deployed regression | ⏳ Jana (Vercel projects); the regression now catches it automatically |
| R3 | A forged `alg: none` token is stopped by the Vercel firewall (plain `403`) before it reaches the API. | Info | Test accepts 401 or 403 and checks that no data is returned; the API itself rejects it too (`test/security.db.test.js`) | ✅ |
| R4 | `dashboard.db.test.js` compared whole-table totals, so it fails when test files run in parallel. | Low (test only) | Jana's PR #49 counts only its own plan | ✅ #49 merged |
| R5 | `team19-db-admin` was allowed `rds:ModifyDBInstance` on `team19-db`. That call can also reset the master password (then log in with a password and read all app data, getting around the `rds-db:connect` deny), turn IAM database login off or make the database public. IAM has no condition key that limits it to safe changes. Found in Hana Anwar's review of PR #55. | High (privilege escalation to all data) | `ModifyDBInstance` removed from the Allow and explicitly denied (`infra/floci/iam/db-admin-policy.json`); settings are changed only by the deployer identity. New tests: db-admin resetting the master password and turning IAM login off are refused (live), and the policy simulator gives `explicitDeny` | ✅ PR #59, 46/46 on Floci |

### 5.3 Conclusion
All 11 threats from proposal 6.4 and the 6 extra threats found while building have controls with tests. One item stays open until fixed by its owner: the live database connection (R2). The remaining risk is the list in section 4.

## 6. Who keeps it up to date
- Every PR that adds a route adds it to the deployed regression (folder 3) and to `test/security.db.test.js`.
- The deployed regression runs after every deploy and daily; a red run is a security bug until shown otherwise.
