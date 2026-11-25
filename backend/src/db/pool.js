// Database connection pools, one per database role (see db/roles.sql).
// Pools are created lazily, so the app starts even when a URL is missing,
// and reused across requests while the Vercel function stays warm.
//
// Two ways to log in, chosen by one setting:
//
//   DB_IAM_AUTH not set (the live site on Neon, local development):
//     the connection string carries the role's password, as before.
//
//   DB_IAM_AUTH=true (the AWS version: Amazon RDS, emulated with Floci):
//     the roles are IAM-only (rds_iam, infra/floci/setup.sh), so a password
//     is refused. The URL has no password; every new connection gets a fresh
//     15-minute IAM token from @aws-sdk/rds-signer, signed with the
//     credentials of the role the code runs as (on AWS the ECS task or Lambda
//     role; in Floci the assumed team19-* role). Nothing secret is stored,
//     and a token that expires is simply replaced on the next connection.

const fs = require('node:fs');
const { Pool } = require('pg');

const pools = {};

const isLocalHost = (host) => host === 'localhost' || host === '127.0.0.1' || host === '::1';

// Loaded only in IAM mode, so the Neon deployment does not need the package.
function defaultSigner(options) {
  const { Signer } = require('@aws-sdk/rds-signer');
  return new Signer(options);
}

// TLS settings: none for a database on this machine (local Postgres, Floci),
// otherwise verified TLS. RDS certificates are signed by the RDS CA, which can
// be given as a file with DB_SSL_CA_FILE.
function tlsFor(host, env) {
  if (isLocalHost(host)) return false;
  const ssl = { rejectUnauthorized: true };
  if (env.DB_SSL_CA_FILE) ssl.ca = fs.readFileSync(env.DB_SSL_CA_FILE, 'utf8');
  return ssl;
}

// The pg Pool settings for one connection string. Exported for the tests.
function poolConfig(connectionString, env = process.env, makeSigner = defaultSigner) {
  const common = { max: 3, idleTimeoutMillis: 10000 }; // keep it small on serverless

  if (env.DB_IAM_AUTH !== 'true') {
    const isLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(connectionString);
    // Neon requires TLS; a local Postgres for development does not.
    return { connectionString, ssl: isLocal ? false : { rejectUnauthorized: true }, ...common };
  }

  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('The database URL is not valid');
  }
  if (url.password) {
    throw new Error('With DB_IAM_AUTH=true the database URL must not contain a password');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || 5432);
  const user = decodeURIComponent(url.username);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!host || !user || !database) {
    throw new Error('With DB_IAM_AUTH=true the database URL needs a user, host and database name');
  }
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  if (!region) throw new Error('Set AWS_REGION for IAM database login');

  const signer = makeSigner({ hostname: host, port, username: user, region });
  return {
    host,
    port,
    user,
    database,
    // pg calls this for every new connection, so each one gets a fresh token.
    password: () => signer.getAuthToken(),
    ssl: tlsFor(host, env),
    ...common,
  };
}

function makePool(envName) {
  const connectionString = process.env[envName];
  if (!connectionString) {
    throw new Error(`${envName} is not set`);
  }
  return new Pool(poolConfig(connectionString));
}

function getPool(envName) {
  if (!pools[envName]) pools[envName] = makePool(envName);
  return pools[envName];
}

module.exports = {
  // Read/write role used by the API (app_rw)
  db: () => getPool('DATABASE_URL'),
  // Read-only role used by dashboard queries (dashboard_ro)
  dashboardDb: () => getPool('DASHBOARD_DATABASE_URL'),
  // Notifications-only role used by the daily job (notifier)
  notifierDb: () => getPool('NOTIFIER_DATABASE_URL'),
  poolConfig,
};
