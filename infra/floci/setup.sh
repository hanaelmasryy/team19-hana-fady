#!/usr/bin/env bash
# =====================================================================
# Team 19 – Floci (AWS emulator): RDS PostgreSQL + IAM roles/policies
# Owner: Hana Fady (database setup lead)
#
# Builds the AWS version of our database inside Floci:
#   1. an RDS PostgreSQL instance (IAM database login on, storage
#      encrypted, not public, deletion protection, 7-day backups),
#      whose master password is generated and kept by RDS in
#      Secrets Manager, so no password is written anywhere;
#   2. our real schema.sql + roles.sql (app_rw, dashboard_ro, notifier),
#      with every app role switched to IAM login (rds_iam);
#   3. one IAM role per part of the app, each allowed to log in only
#      as its own database user (least privilege), plus a db-admin
#      role that can manage backups but can neither read app data nor
#      delete the database.
#
# Needs: a running Floci on $AWS_ENDPOINT_URL, the AWS CLI, psql, jq.
# Run from the repo root:  bash infra/floci/setup.sh
# Then:                    bash infra/floci/test.sh
# =====================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="${FLOCI_STATE_DIR:-$HERE/.state}"   # git-ignored; holds ids, never passwords

# Floci's bootstrap credential ("test") is the emulator's stand-in for an
# administrator. It is only used here, to build things. The tests use
# the roles created below, under IAM policy enforcement.
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
export AWS_PAGER=""

REGION="$AWS_DEFAULT_REGION"
DB_INSTANCE_ID="team19-db"
DB_NAME="onboarding"
MASTER_USER="team19_admin"
ROLES=(team19-api team19-dashboard team19-notifier team19-db-admin)

log() { printf '\n==> %s\n' "$*"; }

mkdir -p "$STATE"
chmod 700 "$STATE"

# ---------------------------------------------------------------------
log "Waiting for Floci at $AWS_ENDPOINT_URL"
for i in $(seq 1 60); do
  if aws sts get-caller-identity >/dev/null 2>&1; then break; fi
  [ "$i" = 60 ] && { echo "Floci did not answer"; exit 1; }
  sleep 2
done
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
echo "Account $ACCOUNT_ID, region $REGION"

# ---------------------------------------------------------------------
log "1/4 RDS PostgreSQL instance $DB_INSTANCE_ID"
if ! aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE_ID" >/dev/null 2>&1; then
  aws rds create-db-instance \
    --db-instance-identifier "$DB_INSTANCE_ID" \
    --engine postgres \
    --db-instance-class db.t3.micro \
    --allocated-storage 20 \
    --db-name "$DB_NAME" \
    --master-username "$MASTER_USER" \
    --manage-master-user-password \
    --enable-iam-database-authentication \
    --storage-encrypted \
    --no-publicly-accessible \
    --backup-retention-period 7 \
    --deletion-protection \
    --tags Key=project,Value=team19 Key=owner,Value=hana-fady \
    >/dev/null
fi

echo "Waiting until the database is available (Floci starts a real PostgreSQL container)..."
for i in $(seq 1 90); do
  STATUS="$(aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE_ID" \
            --query 'DBInstances[0].DBInstanceStatus' --output text)"
  [ "$STATUS" = "available" ] && break
  [ "$i" = 90 ] && { echo "Database not available (status: $STATUS)"; exit 1; }
  sleep 2
done

DESC="$(aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE_ID" --query 'DBInstances[0]')"
DB_HOST="$(jq -r '.Endpoint.Address' <<<"$DESC")"
DB_PORT="$(jq -r '.Endpoint.Port' <<<"$DESC")"
DBI_RESOURCE_ID="$(jq -r '.DbiResourceId' <<<"$DESC")"
SECRET_ARN="$(jq -r '.MasterUserSecret.SecretArn // empty' <<<"$DESC")"
echo "Endpoint $DB_HOST:$DB_PORT  resource id $DBI_RESOURCE_ID"
[ -n "$SECRET_ARN" ] || { echo "RDS did not create a managed master secret"; exit 1; }

# The master password only ever lives in Secrets Manager and in this
# process's environment (PGPASSWORD), never in a file or the log.
MASTER_PASSWORD="$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" \
                   --query SecretString --output text | jq -r .password)"

master_psql() {
  PGPASSWORD="$MASTER_PASSWORD" psql "host=$DB_HOST port=$DB_PORT dbname=$DB_NAME user=$MASTER_USER sslmode=prefer connect_timeout=10" \
    -v ON_ERROR_STOP=1 -q "$@"
}

echo "Waiting for PostgreSQL to accept logins..."
for i in $(seq 1 45); do
  master_psql -c 'SELECT 1' >/dev/null 2>&1 && break
  [ "$i" = 45 ] && { echo "PostgreSQL did not accept the master login"; master_psql -c 'SELECT 1'; exit 1; }
  sleep 2
done

# ---------------------------------------------------------------------
log "2/4 Schema and database roles (backend/db/schema.sql, roles.sql)"
if [ "$(master_psql -tA -c "SELECT to_regclass('public.users') IS NOT NULL")" != "t" ]; then
  master_psql -f "$ROOT/backend/db/schema.sql"

  # roles.sql is written for Neon. Two changes for RDS:
  #  - the CHANGE_ME passwords become random values that nobody keeps:
  #    on RDS the app roles log in with IAM tokens instead (step 3);
  #  - the Neon owner (neondb_owner) is our RDS master user.
  rand() { openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 40; }
  sed -e "s/CHANGE_ME_APP_RW/$(rand)/" \
      -e "s/CHANGE_ME_DASHBOARD_RO/$(rand)/" \
      -e "s/CHANGE_ME_NOTIFIER/$(rand)/" \
      -e "s/neondb_owner/$MASTER_USER/g" \
      "$ROOT/backend/db/roles.sql" | master_psql -f -
else
  echo "Schema already there – skipped"
fi

log "3/4 Switch the app roles to IAM login (rds_iam)"
master_psql <<SQL
-- roles.sql lets the owner switch into the app roles (Neon needs that for
-- check.sql). On RDS, membership in rds_iam counts even when it is
-- indirect, so the master user would become IAM-only too and lock itself
-- out. Take the app roles away from the master first; check.sql gets them
-- back only for its own session (see test.sh).
REVOKE app_rw, dashboard_ro, notifier FROM $MASTER_USER;

-- Members of rds_iam can only log in with an IAM token: RDS stops
-- accepting their passwords. So a leaked connection string with a
-- password in it is useless.
GRANT rds_iam TO app_rw, dashboard_ro, notifier;
SQL
master_psql -tA -c "SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname)
                    FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
                    WHERE m.roleid = 'rds_iam'::regrole" | sed 's/^/IAM-login roles: /'

# ---------------------------------------------------------------------
log "4/4 IAM roles and least-privilege policies"
render() {  # fills ${ACCOUNT_ID}, ${REGION}, ${DBI_RESOURCE_ID}, ${DB_INSTANCE_ID}
  sed -e "s/\${ACCOUNT_ID}/$ACCOUNT_ID/g" -e "s/\${REGION}/$REGION/g" \
      -e "s/\${DBI_RESOURCE_ID}/$DBI_RESOURCE_ID/g" -e "s/\${DB_INSTANCE_ID}/$DB_INSTANCE_ID/g" "$1"
}
TRUST="$(render "$HERE/iam/trust-policy.json")"
for role in "${ROLES[@]}"; do
  policy_file="$HERE/iam/${role#team19-}-policy.json"
  if ! aws iam get-role --role-name "$role" >/dev/null 2>&1; then
    aws iam create-role --role-name "$role" --assume-role-policy-document "$TRUST" \
      --max-session-duration 3600 --tags Key=project,Value=team19 >/dev/null
  fi
  aws iam put-role-policy --role-name "$role" --policy-name "${role}-least-privilege" \
    --policy-document "$(render "$policy_file")"
  echo "  $role  <- $(basename "$policy_file")"
done

# Ids the tests need. No passwords, keys or tokens.
cat > "$STATE/env" <<EOF
ACCOUNT_ID=$ACCOUNT_ID
REGION=$REGION
DB_INSTANCE_ID=$DB_INSTANCE_ID
DB_NAME=$DB_NAME
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DBI_RESOURCE_ID=$DBI_RESOURCE_ID
MASTER_USER=$MASTER_USER
SECRET_ARN=$SECRET_ARN
EOF
chmod 600 "$STATE/env"

log "Done. RDS $DB_INSTANCE_ID at $DB_HOST:$DB_PORT, IAM roles: ${ROLES[*]}"
