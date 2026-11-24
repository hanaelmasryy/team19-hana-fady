// Creates the first Admin account so someone can log in and create the
// other users through the Admin screen. There is no self-registration.
//
// Usage (from backend/):  npm run seed
// Reads DATABASE_URL, SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD from .env.

try {
  process.loadEnvFile(`${__dirname}/../.env`);
} catch {
  // No .env: use variables from the shell.
}

const bcrypt = require('bcryptjs');
const { db } = require('../src/db/pool');

async function main() {
  const email = (process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || '';

  if (!email || !email.includes('@')) {
    throw new Error('Set SEED_ADMIN_EMAIL in backend/.env');
  }
  if (password.length < 12) {
    throw new Error('Set SEED_ADMIN_PASSWORD (at least 12 characters) in backend/.env');
  }

  const hash = await bcrypt.hash(password, 12);
  const result = await db().query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'Admin')
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    ['Administrator', email, hash]
  );

  if (result.rowCount === 1) {
    console.log(`Admin account created for ${email}`);
  } else {
    console.log(`An account for ${email} already exists; nothing changed`);
  }
  await db().end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
