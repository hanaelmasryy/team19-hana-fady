#!/usr/bin/env bash
# =====================================================================
# Team 19 – Floci security tests for RDS PostgreSQL + IAM
# Owner: Hana Fady
#
# Run after setup.sh, against a Floci started with
#   FLOCI_SERVICES_IAM_ENFORCEMENT_ENABLED=true
# Every check is a real request: an IAM role logs in to the database
# with a short-lived IAM token, or calls an AWS API, and the test
# checks that it was allowed or refused as designed.
# Writes infra/floci/.state/results.md (also shown on the GitHub
# Actions run page) and exits 1 if any check fails.
# =====================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="${FLOCI_STATE_DIR:-$HERE/.state}"
# shellcheck disable=SC1091
source "$STATE/env"

export AWS_DEFAULT_REGION="$REGION"
export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
export AWS_PAGER=""
BOOT_KEY="${AWS_ACCESS_KEY_ID:-test}"
BOOT_SECRET="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_ACCESS_KEY_ID="$BOOT_KEY" AWS_SECRET_ACCESS_KEY="$BOOT_SECRET"

PASS=0
FAIL=0
RESULTS="$STATE/results.md"
SECTION=""
: > "$RESULTS.rows"

section() { SECTION="$1"; printf '\n## %s\n' "$1"; }

record() {  # ok|fail  label  detail
  local mark
  if [ "$1" = ok ]; then PASS=$((PASS + 1)); mark="PASS"; else FAIL=$((FAIL + 1)); mark="FAIL"; fi
  local detail="${3//|/\\|}"
  detail="${detail//$'\n'/ }"
  printf '%-5s %s%s\n' "$mark" "$2" "${3:+  ($3)}"
  printf '| %s | %s | %s | %s |\n' "$SECTION" "$mark" "$2" "${detail:0:160}" >> "$RESULTS.rows"
}

# Runs "$@" and expects success (want=ok) or refusal (want=refused).
# An optional grep pattern must appear in the output.
expect() {  # want label pattern cmd...
  local want="$1" label="$2" pattern="$3"; shift 3
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  local got=ok; [ $rc -ne 0 ] && got=refused
  if [ "$got" = "$want" ] && { [ -z "$pattern" ] || grep -qiE "$pattern" <<<"$out"; }; then
    record ok "$label" "$(tail -n 1 <<<"$out" | cut -c1-120)"
  else
    record fail "$label" "expected $want, got $got: $(tail -n 2 <<<"$out" | tr '\n' ' ' | cut -c1-200)"
  fi
}

# Temporary credentials for one of our IAM roles (1 hour, like the app would get).
declare -A CREDS
assume() {
  local role="$1"
  if [ -z "${CREDS[$role]:-}" ]; then
    CREDS[$role]="$(aws sts assume-role --role-arn "arn:aws:iam::$ACCOUNT_ID:role/$role" \
                     --role-session-name "test-$role" --duration-seconds 3600 \
                     --query Credentials --output json)"
  fi
}
as_role() {  # role cmd...  — run a command with that role's credentials only
  local role="$1"; shift
  assume "$role"
  AWS_ACCESS_KEY_ID="$(jq -r .AccessKeyId <<<"${CREDS[$role]}")" \
  AWS_SECRET_ACCESS_KEY="$(jq -r .SecretAccessKey <<<"${CREDS[$role]}")" \
  AWS_SESSION_TOKEN="$(jq -r .SessionToken <<<"${CREDS[$role]}")" \
  "$@"
}

token_for() {  # dbuser — 15-minute IAM login token, signed with the caller's credentials
  aws rds generate-db-auth-token --hostname "$DB_HOST" --port "$DB_PORT" \
    --region "$REGION" --username "$1"
}

# Log in as <dbuser> with an IAM token made by <role>, and run SQL.
iam_sql() {  # role dbuser sql
  local role="$1" user="$2" sql="$3" tok
  tok="$(as_role "$role" token_for "$user")" || return 1
  PGPASSWORD="$tok" PGCONNECT_TIMEOUT=10 psql \
    "host=$DB_HOST port=$DB_PORT dbname=$DB_NAME user=$user sslmode=prefer" \
    -v ON_ERROR_STOP=1 -tA -c "$sql"
}

tampered_login() {  # role dbuser — valid token with one signature character changed
  local tok
  tok="$(as_role "$1" token_for "$2")" || return 1
  local last="${tok: -1}" swap=0; [ "$last" = 0 ] && swap=1
  PGPASSWORD="${tok%?}$swap" PGCONNECT_TIMEOUT=10 psql \
    "host=$DB_HOST port=$DB_PORT dbname=$DB_NAME user=$2 sslmode=prefer" -tA -c 'SELECT 1'
}

master_psql() {
  local pw
  pw="$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text | jq -r .password)"
  PGPASSWORD="$pw" PGCONNECT_TIMEOUT=10 psql \
    "host=$DB_HOST port=$DB_PORT dbname=$DB_NAME user=$MASTER_USER sslmode=prefer" -v ON_ERROR_STOP=1 -tA "$@"
}

password_login() {  # dbuser password
  PGPASSWORD="$2" PGCONNECT_TIMEOUT=10 psql \
    "host=$DB_HOST port=$DB_PORT dbname=$DB_NAME user=$1 sslmode=prefer" -tA -c 'SELECT 1'
}

simulate() {  # role action resource  -> prints allowed | implicitDeny | explicitDeny
  aws iam simulate-principal-policy \
    --policy-source-arn "arn:aws:iam::$ACCOUNT_ID:role/$1" \
    --action-names "$2" --resource-arns "$3" \
    --query 'EvaluationResults[0].EvalDecision' --output text
}
expect_decision() {  # label wanted role action resource
  local got
  got="$(simulate "$3" "$4" "$5" 2>&1)"
  if [ "$got" = "$2" ]; then record ok "$1" "$got"; else record fail "$1" "expected $2, got $got"; fi
}

DBUSER_ARN="arn:aws:rds-db:$REGION:$ACCOUNT_ID:dbuser:$DBI_RESOURCE_ID"
DB_ARN="arn:aws:rds:$REGION:$ACCOUNT_ID:db:$DB_INSTANCE_ID"

# =====================================================================
section "1. RDS instance settings"
DESC="$(aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE_ID" --query 'DBInstances[0]')"
check_setting() {  # label jq-expr expected
  local got; got="$(jq -r "$2" <<<"$DESC")"
  if [ "$got" = "$3" ]; then record ok "$1" "$got"; else record fail "$1" "expected $3, got $got"; fi
}
check_setting "IAM database login enabled"          '.IAMDatabaseAuthenticationEnabled' true
check_setting "Storage encrypted"                    '.StorageEncrypted' true
check_setting "Not reachable from the internet"      '.PubliclyAccessible' false
check_setting "Deletion protection on"               '.DeletionProtection' true
check_setting "Backups kept 7 days"                  '.BackupRetentionPeriod' 7
check_setting "Master password kept in Secrets Manager (not in code)" '(.MasterUserSecret.SecretArn // "") | startswith("arn:aws:secretsmanager")' true

# =====================================================================
section "2. Each role can log in only as its own database user"
expect ok      "team19-api logs in as app_rw"                 '^app_rw$'       iam_sql team19-api       app_rw       'SELECT current_user'
expect ok      "team19-dashboard logs in as dashboard_ro"     '^dashboard_ro$' iam_sql team19-dashboard dashboard_ro 'SELECT current_user'
expect ok      "team19-notifier logs in as notifier"          '^notifier$'     iam_sql team19-notifier  notifier     'SELECT current_user'
expect ok      "team19-api can also log in as dashboard_ro (dashboard routes run in the API)" '^dashboard_ro$' iam_sql team19-api dashboard_ro 'SELECT current_user'
expect refused "team19-dashboard cannot log in as app_rw"     ''               iam_sql team19-dashboard app_rw       'SELECT 1'
expect refused "team19-notifier cannot log in as app_rw"      ''               iam_sql team19-notifier  app_rw       'SELECT 1'
expect refused "team19-db-admin cannot log in as app_rw (explicit deny)" '' iam_sql team19-db-admin app_rw 'SELECT 1'
expect refused "team19-api cannot log in as the master user"  ''               iam_sql team19-api       "$MASTER_USER" 'SELECT 1'
expect refused "A token with a changed signature is refused"  ''               tampered_login team19-api app_rw

# A password set on an rds_iam role must not work: only IAM tokens do.
KNOWN_PW="$(openssl rand -hex 20)"
master_psql -c "ALTER ROLE app_rw PASSWORD '$KNOWN_PW'" >/dev/null 2>&1
expect refused "app_rw cannot log in with a password (IAM only)" '' password_login app_rw "$KNOWN_PW"
master_psql -c "ALTER ROLE app_rw PASSWORD '$(openssl rand -hex 24)'" >/dev/null 2>&1
unset KNOWN_PW

# =====================================================================
section "3. Least privilege inside the database (over IAM sessions)"
expect ok      "dashboard_ro can read user names and roles"       '' iam_sql team19-dashboard dashboard_ro 'SELECT count(*) FROM (SELECT id, name, role, active FROM users) t'
expect refused "dashboard_ro cannot read password hashes"         'permission denied' iam_sql team19-dashboard dashboard_ro 'SELECT password_hash FROM users'
expect refused "dashboard_ro cannot write the audit log"          'permission denied' iam_sql team19-dashboard dashboard_ro "INSERT INTO audit_log (action, result) VALUES ('x', 'allowed')"
expect refused "notifier cannot read internal notes"              'permission denied' iam_sql team19-notifier  notifier     'SELECT * FROM internal_notes'
expect ok      "app_rw can add audit entries"                     '' iam_sql team19-api app_rw "BEGIN; INSERT INTO audit_log (action, result) VALUES ('floci_test', 'allowed'); ROLLBACK;"
expect refused "app_rw cannot change audit entries"               'permission denied' iam_sql team19-api app_rw "UPDATE audit_log SET result = 'denied'"
expect refused "app_rw cannot create tables"                      'permission denied' iam_sql team19-api app_rw 'CREATE TABLE sneaky (id int)'
expect refused "An IAM session cannot switch back to the master user" '' iam_sql team19-api app_rw 'RESET SESSION AUTHORIZATION; SELECT current_user'

# =====================================================================
section "4. IAM policies are enforced on AWS API calls"
expect refused "team19-api cannot create IAM users (no privilege escalation)" '' as_role team19-api aws iam create-user --user-name sneaky
expect refused "team19-api cannot delete the database"            '' as_role team19-api aws rds delete-db-instance --db-instance-identifier "$DB_INSTANCE_ID" --skip-final-snapshot
expect refused "team19-api cannot read the master password secret" '' as_role team19-api aws secretsmanager get-secret-value --secret-id "$SECRET_ARN"
expect refused "team19-dashboard cannot change the database"      '' as_role team19-dashboard aws rds modify-db-instance --db-instance-identifier "$DB_INSTANCE_ID" --backup-retention-period 0 --apply-immediately
expect ok      "team19-db-admin can read the database settings"   '' as_role team19-db-admin aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE_ID" --query 'DBInstances[0].DBInstanceStatus' --output text
# Floci 2.5 checks RDS API calls against Resource "*" (it does not read RDS
# resource ARNs yet), so the db-admin's snapshot permission, which is scoped
# to team19-db only, is proven with the policy simulator in section 5
# (allowed for team19-db, implicitly denied for any other database).
expect refused "team19-db-admin cannot delete the database (explicit deny)" '' as_role team19-db-admin aws rds delete-db-instance --db-instance-identifier "$DB_INSTANCE_ID" --skip-final-snapshot
# ModifyDBInstance could reset the master password (then log in with it and
# read all data, getting around the rds-db:connect deny), turn IAM login off
# or make the database public. IAM has no condition key that limits it to
# "safe" changes, so the db-admin is denied it; settings are changed only by
# the deployer identity.
NEW_PW="$(openssl rand -hex 20)"
expect refused "team19-db-admin cannot reset the master password (explicit deny)" 'AccessDenied|not authorized' as_role team19-db-admin aws rds modify-db-instance --db-instance-identifier "$DB_INSTANCE_ID" --master-user-password "$NEW_PW" --apply-immediately
unset NEW_PW
expect refused "team19-db-admin cannot turn off IAM database login (explicit deny)" 'AccessDenied|not authorized' as_role team19-db-admin aws rds modify-db-instance --db-instance-identifier "$DB_INSTANCE_ID" --no-enable-iam-database-authentication --apply-immediately
expect refused "team19-db-admin cannot give itself more rights"   '' as_role team19-db-admin aws iam put-role-policy --role-name team19-db-admin --policy-name grab --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}'
expect refused "Even the administrator cannot delete it: deletion protection" 'protect' aws rds delete-db-instance --db-instance-identifier "$DB_INSTANCE_ID" --skip-final-snapshot

# =====================================================================
section "5. Policy simulation (IAM policy evaluator)"
expect_decision "team19-api: connect as app_rw"            allowed      team19-api       rds-db:connect "$DBUSER_ARN/app_rw"
expect_decision "team19-api: connect as notifier (daily job in the API)" allowed team19-api rds-db:connect "$DBUSER_ARN/notifier"
expect_decision "team19-api: connect as the master user"   implicitDeny team19-api       rds-db:connect "$DBUSER_ARN/$MASTER_USER"
expect_decision "team19-dashboard: connect as app_rw"      implicitDeny team19-dashboard rds-db:connect "$DBUSER_ARN/app_rw"
expect_decision "team19-dashboard: connect as dashboard_ro" allowed     team19-dashboard rds-db:connect "$DBUSER_ARN/dashboard_ro"
expect_decision "team19-notifier: connect as notifier"     allowed      team19-notifier  rds-db:connect "$DBUSER_ARN/notifier"
expect_decision "team19-notifier: connect as app_rw"       implicitDeny team19-notifier  rds-db:connect "$DBUSER_ARN/app_rw"
expect_decision "team19-db-admin: connect as app_rw"       explicitDeny team19-db-admin  rds-db:connect "$DBUSER_ARN/app_rw"
expect_decision "team19-api: delete the database"          explicitDeny team19-api       rds:DeleteDBInstance "$DB_ARN"
expect_decision "team19-db-admin: delete the database"     explicitDeny team19-db-admin  rds:DeleteDBInstance "$DB_ARN"
expect_decision "team19-db-admin: snapshot this database"  allowed      team19-db-admin  rds:CreateDBSnapshot "$DB_ARN"
expect_decision "team19-db-admin: change this database's settings" explicitDeny team19-db-admin rds:ModifyDBInstance "$DB_ARN"
expect_decision "team19-db-admin: snapshot another database" implicitDeny team19-db-admin  rds:CreateDBSnapshot "arn:aws:rds:$REGION:$ACCOUNT_ID:db:other-db"

# =====================================================================
section "6. Database rules (backend/db/check.sql on RDS)"
# check.sql switches into each role with SET ROLE, which needs membership.
# Grant it for this one session only and take it back at the end: a
# lasting membership would make the master user IAM-only (see setup.sh).
CHECK_OUT="$(master_psql -c "GRANT app_rw, dashboard_ro, notifier TO $MASTER_USER" \
                         -f "$ROOT/backend/db/check.sql" \
                         -c "REVOKE app_rw, dashboard_ro, notifier FROM $MASTER_USER" 2>&1)"
CHECK_PASS="$(grep -c '^PASS' <<<"$CHECK_OUT")"
CHECK_FAIL="$(grep -c '^FAIL' <<<"$CHECK_OUT")"
if [ "$CHECK_FAIL" = 0 ] && [ "$CHECK_PASS" -ge 26 ]; then
  record ok "check.sql: $CHECK_PASS/$CHECK_PASS role and data-rule checks pass on RDS" ""
else
  record fail "check.sql: $CHECK_PASS PASS, $CHECK_FAIL FAIL" "$(grep -m3 -E '^FAIL|ERROR' <<<"$CHECK_OUT" | tr '\n' ' ')"
fi

# =====================================================================
section "7. The app's own code logs in with IAM tokens (backend/src/db/pool.js)"
# The app connects through src/db/pool.js with DB_IAM_AUTH=true: no password
# in the URL, a fresh IAM token for every new connection, signed with the
# role the code runs as. The API process also serves the dashboard routes and
# the daily job, so team19-api opens all three pools; each pool still logs in
# as its own least-privilege database user. A separately deployed dashboard
# (team19-dashboard) can't open the API's read/write pool.
app_login() {  # role env-var db-user pool-function  -> prints current_user
  local role="$1" var="$2" user="$3" fn="$4"
  ( cd "$ROOT/backend" && as_role "$role" env DB_IAM_AUTH=true AWS_REGION="$REGION" \
      "$var=postgresql://$user@$DB_HOST:$DB_PORT/$DB_NAME" node -e "
        const db = require('./src/db/pool').$fn();
        db.query('SELECT current_user AS u')
          .then((r) => { console.log(r.rows[0].u); return db.end(); })
        .catch((e) => { console.error(e.message); process.exit(1); });" )
}
if ( cd "$ROOT/backend" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 ); then
  expect ok      "API code logs in as app_rw with an IAM token (team19-api)"         '^app_rw$'       app_login team19-api       DATABASE_URL           app_rw       db
  expect ok      "Dashboard code logs in as dashboard_ro with an IAM token"          '^dashboard_ro$' app_login team19-dashboard DASHBOARD_DATABASE_URL dashboard_ro dashboardDb
  expect ok      "API process opens the dashboard pool as dashboard_ro"            '^dashboard_ro$' app_login team19-api       DASHBOARD_DATABASE_URL dashboard_ro dashboardDb
  expect ok      "API process opens the daily-job pool as notifier"                '^notifier$'     app_login team19-api       NOTIFIER_DATABASE_URL  notifier     notifierDb
  expect refused "Dashboard credentials cannot open the API pool (app_rw)"          ''               app_login team19-dashboard DATABASE_URL           app_rw       db
else
  record fail "npm ci in backend/ (needed for the app-code checks)" "see the job log"
fi

# =====================================================================
TOTAL=$((PASS + FAIL))
{
  echo "# Floci: RDS PostgreSQL + IAM security tests (Hana Fady)"
  echo
  echo "**$PASS of $TOTAL checks passed, $FAIL failed.** RDS \`$DB_INSTANCE_ID\` (PostgreSQL, IAM login), IAM policy enforcement on."
  echo
  echo "| Area | Result | Check | Detail |"
  echo "|---|---|---|---|"
  cat "$RESULTS.rows"
} > "$RESULTS"
rm -f "$RESULTS.rows"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$RESULTS" >> "$GITHUB_STEP_SUMMARY"

printf '\n%s of %s checks passed, %s failed.\n' "$PASS" "$TOTAL" "$FAIL"
[ "$FAIL" -eq 0 ]
