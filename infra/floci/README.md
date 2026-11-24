# Floci: RDS PostgreSQL + IAM (Hana Fady)

The live portal runs on Neon + Vercel. For Weeks 4–5 we also show the **same system on an AWS architecture**, emulated with [Floci](https://github.com/floci-io/floci) (a free local AWS emulator). This folder is the **database and identity** part: Amazon RDS for PostgreSQL and the IAM roles and policies that control who can reach it.

Other parts of the AWS version are owned by the others: plan events to SQS (Hana Anwar, #26) and docker-compose, Secrets Manager and CI for the app (Jana, #43).

## What it builds

| Neon version (live) | AWS version (Floci) |
|---|---|
| Neon PostgreSQL | **RDS PostgreSQL** `team19-db`: storage encrypted, not public, deletion protection, 7-day backups |
| Owner password in a password manager | **RDS-managed master password** kept in **Secrets Manager**; it is never written in the repo, a file or the log |
| `app_rw`, `dashboard_ro`, `notifier` log in with passwords | The same 3 database roles from `backend/db/roles.sql`, switched to **IAM login** (`rds_iam`): only a 15-minute IAM token works, passwords are refused |
| One connection string per role in Vercel | **One IAM role per part of the app**, each allowed to log in **only as its own database user** |

| IAM role | Can | Cannot |
|---|---|---|
| `team19-api` | log in as `app_rw` | log in as any other user; touch the RDS instance; any IAM action |
| `team19-dashboard` | log in as `dashboard_ro` | same as above |
| `team19-notifier` | log in as `notifier` | same as above |
| `team19-db-admin` | read settings; take snapshots and add tags **of `team19-db` only** | read app data (`rds-db:connect` denied); change settings (`rds:ModifyDBInstance` denied: it could reset the master password, turn IAM login off or make the database public); delete the database or snapshots; any IAM action |

Policies are in [`iam/`](iam). Every role also has an explicit **Deny** on `iam:*` and `sts:AssumeRole`, so a stolen role session can't give itself more rights.

## What the tests prove (`test.sh`)

All checks are real requests under Floci's **IAM policy enforcement**:

1. **RDS settings**: IAM login on, encrypted, not public, deletion protection, backups, master secret in Secrets Manager.
2. **Logins**: each role can log in only as its own DB user; a token for another user, a tampered token, the master user and a plain password are all refused.
3. **Inside the database**: the least-privilege grants from `roles.sql` hold over IAM sessions (e.g. `dashboard_ro` can't read password hashes, `app_rw` can't edit the audit log), and an IAM session can't switch back to the master user.
4. **AWS API calls**: the app roles can't create IAM users, delete or change the database, or read the master secret; `team19-db-admin` can read the settings but can't reset the master password, turn IAM login off, delete the database or raise its own rights; deletion protection stops even the administrator.
5. **Policy simulation** (`iam simulate-principal-policy`): the allow / implicit deny / explicit deny decision for each role and action.
6. **`backend/db/check.sql`** runs on RDS: all role and data-rule checks pass.

Results are shown on the GitHub Actions run page (**Summary**) and saved as the `floci-rds-iam-results` artifact.

## Run it

**On GitHub (no setup):** every push that changes `infra/floci/`, `backend/db/` or the workflow runs **Actions → Floci – RDS and IAM security tests**. It can also be started by hand there (**Run workflow**).

**On your laptop** (Docker Desktop + Git Bash, AWS CLI, `psql` and `jq`):

```bash
docker run -d --name floci -u root -p 4566:4566 -p 7001-7020:7001-7020 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e FLOCI_SERVICES_IAM_ENFORCEMENT_ENABLED=true \
  -e FLOCI_SERVICES_RDS_PROXY_BASE_PORT=7001 -e FLOCI_SERVICES_RDS_PROXY_MAX_PORT=7020 \
  -e FLOCI_SERVICES_RDS_ENDPOINT_HOST=localhost \
  floci/floci:2.5.0

bash infra/floci/setup.sh
bash infra/floci/test.sh
docker rm -f floci        # when finished (also remove the team19-db container Floci started)
```

## Notes and limits

- The access key `test` is Floci's **bootstrap administrator** (it bypasses enforcement). `setup.sh` uses it only to build things; the tests act as the IAM roles. In real AWS this would be the deployer's own identity, never long-lived keys in code.
- In real AWS the app would get its role from where it runs (ECS task role or Lambda execution role) instead of calling `sts:AssumeRole`; the trust policy here lets the account assume the roles so the tests can act as each part of the app.
- Floci 2.5 evaluates RDS **API** calls against `Resource: "*"` (its IAM resource table lists RDS as not read yet). So `team19-db-admin`'s permissions that are scoped to `team19-db` only (snapshots, tags) are proven with `iam simulate-principal-policy` (section 5) instead of a live call. On real AWS the same policy works as written. Database **logins** (`rds-db:connect`) are scoped per DB user and enforced live.
- RDS IAM tokens last 15 minutes and are tied to the endpoint (host, port, region) and DB user they were made for.
- Floci is an emulator: it checks IAM policies and RDS IAM logins the way AWS documents them, but it is not a substitute for testing on a real AWS account.
