// Read-only window for the investigation module (FastPay Module 2).
//
// The investigation never opens FastPay's database or holds the PayPal keys. It can only ask these
// questions, and only about ONE customer at a time:
//   GET /api/investigation/me                              who the customer is, and their wallet id
//   GET /api/investigation/transactions?since=&limit=      the customer's own transactions
//   GET /api/investigation/transactions/:reference         one of the customer's transactions (+ disputes)
//   GET /api/investigation/transactions/:reference/similar identical payments around the same time
//   GET /api/investigation/transactions/:reference/signals COUNTS ONLY: how many payments on the same channel got
//                                                          stuck or failed around the same time (incident detection).
//                                                          No names, references or amounts of other customers.
//   GET /api/investigation/reconciliation                  does the customer's own balance add up?
//   GET /api/investigation/paypal/:kind/:id                PayPal's record (orders | captures | payouts | invoices),
//                                                          only for an id that belongs to one of the customer's payments
//
// Every request needs BOTH:
//   Authorization: Bearer <INVESTIGATION_API_TOKEN>   proves it is the investigation service
//   X-Customer-Session: <the customer's fp_session>     proves which customer; all answers are limited to them
// Nothing here writes to the database or moves money. Test-mode fields (scheduled_outcome, settle_at,
// failure_reason) are never returned, so an investigation can't be "told" the answer.
import crypto from 'node:crypto';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { db } from '../db.js';
import * as paypal from '../paypal.js';

const router = Router();

const TX_COLUMNS = [
  'id', 'reference', 'type', 'status', 'amount', 'currency', 'sender_wallet_id', 'receiver_wallet_id', 'note',
  'provider', 'provider_ref', 'external_account', 'initiated_by', 'created_at', 'updated_at', 'completed_at',
  'debited_at', 'credited_at', 'reversed_at', 'capture_id', 'request_id',
];
const TX_SELECT = `
  SELECT ${TX_COLUMNS.map((c) => `t.${c}`).join(', ')},
         su.name AS sender_name,   su.account_id AS sender_account_id,   su.email AS sender_email,
         ru.name AS receiver_name, ru.account_id AS receiver_account_id, ru.email AS receiver_email
  FROM transactions t
  LEFT JOIN wallets sw ON sw.id = t.sender_wallet_id
  LEFT JOIN users   su ON su.id = sw.user_id
  LEFT JOIN wallets rw ON rw.id = t.receiver_wallet_id
  LEFT JOIN users   ru ON ru.id = rw.user_id`;
const MINE = '(t.sender_wallet_id = ? OR t.receiver_wallet_id = ?)';

const q = {
  user: db.prepare('SELECT id, account_id, name, email FROM users WHERE id = ?'),
  wallet: db.prepare('SELECT id, currency FROM wallets WHERE user_id = ?'),
  list: db.prepare(`${TX_SELECT} WHERE ${MINE} AND t.created_at >= ? ORDER BY t.created_at DESC, t.id DESC LIMIT ?`),
  byRef: db.prepare(`${TX_SELECT} WHERE t.reference = ? AND ${MINE}`),
  disputes: db.prepare('SELECT id, reason, status, outcome, amount, currency, created_at, updated_at FROM disputes WHERE transaction_id = ? ORDER BY created_at'),
  similar: db.prepare(
    `${TX_SELECT} WHERE t.id <> ? AND ${MINE} AND t.type = ? AND t.amount = ? AND t.provider = ?
       AND COALESCE(t.sender_wallet_id, -1) = COALESCE(?, -1)
       AND COALESCE(t.receiver_wallet_id, -1) = COALESCE(?, -1)
       AND COALESCE(t.external_account, '') = COALESCE(?, '')
       AND t.created_at BETWEEN ? AND ?
     ORDER BY t.created_at`,
  ),
  // One statement, one consistent snapshot. Same money rules as ledger.js: credits - wallet debits + returns
  // (PayPal-funded transfers are charged to PayPal, not the wallet).
  reconcile: db.prepare(`
    SELECT w.balance AS recorded_balance, w.currency,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE receiver_wallet_id = w.id AND credited_at IS NOT NULL) AS credits,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE sender_wallet_id = w.id AND debited_at IS NOT NULL
         AND NOT (type = 'TRANSFER' AND provider = 'PAYPAL')) AS debits,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE sender_wallet_id = w.id AND reversed_at IS NOT NULL
         AND NOT (type = 'TRANSFER' AND provider = 'PAYPAL')) AS returns,
      (SELECT COUNT(*) FROM transactions WHERE receiver_wallet_id = w.id OR sender_wallet_id = w.id) AS transactions_counted
    FROM wallets w WHERE w.id = ?`),
  // Incident signals for one channel (type + provider) in a time window. Aggregates only.
  // "stuck" = money left the payer, nothing was credited or returned, and it is older than the grace period.
  signals: db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN status = 'PENDING' AND debited_at IS NOT NULL AND credited_at IS NULL AND reversed_at IS NULL
                         AND debited_at <= ? THEN 1 ELSE 0 END), 0) AS stuck,
      COUNT(DISTINCT CASE WHEN status = 'PENDING' AND debited_at IS NOT NULL AND credited_at IS NULL AND reversed_at IS NULL
                         AND debited_at <= ? THEN initiated_by END) AS affected_customers,
      COUNT(DISTINCT CASE WHEN status = 'PENDING' AND debited_at IS NOT NULL AND credited_at IS NULL AND reversed_at IS NULL
                         AND debited_at <= ? AND initiated_by <> ? THEN initiated_by END) AS others_affected
    FROM transactions
    WHERE type = ? AND provider = ? AND created_at BETWEEN ? AND ?`),
  webhookErrors: db.prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE status = 'ERROR' AND received_at BETWEEN ? AND ?"),
  // A PayPal id the customer may ask about: it must belong to one of their own payments.
  ownsPaypalId: db.prepare(`SELECT 1 FROM transactions t WHERE (t.provider_ref = ? OR t.capture_id = ?) AND ${MINE} LIMIT 1`),
};

const plain = (row) => (row ? { ...row } : null);

function sameSecret(given, want) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(want ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Who is asking, and about which customer -------------------------------------

router.use((req, res, next) => {
  const token = process.env.INVESTIGATION_API_TOKEN;
  const given = String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  // Off unless a token is configured, and the same 404 as any unknown route.
  if (!token || !sameSecret(given, token)) return res.status(404).json({ error: 'Not found.' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'This API is read-only.' });

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

// ---- The questions -----------------------------------------------------------------

router.get('/me', (req, res) => {
  res.json({ user: req.customer, wallet: { id: req.wallet.id, currency: req.wallet.currency } });
});

router.get('/transactions', (req, res) => {
  const since = typeof req.query.since === 'string' && !Number.isNaN(Date.parse(req.query.since)) ? req.query.since : '1970-01-01T00:00:00.000Z';
  const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 1000);
  const w = req.wallet.id;
  res.json({ transactions: q.list.all(w, w, since, limit).map(plain) });
});

router.get('/transactions/:reference', (req, res) => {
  const w = req.wallet.id;
  const tx = plain(q.byRef.get(req.params.reference, w, w));
  if (!tx) return res.status(404).json({ error: 'Transaction not found.' });
  tx.disputes = q.disputes.all(tx.id).map(plain);
  res.json({ transaction: tx });
});

router.get('/transactions/:reference/similar', (req, res) => {
  const w = req.wallet.id;
  const tx = q.byRef.get(req.params.reference, w, w);
  if (!tx) return res.status(404).json({ error: 'Transaction not found.' });
  const minutes = Math.min(Math.max(Number(req.query.minutes) || 60, 1), 24 * 60);
  const t = new Date(tx.created_at).getTime();
  const rows = q.similar.all(
    tx.id, w, w, tx.type, tx.amount, tx.provider, tx.sender_wallet_id, tx.receiver_wallet_id, tx.external_account,
    new Date(t - minutes * 60_000).toISOString(), new Date(t + minutes * 60_000).toISOString(),
  );
  res.json({ transactions: rows.map(plain) });
});

router.get('/transactions/:reference/signals', (req, res) => {
  const w = req.wallet.id;
  const tx = q.byRef.get(req.params.reference, w, w); // the channel and time come from the customer's own payment
  if (!tx) return res.status(404).json({ error: 'Transaction not found.' });
  const minutes = Math.min(Math.max(Number(req.query.minutes) || 60, 5), 24 * 60);
  const graceMinutes = Math.min(Math.max(Number(req.query.stuck_after) || 10, 1), 24 * 60);
  const t = new Date(tx.created_at).getTime();
  const from = new Date(t - minutes * 60_000).toISOString();
  const to = new Date(t + minutes * 60_000).toISOString();
  const cutoff = new Date(Date.now() - graceMinutes * 60_000).toISOString();
  const s = { ...q.signals.get(cutoff, cutoff, cutoff, req.customer.id, tx.type, tx.provider, from, to) };
  res.json({
    signals: {
      channel: { type: tx.type, provider: tx.provider },
      window: { from, to, minutes },
      stuck_after_minutes: graceMinutes,
      total: s.total,
      failed: s.failed,
      stuck: s.stuck,
      affected_customers: s.affected_customers,
      others_affected: s.others_affected,
      webhook_errors: q.webhookErrors.get(from, to).n,
      checked_at: new Date().toISOString(),
    },
  });
});

router.get('/reconciliation', (req, res) => {
  const r = plain(q.reconcile.get(req.wallet.id));
  const expected = r.credits - r.debits + r.returns;
  res.json({ reconciliation: { ...r, expected_balance: expected, difference: r.recorded_balance - expected, matches: r.recorded_balance === expected } });
});

const PAYPAL_READS = {
  orders: (id) => paypal.getOrder(id),
  captures: (id) => paypal.getCapture(id),
  payouts: (id) => paypal.getPayout(id),
  invoices: (id) => paypal.getInvoice(id),
};

router.get('/paypal/:kind/:id', async (req, res) => {
  const read = PAYPAL_READS[req.params.kind];
  if (!read) return res.status(404).json({ error: 'Not found.' });
  const w = req.wallet.id;
  if (!q.ownsPaypalId.get(req.params.id, req.params.id, w, w)) return res.status(404).json({ error: 'Not one of this customer\'s payments.' });
  const retrieved_at = new Date().toISOString();
  try {
    const r = await read(req.params.id);
    res.json({ ok: r.ok, status: r.status, data: r.data, debug_id: r.debugId ?? null, retrieved_at });
  } catch (err) {
    // PayPal unreachable or keys rejected: say so, so the investigation reports INCONCLUSIVE instead of guessing.
    res.json({ ok: false, status: 0, data: null, error: err.message || 'Could not reach PayPal.', debug_id: null, retrieved_at });
  }
});

export default router;
