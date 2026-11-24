# GitHub issues to create

One issue per row. Use the title as the issue title, paste the acceptance criteria into the description, assign the owner, and add a label for the week (`week-1` … `week-5`).

## Hana Fady

| Week | Title | Acceptance criteria |
|---|---|---|
| 1 | Repository structure, branches and README | Folder layout, `.gitignore` excludes `.env`, `.env.example` committed, feature branches created, README explains setup |
| 1 | Database schema and roles | `schema.sql` creates all tables; `roles.sql` creates `app_rw`, `dashboard_ro`, `notifier` with least privilege; both run on Neon dev and main |
| 2 | Login endpoint | `POST /api/auth/login` returns a signed JWT; bcryptjs hashes; same error for wrong email or password; 429 after repeated failures; login events in the audit log |
| 2 | Token, role and active-user middleware | Missing/invalid/expired token → 401; wrong role → 403; deactivated user → 401 even with a valid token |
| 2 | Template create / list / get / edit / archive with task rules | Endpoints from proposal 5.1; visibility, actor and offset_days validated; edit increases the version; archive blocks new plans only |
| 3 | Admin user accounts | `POST/GET/PATCH /api/users`; Admin only; role change and deactivation audited; no delete |
| 3 | Template reorder, duplicate and search | `PATCH /:id/order`, `POST /:id/duplicate`, `GET ?search=&status=` |
| 3 | Login and token security tests | Expired, tampered and missing tokens; deactivated user; lockout; wrong-role access |
| 3 | Draft threat model | Section 6.4 threats mapped to implemented controls |
| 4 | Login, template and user screens | Login page, template list/editor, Admin users page; text shown with `textContent` |
| 4 | Postman collections: login, users, templates | Success and error cases (400/401/403/404/409/429) exported to `docs/postman/` |
| 5 | Security review and regression tests | All role and token tests pass against the deployed API |

## Hana Anwar and Jana Hossam

Create your own issues from the work plan (proposal section 7) in the same format.
