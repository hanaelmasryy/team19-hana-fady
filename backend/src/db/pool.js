// Database connection pools, one per Neon role (see db/roles.sql).
// Pools are created lazily, so the app starts even when a URL is missing,
// and reused across requests while the Vercel function stays warm.

const { Pool } = require('pg');

const pools = {};

function makePool(envName) {
  const connectionString = process.env[envName];
  if (!connectionString) {
    throw new Error(`${envName} is not set`);
  }
  const isLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(connectionString);
  return new Pool({
    connectionString,
    // Neon requires TLS; a local Postgres for development does not.
    ssl: isLocal ? false : { rejectUnauthorized: true },
    max: 3, // keep it small on serverless
    idleTimeoutMillis: 10000,
  });
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
};
