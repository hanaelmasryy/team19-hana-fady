// Runs the Postman collection for login, users and templates with Newman.
// Owner: Hana Fady (issue #11).
//
//   cd backend
//   npm run dev        (first terminal: the local API on the DEV database)
//   npm run postman    (second terminal)
//
// What it does:
// 1. Creates a temporary Admin on the DEV database with a random password
//    (email test-pm-admin-<random>@example.test). Nobody has to know or type
//    a password, and none is stored anywhere.
// 2. Runs the collection with Newman against the local API as that Admin.
// 3. Deactivates the temporary Admin again (accounts are never deleted,
//    because the audit log points to them).
//
// Newman is fetched with npx when needed instead of being a project
// dependency: its own old dependencies would otherwise add npm audit
// warnings to the API project, and it is never needed on the live site.
// The login goes to Newman through a temporary environment file that only
// this user can read and that is deleted right after the run.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // no .env file; checked below
}

// The production (main) Neon branch. Tests create and change data, so they
// must only ever run against the dev branch.
const PRODUCTION_HOST = 'ep-fragrant-union-b9tjyd2z';

const databaseUrl = process.env.DATABASE_URL || '';
if (!databaseUrl) {
  console.error('DATABASE_URL is not set in backend/.env (use the DEV connection string).');
  process.exit(1);
}
if (databaseUrl.includes(PRODUCTION_HOST)) {
  console.error('backend/.env points at the PRODUCTION database. Use the DEV connection strings for tests.');
  process.exit(1);
}

const bcrypt = require('bcryptjs');
const pool = require('../src/db/pool');

const baseUrl = process.env.POSTMAN_BASE_URL || 'http://localhost:3000';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl)) {
  console.error('This collection changes data, so it only runs against the local API (http://localhost:...).');
  process.exit(1);
}
const collection = path.join(__dirname, '..', '..', 'docs', 'postman', 'auth-users-templates.postman_collection.json');

async function main() {
  const email = `test-pm-admin-${crypto.randomBytes(4).toString('hex')}@example.test`;
  const password = crypto.randomBytes(18).toString('base64url'); // 24 random characters, only in memory
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.db().query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ('Postman test Admin', $1, $2, 'Admin') RETURNING id`,
    [email, hash]
  );
  const adminId = rows[0].id;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team19-postman-'));
  const envFile = path.join(dir, 'env.json');
  let status = 1;
  try {
    fs.writeFileSync(envFile, JSON.stringify({
      name: 'local dev (temporary)',
      values: [
        { key: 'baseUrl', value: baseUrl, enabled: true },
        { key: 'adminEmail', value: email, enabled: true },
        { key: 'adminPassword', value: password, type: 'secret', enabled: true },
      ],
    }), { mode: 0o600 });

    console.log(`Running the collection against ${baseUrl} as a temporary Admin (${email}) ...`);
    // Only file paths (ours, quoted) go on the command line, never the password.
    // One command string: npx is a .cmd file on Windows, so it needs a shell.
    const command = `npx --yes newman@6 run "${collection}" -e "${envFile}"`;
    const result = spawnSync(command, { stdio: 'inherit', shell: true });
    status = result.status === null ? 1 : result.status;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await pool.db().query('UPDATE users SET active = false WHERE id = $1', [adminId]);
    await pool.db().end();
    console.log('Temporary Admin deactivated.');
  }
  return status;
}

main()
  .then((status) => process.exit(status))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
