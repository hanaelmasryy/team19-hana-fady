// Unit tests for the database pool settings (src/db/pool.js), Hana Fady.
// No database or AWS needed: the IAM signer is replaced by a fake one.

const test = require('node:test');
const assert = require('node:assert/strict');
const { poolConfig } = require('../src/db/pool');

function fakeSigner() {
  const calls = [];
  let n = 0;
  const make = (options) => {
    calls.push(options);
    return { getAuthToken: async () => `token-${++n}` };
  };
  return { make, calls };
}

test('without DB_IAM_AUTH: the connection string is used as before, with TLS for Neon', () => {
  const url = 'postgresql://app_rw:secret@ep-example.eu-central-1.aws.neon.tech/neondb?sslmode=require';
  const cfg = poolConfig(url, {});
  assert.equal(cfg.connectionString, url);
  assert.deepEqual(cfg.ssl, { rejectUnauthorized: true });
  assert.equal(cfg.password, undefined);
  assert.equal(cfg.max, 3);
});

test('without DB_IAM_AUTH: no TLS for a local Postgres', () => {
  const cfg = poolConfig('postgresql://app_rw:secret@localhost:5432/onboarding', {});
  assert.equal(cfg.ssl, false);
});

test('DB_IAM_AUTH=true: a fresh IAM token for every new connection, never a stored password', async () => {
  const signer = fakeSigner();
  const env = { DB_IAM_AUTH: 'true', AWS_REGION: 'us-east-1' };
  const cfg = poolConfig('postgresql://app_rw@localhost:7001/onboarding', env, signer.make);

  assert.equal(cfg.connectionString, undefined);
  assert.equal(cfg.host, 'localhost');
  assert.equal(cfg.port, 7001);
  assert.equal(cfg.user, 'app_rw');
  assert.equal(cfg.database, 'onboarding');
  assert.equal(typeof cfg.password, 'function');
  assert.equal(await cfg.password(), 'token-1');
  assert.equal(await cfg.password(), 'token-2', 'each connection asks for a new token');
  // The token is signed for exactly this endpoint and database user.
  assert.deepEqual(signer.calls, [{ hostname: 'localhost', port: 7001, username: 'app_rw', region: 'us-east-1' }]);
  assert.equal(cfg.ssl, false, 'Floci runs on this machine');
});

test('DB_IAM_AUTH=true: verified TLS for a real RDS endpoint, default port 5432', () => {
  const signer = fakeSigner();
  const env = { DB_IAM_AUTH: 'true', AWS_DEFAULT_REGION: 'eu-central-1' };
  const cfg = poolConfig('postgresql://dashboard_ro@team19-db.abc123.eu-central-1.rds.amazonaws.com/onboarding', env, signer.make);
  assert.equal(cfg.port, 5432);
  assert.equal(cfg.user, 'dashboard_ro');
  assert.deepEqual(cfg.ssl, { rejectUnauthorized: true });
  assert.equal(signer.calls[0].region, 'eu-central-1');
});

test('DB_IAM_AUTH=true: a password in the URL is refused (IAM-only roles must not have one)', () => {
  const signer = fakeSigner();
  assert.throws(
    () => poolConfig('postgresql://app_rw:secret@localhost:7001/onboarding', { DB_IAM_AUTH: 'true', AWS_REGION: 'us-east-1' }, signer.make),
    /must not contain a password/
  );
  assert.equal(signer.calls.length, 0);
});

test('DB_IAM_AUTH=true: missing region, user or database fails closed', () => {
  const signer = fakeSigner();
  assert.throws(() => poolConfig('postgresql://app_rw@localhost:7001/onboarding', { DB_IAM_AUTH: 'true' }, signer.make), /AWS_REGION/);
  assert.throws(() => poolConfig('postgresql://localhost:7001/onboarding', { DB_IAM_AUTH: 'true', AWS_REGION: 'us-east-1' }, signer.make), /user, host and database/);
  assert.throws(() => poolConfig('postgresql://app_rw@localhost:7001/', { DB_IAM_AUTH: 'true', AWS_REGION: 'us-east-1' }, signer.make), /user, host and database/);
  assert.throws(() => poolConfig('not a url', { DB_IAM_AUTH: 'true', AWS_REGION: 'us-east-1' }, signer.make), /not valid/);
});

test('only the exact value "true" turns IAM login on', () => {
  const cfg = poolConfig('postgresql://app_rw:secret@localhost:5432/onboarding', { DB_IAM_AUTH: 'yes' });
  assert.ok(cfg.connectionString);
});
