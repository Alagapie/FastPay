// Test fixture: a throwaway FastPay, end to end.
//   - FastPay's real ledger code fills a temp database (via DB_PATH)
//   - FastPay's real investigation window (server/src/routes/investigation.js) serves it over HTTP
//   - a fake PayPal server answers FastPay's PayPal calls (via PAYPAL_API_BASE)
// The investigation module then talks to it exactly as in production: only through the window.
// FastPay's real database, .env keys and PayPal account are never used.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createFastPayApi } from '../../src/fastpay/api.js';
import { openStore } from '../../src/store.js';
import { createCaseService } from '../../src/cases.js';

const SERVER_DIR = path.resolve(import.meta.dirname, '../../../server');
export const TEST_SERVICE_TOKEN = 'test-investigation-token';
export const TEST_RESOLUTION_TOKEN = 'test-resolution-token';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

/** A fake PayPal API. Add answers to `routes` by path: { status, body } or { throws: true }. */
async function startFakePayPal() {
  const routes = {};
  const calls = [];
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    calls.push({ method: req.method, path: pathname, requestId: req.headers['paypal-request-id'] });
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (pathname === '/v1/oauth2/token') return json(200, { access_token: 'test-token', expires_in: 3600, scope: '' });
    // Writes (refunds) answer only when a test registers "POST <path>".
    if (req.method !== 'GET' && !routes[`${req.method} ${pathname}`]) return json(405, { name: 'METHOD_NOT_ALLOWED' });
    const r = req.method === 'GET' ? routes[pathname] : routes[`${req.method} ${pathname}`];
    if (!r) return json(404, { name: 'RESOURCE_NOT_FOUND', message: 'The specified resource does not exist.' });
    if (r.throws) return req.socket.destroy(); // PayPal unreachable
    return json(r.status ?? 200, r.body, { 'paypal-debug-id': 'dbg-test-123' });
  });
  return { url: await listen(server), routes, calls, server };
}

export async function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'investigation-test-'));
  const paypal = await startFakePayPal();
  // Set before FastPay's code loads, so these win over anything in server/.env.
  Object.assign(process.env, {
    DB_PATH: path.join(dir, 'fastpay.db'),
    ENABLE_SIMULATION: 'true',
    JWT_SECRET: 'test-jwt-secret',
    INVESTIGATION_API_TOKEN: TEST_SERVICE_TOKEN,
    RESOLUTION_API_TOKEN: TEST_RESOLUTION_TOKEN,
    PAYPAL_API_BASE: paypal.url,
    PAYPAL_CLIENT_ID: 'test-client',
    PAYPAL_CLIENT_SECRET: 'test-secret',
    PAYPAL_ENV: 'sandbox',
  });
  const { db } = await import('../../../server/src/db.js');
  const ledger = await import('../../../server/src/ledger.js');
  const { config: fastpayConfig } = await import('../../../server/src/config.js');
  const { default: investigationRouter } = await import('../../../server/src/routes/investigation.js');
  const { default: resolutionRouter } = await import('../../../server/src/routes/resolution.js');
  const express = createRequire(path.join(SERVER_DIR, 'package.json'))('express');

  const app = express();
  app.use(express.json());
  app.use('/api/investigation', investigationRouter);
  app.use('/api/resolution', resolutionRouter); // Module 3's window (writes), same as in FastPay
  const fastpayServer = http.createServer(app);
  const fastpayUrl = await listen(fastpayServer);
  const api = createFastPayApi({ baseUrl: fastpayUrl, token: TEST_SERVICE_TOKEN });

  const insertUser = db.prepare('INSERT INTO users (account_id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)');
  const insertWallet = db.prepare("INSERT INTO wallets (user_id, currency, created_at) VALUES (?, 'USD', ?)");

  function addUser(name, email) {
    const ts = new Date().toISOString();
    const accountId = `FP${String(crypto.randomInt(0, 1e10)).padStart(10, '0')}`;
    const id = Number(insertUser.run(accountId, name, email, 'not-used', ts).lastInsertRowid);
    insertWallet.run(id, ts);
    return { id, account_id: accountId, name, email, wallet: ledger.getWallet(id) };
  }

  /** A FastPay session token for this user, signed exactly the way FastPay signs its login cookie. */
  function sessionFor(user, { secret = fastpayConfig.jwtSecret, expiresInSec = 3600 } = {}) {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const body = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub: String(user.id), exp: Math.floor(Date.now() / 1000) + expiresInSec })}`;
    return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
  }

  /** The customer as the investigation module sees them: from FastPay's window, with an API limited to them. */
  const login = (user) => api.forCustomer(sessionFor(user));

  const fund = (user, cents) => ledger.simulatedDeposit({ userId: user.id, amount: cents, simulate: 'success' });

  /** Move a transaction's timestamps back in time (test DB only), e.g. to make it "yesterday". */
  function backdate(reference, minutes) {
    for (const col of ['created_at', 'updated_at', 'debited_at', 'credited_at', 'reversed_at', 'completed_at']) {
      db.prepare(`UPDATE transactions SET ${col} = strftime('%Y-%m-%dT%H:%M:%fZ', ${col}, ?) WHERE reference = ? AND ${col} IS NOT NULL`)
        .run(`-${minutes} minutes`, reference);
    }
  }

  /** Shut the test servers down so the test process can exit. */
  function close() {
    for (const srv of [fastpayServer, paypal.server]) {
      srv.closeAllConnections?.();
      srv.close();
    }
  }

  return { dir, db, ledger, api, fastpayUrl, paypal, addUser, login, sessionFor, fund, backdate, close };
}

export const paypalOrder = (id, { captureId, status = 'COMPLETED', value = '50.00', orderStatus = 'COMPLETED', time = new Date().toISOString() } = {}) => ({
  id,
  status: orderStatus,
  create_time: time,
  update_time: time,
  purchase_units: [{
    amount: { currency_code: 'USD', value },
    payments: captureId ? { captures: [{ id: captureId, status, amount: { currency_code: 'USD', value }, create_time: time, update_time: time }] } : undefined,
  }],
});

export const paypalCapture = (id, { status = 'COMPLETED', value = '50.00', time = new Date().toISOString() } = {}) => ({
  id, status, amount: { currency_code: 'USD', value }, final_capture: true, create_time: time, update_time: time,
});

export const paypalPayout = (batchId, { status = 'SUCCESS', value = '30.00', email = 'me@paypal.test', time = new Date().toISOString() } = {}) => ({
  batch_header: { payout_batch_id: batchId, batch_status: 'SUCCESS' },
  items: [{
    payout_item_id: `ITEM-${batchId}`,
    transaction_id: status === 'SUCCESS' ? `TX-${batchId}` : undefined,
    transaction_status: status,
    payout_item: { amount: { currency: 'USD', value }, receiver: email },
    time_processed: time,
  }],
});

export function createService({ llm = { enabled: false }, now, processingWindowMinutes = 10 } = {}) {
  const store = openStore(':memory:');
  const config = { timezone: 'Africa/Lagos', processingWindowMinutes };
  return { store, service: createCaseService({ llm, store, config, now }) };
}

export const minutesFromNow = (m) => new Date(Date.now() + m * 60_000);
