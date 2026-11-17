// Resolution window for FastPay Module 3 (decision and resolution). The ONLY way Module 3 moves money.
//
//   POST /api/resolution/actions          carry out one approved resolution for the signed-in customer
//   GET  /api/resolution/actions/:key     read it back (to verify), with the payment's current legs
//
// Every request needs BOTH:
//   Authorization: Bearer <RESOLUTION_API_TOKEN>    proves it is the resolution service (off when unset)
//   X-Customer-Session: <the customer's fp_session>   proves which customer; only their payments
//
// FastPay does not trust the caller. Before moving anything it checks, itself:
//   - the payment is this customer's, in the role the action needs (only the payer gets money back)
//   - amount and currency are exactly the payment's
//   - the money has not already been delivered or returned (ledger.js re-checks inside the transaction)
//   - one action per payment, ever (UNIQUE reference); the same idempotency key replays the first result
//   - a daily cap per customer (RESOLUTION_DAILY_LIMIT, dollars)
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, nowIso } from '../db.js';
import * as ledger from '../ledger.js';
import * as paypal from '../paypal.js';

const router = Router();

db.exec(`
  CREATE TABLE IF NOT EXISTS resolution_actions (
    idempotency_key   TEXT PRIMARY KEY,                 -- resolve:<reference>
    reference         TEXT NOT NULL UNIQUE,
    transaction_id    INTEGER NOT NULL REFERENCES transactions(id),
    user_id           INTEGER NOT NULL REFERENCES users(id),
    action            TEXT NOT NULL CHECK (action IN ('CREDIT_WALLET', 'RETURN_TO_WALLET', 'REFUND_PAYPAL', 'RETURN_DUPLICATE')),
    amount            INTEGER NOT NULL,
    currency          TEXT NOT NULL,
    authorization_id  TEXT NOT NULL,
    authorized_by     TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('PROCESSING', 'DONE', 'FAILED')),
    provider_ref      TEXT,                             -- PayPal refund id, or the correcting transfer's reference
    error             TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_resolution_actions_user ON resolution_actions(user_id, created_at);
`);

const q = {
  user: db.prepare('SELECT id, account_id, name, email FROM users WHERE id = ?'),
  wallet: db.prepare('SELECT id, currency FROM wallets WHERE user_id = ?'),
  tx: db.prepare('SELECT * FROM transactions WHERE reference = ? AND (sender_wallet_id = ? OR receiver_wallet_id = ?)'),
  txById: db.prepare('SELECT * FROM transactions WHERE id = ?'),
  byKey: db.prepare('SELECT * FROM resolution_actions WHERE idempotency_key = ?'),
  byRef: db.prepare('SELECT * FROM resolution_actions WHERE reference = ?'),
  insert: db.prepare(`INSERT INTO resolution_actions (idempotency_key, reference, transaction_id, user_id, action, amount, currency, authorization_id,
    authorized_by, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROCESSING', ?, ?)`),
  retry: db.prepare("UPDATE resolution_actions SET status = 'PROCESSING', error = NULL, updated_at = ? WHERE idempotency_key = ? AND status = 'FAILED'"),
  finish: db.prepare('UPDATE resolution_actions SET status = ?, provider_ref = ?, error = ?, updated_at = ? WHERE idempotency_key = ?'),
  today: db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM resolution_actions WHERE user_id = ? AND status <> 'FAILED' AND created_at >= ?"),
};

const LEGS = ['reference', 'type', 'status', 'amount', 'currency', 'provider', 'debited_at', 'credited_at', 'reversed_at', 'completed_at'];
const legs = (tx) => (tx ? Object.fromEntries(LEGS.map((k) => [k, tx[k]])) : null);
const plain = (r) => (r ? { ...r } : null);

function sameSecret(given, want) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(want ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.use((req, res, next) => {
  const token = process.env.RESOLUTION_API_TOKEN;
  const given = String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token || !sameSecret(given, token)) return res.status(404).json({ error: 'Not found.' });
  let sub;
  try {
    ({ sub } = jwt.verify(String(req.get('x-customer-session') ?? ''), config.jwtSecret));
  } catch {
    return res.status(401).json({ error: 'The customer is not signed in.' });
  }
  const user = q.user.get(Number(sub));
  const wallet = user && q.wallet.get(user.id);
  if (!wallet) return res.status(401).json({ error: 'The customer is not signed in.' });
  req.customer = { ...user };
  req.wallet = { ...wallet };
  next();
});

const fail = (res, status, error) => res.status(status).json({ error });

router.post('/actions', async (req, res) => {
  const b = req.body ?? {};
  const reference = String(b.reference ?? '');
  const key = String(b.idempotency_key ?? '');
  const action = String(b.action ?? '');
  const amount = Number(b.amount);
  const currency = String(b.currency ?? '');
  const authorizationId = String(b.authorization_id ?? '').slice(0, 64);
  const authorizedBy = String(b.authorized_by ?? '').slice(0, 200);
  if (key !== `resolve:${reference}`) return fail(res, 400, 'The idempotency key must be resolve:<reference>.');
  if (!['CREDIT_WALLET', 'RETURN_TO_WALLET', 'REFUND_PAYPAL', 'RETURN_DUPLICATE'].includes(action)) return fail(res, 400, 'Unknown action.');
  if (!authorizationId || !authorizedBy) return fail(res, 400, 'An authorization is required.');

  const w = req.wallet.id;
  const tx = q.tx.get(reference, w, w);
  if (!tx) return fail(res, 404, 'Transaction not found.');

  // Same key again: the first result, never a second action.
  const existing = q.byKey.get(key);
  if (existing && existing.status !== 'FAILED') {
    const same = existing.action === action && existing.amount === amount && existing.currency === currency && existing.user_id === req.customer.id;
    if (!same) return fail(res, 409, 'A different action was already carried out for this payment.');
    return res.json({ action: plain(existing), transaction: legs(q.txById.get(tx.id)), replayed: true });
  }

  if (!Number.isInteger(amount) || amount !== tx.amount || currency !== tx.currency) return fail(res, 409, "The amount does not match the payment.");
  const isPayer = tx.sender_wallet_id === w || (tx.type === 'TRANSFER' && tx.provider === 'PAYPAL' && tx.initiated_by === req.customer.id);
  const roleOk = action === 'CREDIT_WALLET' ? true : isPayer; // money only goes back to the payer
  if (!roleOk) return fail(res, 403, 'Only the payer can get this money back.');
  if (action === 'REFUND_PAYPAL' && !(tx.provider === 'PAYPAL' && tx.capture_id)) return fail(res, 409, 'This payment has no PayPal capture to refund.');

  const cap = (Number(process.env.RESOLUTION_DAILY_LIMIT) || 1000) * 100;
  const startOfDay = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  if (q.today.get(req.customer.id, startOfDay).total + amount > cap) return fail(res, 429, 'The daily resolution limit for this customer has been reached. Staff will follow up.');

  // Claim the payment. UNIQUE(reference): a second, different action for it is impossible.
  const ts = nowIso();
  try {
    if (existing) q.retry.run(ts, key);
    else q.insert.run(key, reference, tx.id, req.customer.id, action, amount, currency, authorizationId, authorizedBy, ts, ts);
  } catch {
    return fail(res, 409, 'This payment was already resolved.');
  }

  let providerRef = null;
  try {
    if (action === 'CREDIT_WALLET') ledger.resolveCredit(tx.id);
    if (action === 'RETURN_TO_WALLET') ledger.resolveReturn(tx.id);
    if (action === 'RETURN_DUPLICATE') providerRef = ledger.resolveDuplicate(tx.id, key).reference;
    if (action === 'REFUND_PAYPAL') {
      if (tx.status !== 'PENDING' || tx.credited_at || tx.reversed_at) throw Object.assign(new Error('This payment was already delivered or returned.'), { status: 409 });
      const r = await paypal.refundCapture(tx.capture_id, { amountCents: amount, currency, requestId: key, note: `FastPay refund for ${reference}` });
      if (!r.ok || !['COMPLETED', 'PENDING'].includes(r.data?.status)) {
        throw Object.assign(new Error(`PayPal did not refund it (${r.data?.name ?? r.status}${r.debugId ? `, debug id ${r.debugId}` : ''}).`), { status: 502 });
      }
      providerRef = r.data.id;
      ledger.resolvePaypalRefunded(tx.id, providerRef);
    }
  } catch (err) {
    q.finish.run('FAILED', providerRef, String(err.message).slice(0, 300), nowIso(), key);
    return fail(res, err.status ?? 500, err.message);
  }
  q.finish.run('DONE', providerRef, null, nowIso(), key);
  console.log(`[resolution] ${action} ${reference} ${amount} ${currency} by ${authorizedBy}`);
  res.json({ action: plain(q.byKey.get(key)), transaction: legs(q.txById.get(tx.id)) });
});

router.get('/actions/:key', (req, res) => {
  const row = q.byKey.get(String(req.params.key));
  if (!row || row.user_id !== req.customer.id) return fail(res, 404, 'Not found.');
  res.json({ action: plain(row), transaction: legs(q.txById.get(row.transaction_id)) });
});

export default router;
