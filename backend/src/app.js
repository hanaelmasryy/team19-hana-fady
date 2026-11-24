// Express application for the Customer Onboarding Checklist Portal.
// Vercel detects this file (src/app.js) and runs the exported app as one
// Vercel Function. For local development, run `npm run dev` (local.js).
//
// One API, three services as route modules:
//   Template & Workflow Rules  -> routes/templates.js   (Hana Fady)
//   Auth & identity (shared)   -> routes/auth.js, routes/users.js (Hana Fady)
//   Plan & Task Management     -> routes/plans.js       (Hana Anwar)
//   Dashboard & Monitoring     -> routes/dashboard.js   (Jana Hossam)

const express = require('express');
const cors = require('cors');

const app = express();

// Only the frontend origins listed in CORS_ORIGINS may call the API.
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Requests with no Origin header (Postman, curl, Vercel Cron) are allowed;
      // they still need a valid token or CRON_SECRET on protected routes.
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    allowedHeaders: ['Content-Type', 'Authorization'],
    // Lets the login page read how long a lockout lasts (429 + Retry-After).
    exposedHeaders: ['Retry-After'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  })
);

app.disable('x-powered-by');

// Security headers on every API response (security review, issue #12).
// The API only returns JSON, so it may not be framed, sniffed as HTML,
// cached by a browser or shared proxy, or load anything itself.
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  });
  next();
});

// Vercel sits in front of the API as a proxy. Trusting one proxy hop
// makes req.ip the real client address (used by the login-attempt limit).
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

// Health check used to confirm a deployment is live.
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Route modules. Each owner works only inside their own files.
app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/users'));
app.use('/api', require('./routes/templates'));
// In the team repository the API also mounts routes/plans.js (Hana Anwar)
// and routes/dashboard.js (Jana Hossam). This proof-of-work repository holds
// only Hana Fady's parts, so those two lines are left out here.
// Team repository: https://github.com/hanaelmasryy/Onboarding-portal-team19

// Unknown routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Malformed JSON and unexpected errors. Never return stack traces or
// internal details to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  console.error(JSON.stringify({ level: 'error', message: err.message, path: req.path }));
  return res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
