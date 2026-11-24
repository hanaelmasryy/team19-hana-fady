# Team 19 – Hana Fady: individual proof of work

**Course:** Cloud Computing and Cloud Security · **Project:** Customer Onboarding Checklist Portal (Team 19)
**Team repository (all members, full history and reviews):** https://github.com/hanaelmasryy/Onboarding-portal-team19
**Live site:** https://team19-web.vercel.app · **API:** https://team19-api.vercel.app

My role in the team: **Template & Workflow Rules** service, and lead for **login / user accounts** and the **database and its security**. In Weeks 4–5 I also built the **database and identity part of the AWS version on Floci** (RDS PostgreSQL + IAM) and the **security review**.

This repository contains only the files I wrote. Every part below links to the pull request in the team repository where it was reviewed by a teammate and merged, so the full history, discussions and reviews can be checked there.

## What I built

| Week | Work | Team-repo pull request | Files here |
|---|---|---|---|
| 1 | Repository structure, README, branches, issues (#1–#12); database schema, three least-privilege database roles and 26 security checks, on Neon dev and main | direct commits (16–17 Nov), fix in [#13](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/13) | `backend/db/schema.sql`, `roles.sql`, `check.sql`, `docs/issues.md` |
| 2 | Login with brute-force lockout, JWT tokens, role and active-user middleware, audit log helper | [#29](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/29) | `backend/src/routes/auth.js`, `src/lib/tokens.js`, `src/middleware/auth.js`, `src/lib/audit.js` |
| 2 | Templates API with workflow rules (versions, task rules, archive) | [#30](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/30) | `backend/src/routes/templates.js`, `src/lib/templateRules.js` |
| 3 | Admin user accounts; template search, reorder and duplicate; login/token security tests; first threat model | [#32](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/32) | `src/routes/users.js`, `src/lib/userRules.js`, `src/lib/search.js`, `src/db/transaction.js`, `test/security.db.test.js` |
| 3 | Review follow-up: refuse role changes while a user still owns open work | [#53](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/53) | `src/routes/users.js`, `test/users.db.test.js` |
| 4 | Login page, home page and shared login helpers used by every screen | [#51](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/51) | `frontend/login.html`, `home.html`, `index.html`, `js/auth.js`, `js/api.js`, `docs/frontend-guide.md` |
| 4 | Templates screen and users screen (Admin and Staff) | [#52](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/52) | `frontend/templates.html`, `users.html`, `js/templates.js`, `js/users.js`, `js/ui.js` |
| 4 | Postman / Newman collection: 54 requests, 103 checks, 0 failed; `npm run postman` | [#54](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/54) | `docs/postman/auth-users-templates.postman_collection.json`, `backend/scripts/postman.js` |
| 4–5 | **Floci (AWS emulator): RDS PostgreSQL + IAM roles/policies**, 43 security checks under IAM enforcement | [#55](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/55) | `infra/floci/` |
| 5 | **Security review:** security headers on the API and website, regression tests against the live site, final threat model | [#56](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/56) | `backend/src/app.js`, `frontend/vercel.json`, `docs/postman/deployed-regression.postman_collection.json`, `docs/security/threat-model.md` |

I also reviewed my teammates' pull requests: Hana Anwar's [#14](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/14) and [#31](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/31), and Jana Hossam's [#33](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/33), [#49](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/49) and [#50](https://github.com/hanaelmasryy/Onboarding-portal-team19/pull/50).

## Security highlights
- Passwords hashed with bcrypt; the same answer for a wrong email, a wrong password or a deactivated account; 5 failures from one email and IP lock it for 15 minutes.
- JWT (HS256 only, issuer and audience fixed, 1 hour); the role and active flag are read from the database on every request, so a role change or deactivation applies at once.
- Every query is parameterised; input is validated; search text is escaped; only known fields are read from a request body.
- Database: three roles with least privilege; the audit log is insert-only; 26 allow/deny checks in `check.sql`.
- AWS version (Floci): one IAM role per service, each allowed to log in to RDS only as its own database user, with IAM-only logins, encryption, deletion protection and the master password kept in Secrets Manager.
- Full threat model with 16 threats, controls, evidence and remaining risks: [`docs/security/threat-model.md`](docs/security/threat-model.md).

## Run it
```bash
cd backend
npm install
npm test          # unit and API tests; database tests are skipped without a database
```
With a PostgreSQL database (`backend/.env` from `.env.example`, after `db/schema.sql` and `db/roles.sql`), `npm test` also runs the database tests, and `npm run dev` starts the API for my routes (login, users, templates).

Floci (RDS + IAM): see [`infra/floci/README.md`](infra/floci/README.md); it runs in GitHub Actions with no setup.

## About this repository
- `backend/src/app.js` mounts only my routes. In the team repository it also mounts Hana Anwar's plans routes and Jana Hossam's dashboard routes.
- `backend/src/db/pool.js` and `backend/package.json` were started by me in Week 1 and are shared by the whole team.
- No secrets are stored here: `.env` files are ignored and the database passwords in `roles.sql` are placeholders.
