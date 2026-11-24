// Local development server. Vercel does not use this file.
// Loads backend/.env (if present) and starts the API on PORT.

const crypto = require('node:crypto');

try {
  process.loadEnvFile(`${__dirname}/.env`);
} catch {
  // No .env file: rely on variables already set in the shell.
}

// Local only: if backend/.env has no JWT_SECRET (or a short one), use a random
// one that exists only while this server runs. Logins work, and tokens simply
// stop working after a restart. The deployed API never gets here: on Vercel the
// secret comes from the project settings, and without it login fails closed.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('base64url');
  console.warn('JWT_SECRET is not set in backend/.env, so a temporary random one is used for this run (logins end when the server restarts).');
}

const app = require('./src/app');

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`API running on http://localhost:${port}`);
});
