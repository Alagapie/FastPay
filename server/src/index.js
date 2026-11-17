import { config, paypalEnabled } from './config.js';
import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { requireAuth } from './auth.js';
import { HttpError } from './util.js';
import { startSettlementWorker } from './ledger.js';
import { startPaypalSync } from './paypalSync.js';
import webhookRoutes from './routes/webhooks.js';
import authRoutes from './routes/auth.js';
import apiRoutes from './routes/api.js';
import investigationRoutes from './routes/investigation.js';
import resolutionRoutes from './routes/resolution.js';
import { checkCredentials } from './paypal.js';

/** Which optional PayPal features the app's keys are allowed to use (from the access token's scopes). */
async function paypalFeatures() {
  if (!paypalEnabled) return { payouts: false, invoicing: false };
  try {
    const { scopes } = await checkCredentials();
    const has = (...names) => scopes.some((s) => names.some((n) => s === n || s.startsWith(`${n}/`)));
    return {
      payouts: has('https://uri.paypal.com/payments/payouts', 'https://uri.paypal.com/services/payments/payouts'),
      invoicing: has('https://uri.paypal.com/services/invoicing'),
    };
  } catch {
    return { payouts: false, invoicing: false };
  }
}

const app = express();
app.disable('x-powered-by');
// Webhooks go first: signature checks need the raw, unparsed body.
app.use('/api', webhookRoutes);
app.use(express.json({ limit: '50kb' }));
app.use(cookieParser());

app.get('/api/config', async (_req, res) => {
  res.json({
    currency: config.currency,
    paypalClientId: paypalEnabled ? config.paypal.clientId : null,
    paypalEnv: config.paypal.env,
    paypalWebhooks: paypalEnabled && Boolean(config.paypal.webhookId),
    paypalFeatures: await paypalFeatures(),
    simulationEnabled: config.simulationEnabled,
    pendingSeconds: config.pendingSeconds,
    // Where "Help" in the app goes: the investigation module (payment complaints).
    investigationUrl: (process.env.INVESTIGATION_APP_URL || 'http://localhost:4100').replace(/\/+$/, ''),
  });
});

// Browser error reports (crashes, uncaught errors) -> server/data/client-errors.log, so problems
// that only happen in someone's browser can be diagnosed. Small, rate-limited, no auth needed.
// Stored next to the database (so test servers with their own DB_PATH keep their own log).
const errorLog = path.join(
  path.dirname(process.env.DB_PATH || path.resolve(import.meta.dirname, '..', 'data', 'fastpay.db')),
  'client-errors.log',
);
const errorBudget = new Map(); // ip -> { count, resetAt }
app.post('/api/client-errors', (req, res) => {
  const now = Date.now();
  const b = errorBudget.get(req.ip) ?? { count: 0, resetAt: now + 60_000 };
  if (now > b.resetAt) Object.assign(b, { count: 0, resetAt: now + 60_000 });
  errorBudget.set(req.ip, b);
  if (++b.count > 30) return res.status(429).end();

  const r = req.body ?? {};
  const clip = (v, n) => String(v ?? '').slice(0, n);
  const entry = {
    at: new Date().toISOString(),
    kind: clip(r.kind, 20),
    message: clip(r.message, 500),
    path: clip(r.path, 200),
    stack: clip(r.stack, 4000),
    componentStack: clip(r.componentStack, 3000),
    source: clip(r.source, 300),
    userAgent: clip(req.get('user-agent'), 200),
  };
  fs.appendFile(errorLog, `${JSON.stringify(entry)}\n`, () => {});
  console.warn(`[client-error] ${entry.kind} on ${entry.path}: ${entry.message}`);
  res.status(204).end();
});

app.use('/api/auth', authRoutes);
// Read-only window for the investigation module. Locked by its own key, before the customer API.
app.use('/api/investigation', investigationRoutes);
// Resolution window for Module 3: the only way it moves money. Its own key + the customer's session.
app.use('/api/resolution', resolutionRoutes);
app.use('/api', requireAuth, apiRoutes);
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));

// Serve the built client in production (npm run build).
const clientDist = path.resolve(import.meta.dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

startSettlementWorker();
startPaypalSync();

app.listen(config.port, () => {
  console.log(`FastPay API listening on http://localhost:${config.port}`);
  console.log(paypalEnabled ? `PayPal: ${config.paypal.env} mode` : 'PayPal: not configured (simulated deposits only)');
});
