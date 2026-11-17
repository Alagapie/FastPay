// All balance-changing operations live here so the money rules are in one place.
//
// Every transaction records its legs:
//   debited_at   – money left the payer (FastPay wallet, or PayPal for PayPal-funded payments)
//   credited_at  – money reached the payee (FastPay wallet, or PayPal account for withdrawals)
//   reversed_at  – held money was returned to the payer (only when a pending payment fails)
//
// Transaction types:
//   DEPOSIT     PayPal / test bank  -> my wallet
//   TRANSFER    payer               -> another user's wallet   (funded by FastPay balance or PayPal)
//   WITHDRAWAL  my wallet           -> my PayPal account       (PayPal Payouts)
import { config } from './config.js';
import { db, inTransaction, nowIso } from './db.js';
import { HttpError, newReference } from './util.js';

const TX_SELECT = `
  SELECT t.*,
         su.name AS sender_name,   su.account_id AS sender_account_id,   su.email AS sender_email,
         ru.name AS receiver_name, ru.account_id AS receiver_account_id, ru.email AS receiver_email,
         (SELECT d.status FROM disputes d WHERE d.transaction_id = t.id ORDER BY d.updated_at DESC LIMIT 1) AS dispute_status
  FROM transactions t
  LEFT JOIN wallets sw ON sw.id = t.sender_wallet_id
  LEFT JOIN users   su ON su.id = sw.user_id
  LEFT JOIN wallets rw ON rw.id = t.receiver_wallet_id
  LEFT JOIN users   ru ON ru.id = rw.user_id`;

// A receiver doesn't see transfers that failed, never reached them, or are still in PayPal checkout.
const HIDDEN_FROM_RECEIVER = `(t.type = 'TRANSFER' AND (
  t.status = 'FAILED' OR COALESCE(t.scheduled_outcome, '') = 'STUCK' OR (t.provider = 'PAYPAL' AND t.status = 'PENDING')))`;
const VISIBLE_TO = `(t.sender_wallet_id = ? OR (t.receiver_wallet_id = ? AND NOT ${HIDDEN_FROM_RECEIVER}))`;

const q = {
  walletByUser: db.prepare('SELECT * FROM wallets WHERE user_id = ?'),
  debit: db.prepare('UPDATE wallets SET balance = balance - ? WHERE id = ? AND balance >= ?'),
  credit: db.prepare('UPDATE wallets SET balance = balance + ? WHERE id = ?'),
  insertTx: db.prepare(`
    INSERT INTO transactions
      (reference, type, status, amount, currency, sender_wallet_id, receiver_wallet_id, note,
       failure_reason, provider, provider_ref, external_account, initiated_by, idempotency_key, settle_at,
       scheduled_outcome, created_at, updated_at, completed_at, debited_at, credited_at, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  txById: db.prepare(`${TX_SELECT} WHERE t.id = ?`),
  txByRef: db.prepare(`${TX_SELECT} WHERE t.reference = ?`),
  txByIdempotency: db.prepare('SELECT id FROM transactions WHERE initiated_by = ? AND idempotency_key = ?'),
  rawTx: db.prepare('SELECT * FROM transactions WHERE id = ?'),
  markSuccess: db.prepare(`UPDATE transactions SET status = 'SUCCESS', failure_reason = NULL, updated_at = ?, completed_at = ?,
                           credited_at = ?, settle_at = NULL, scheduled_outcome = NULL WHERE id = ? AND status = 'PENDING'`),
  markFailed: db.prepare(`UPDATE transactions SET status = 'FAILED', failure_reason = ?, updated_at = ?, completed_at = ?,
                          reversed_at = ?, settle_at = NULL, scheduled_outcome = NULL WHERE id = ? AND status = 'PENDING'`),
  markStuck: db.prepare(`UPDATE transactions SET scheduled_outcome = 'STUCK', settle_at = NULL, failure_reason = ?, updated_at = ?
                         WHERE id = ? AND status = 'PENDING'`),
  setDebited: db.prepare('UPDATE transactions SET debited_at = ?, updated_at = ? WHERE id = ?'),
  setProviderRef: db.prepare('UPDATE transactions SET provider_ref = ?, updated_at = ? WHERE id = ?'),
  setCaptureId: db.prepare('UPDATE transactions SET capture_id = ?, updated_at = ? WHERE id = ?'),
  setInvoice: db.prepare('UPDATE transactions SET provider_ref = ?, payment_url = ?, updated_at = ? WHERE id = ?'),
  byProviderRef: db.prepare('SELECT * FROM transactions WHERE provider_ref = ?'),
  byCaptureId: db.prepare('SELECT * FROM transactions WHERE capture_id = ?'),
  openRequests: db.prepare(`SELECT * FROM transactions WHERE provider = 'PAYPAL_INVOICE' AND status = 'PENDING' AND provider_ref IS NOT NULL`),
  staleOrders: db.prepare(`SELECT * FROM transactions WHERE provider = 'PAYPAL' AND type <> 'WITHDRAWAL' AND status = 'PENDING'
                           AND scheduled_outcome IS NULL AND created_at <= ? LIMIT 25`),
  upsertDispute: db.prepare(`
    INSERT INTO disputes (id, transaction_id, reason, status, outcome, amount, currency, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET transaction_id = excluded.transaction_id, reason = excluded.reason, status = excluded.status,
      outcome = excluded.outcome, amount = excluded.amount, currency = excluded.currency, updated_at = excluded.updated_at`),
  disputesForTx: db.prepare('SELECT * FROM disputes WHERE transaction_id = ? ORDER BY created_at DESC'),
  insertRequest: db.prepare(`INSERT INTO payment_requests (reference, requester_id, payer_id, amount, currency, note, status, created_at, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`),
  requestByRef: db.prepare('SELECT * FROM payment_requests WHERE reference = ?'),
  setRequestStatus: db.prepare(`UPDATE payment_requests SET status = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'`),
  markRequestPaid: db.prepare(`UPDATE payment_requests SET status = 'PAID', paid_reference = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'`),
  incomingRequests: db.prepare(`
    SELECT r.*, u.name AS requester_name, u.account_id AS requester_account_id
    FROM payment_requests r JOIN users u ON u.id = r.requester_id
    WHERE r.payer_id = ? ORDER BY (r.status = 'PENDING') DESC, r.created_at DESC LIMIT 50`),
  outgoingRequests: db.prepare(`
    SELECT r.*, u.name AS payer_name, u.account_id AS payer_account_id, u.email AS payer_email
    FROM payment_requests r JOIN users u ON u.id = r.payer_id
    WHERE r.requester_id = ? ORDER BY r.created_at DESC LIMIT 50`),
  invoicesToMe: db.prepare(`
    SELECT t.*, u.name AS requester_name, u.account_id AS requester_account_id
    FROM transactions t JOIN users u ON u.id = t.initiated_by
    WHERE t.provider = 'PAYPAL_INVOICE' AND t.external_account = ? COLLATE NOCASE AND t.initiated_by <> ?
    ORDER BY (t.status = 'PENDING') DESC, t.created_at DESC LIMIT 50`),
  invoicesFromMe: db.prepare(`SELECT * FROM transactions WHERE provider = 'PAYPAL_INVOICE' AND initiated_by = ? ORDER BY created_at DESC LIMIT 50`),
  countIncoming: db.prepare(`
    SELECT (SELECT COUNT(*) FROM payment_requests WHERE payer_id = ? AND status = 'PENDING')
         + (SELECT COUNT(*) FROM transactions WHERE provider = 'PAYPAL_INVOICE' AND status = 'PENDING'
              AND external_account = ? COLLATE NOCASE AND initiated_by <> ?) AS n`),
  paypalOrder: db.prepare(`SELECT * FROM transactions WHERE provider = 'PAYPAL' AND type <> 'WITHDRAWAL' AND provider_ref = ? AND initiated_by = ?`),
  pendingPayouts: db.prepare(`SELECT * FROM transactions WHERE type = 'WITHDRAWAL' AND status = 'PENDING' AND provider_ref IS NOT NULL`),
  dueSettlements: db.prepare(`SELECT id FROM transactions WHERE status = 'PENDING' AND settle_at IS NOT NULL AND settle_at <= ?`),
  pendingTotals: db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN receiver_wallet_id = ? AND COALESCE(scheduled_outcome, '') <> 'STUCK'
                         AND NOT (type = 'TRANSFER' AND provider = 'PAYPAL') AND provider <> 'PAYPAL_INVOICE' THEN amount END), 0) AS incoming,
      COALESCE(SUM(CASE WHEN sender_wallet_id = ? AND debited_at IS NOT NULL AND provider <> 'PAYPAL' THEN amount END), 0)
      + COALESCE(SUM(CASE WHEN sender_wallet_id = ? AND type = 'WITHDRAWAL' THEN amount END), 0) AS outgoing
    FROM transactions WHERE status = 'PENDING' AND (receiver_wallet_id = ? OR sender_wallet_id = ?)`),
  stats: db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN receiver_wallet_id = ? AND type = 'TRANSFER' THEN amount END), 0) AS received,
      COALESCE(SUM(CASE WHEN receiver_wallet_id = ? AND type = 'DEPOSIT'  THEN amount END), 0) AS deposited,
      COALESCE(SUM(CASE WHEN sender_wallet_id   = ? AND status = 'SUCCESS' THEN amount END), 0)
      + COALESCE(SUM(CASE WHEN sender_wallet_id = ? AND status = 'PENDING' AND debited_at IS NOT NULL THEN amount END), 0) AS sent,
      COUNT(*) AS count
    FROM transactions
    WHERE (status = 'SUCCESS' OR (status = 'PENDING' AND debited_at IS NOT NULL AND sender_wallet_id = ?))
      AND created_at >= ? AND (receiver_wallet_id = ? OR sender_wallet_id = ?)`),
};

export function getWallet(userId) {
  const wallet = q.walletByUser.get(userId);
  if (!wallet) throw new HttpError(404, 'Wallet not found.');
  return wallet;
}

export function walletSummary(userId) {
  const w = getWallet(userId);
  const p = q.pendingTotals.get(w.id, w.id, w.id, w.id, w.id);
  return {
    id: w.id,
    currency: w.currency,
    balance: w.balance,
    pending_incoming: p.incoming,
    pending_outgoing: 0, // payments that left the balance are shown as completed, so nothing is "on hold"
    created_at: w.created_at,
  };
}

/** Successful money in / out over the last `days` days. */
export function walletStats(userId, days = 30) {
  const w = getWallet(userId);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const s = q.stats.get(w.id, w.id, w.id, w.id, w.id, since, w.id, w.id);
  return { days, money_in: s.received + s.deposited, received: s.received, deposited: s.deposited, money_out: s.sent, count: s.count };
}

/**
 * What the PAYER is shown, like a bank receipt: once money has left their balance (or been charged to
 * their PayPal), the payment reads "Successful", even if it is still processing or never reached the
 * recipient. If the money later comes back, it reads "Refunded". Payments where nothing left the
 * payer (declined, insufficient funds) keep their real status.
 * The database row is never changed: debited_at / credited_at / reversed_at and the real status stay
 * there for investigation (Amana reads the database, not this view).
 */
export function payerView(row) {
  if (!row.debited_at || row.status === 'SUCCESS') return { status: row.status, failure_reason: row.failure_reason };
  if (row.status === 'FAILED' && row.reversed_at) {
    return { status: 'REFUNDED', failure_reason: 'The money was returned to your balance.' };
  }
  if (row.status === 'PENDING') return { status: 'SUCCESS', failure_reason: null, shownCompletedAt: row.debited_at };
  return { status: row.status, failure_reason: row.failure_reason };
}

// SQL version of payerView's status, so the Activity status filter matches what the payer sees.
const DISPLAY_STATUS_SQL = `CASE
  WHEN t.sender_wallet_id = ? AND t.debited_at IS NOT NULL AND t.status = 'PENDING' THEN 'SUCCESS'
  WHEN t.sender_wallet_id = ? AND t.debited_at IS NOT NULL AND t.status = 'FAILED' AND t.reversed_at IS NOT NULL THEN 'REFUNDED'
  ELSE t.status END`;

/** Shape a transaction row from the point of view of the wallet looking at it. */
export function serialize(row, viewerWalletId) {
  const isDebit = row.type !== 'DEPOSIT' && row.sender_wallet_id === viewerWalletId;
  let counterparty;
  if (row.type === 'DEPOSIT' && row.provider === 'PAYPAL_INVOICE') {
    counterparty = { name: row.external_account, email: row.external_account };
  } else if (row.type === 'DEPOSIT') {
    counterparty = { name: row.provider === 'PAYPAL' ? 'PayPal' : 'Test bank deposit' };
  } else if (row.type === 'WITHDRAWAL') {
    counterparty = { name: 'PayPal', email: row.external_account };
  } else if (isDebit) {
    counterparty = { name: row.receiver_name, account_id: row.receiver_account_id, email: row.receiver_email };
  } else {
    counterparty = { name: row.sender_name, account_id: row.sender_account_id, email: row.sender_email };
  }
  const view = isDebit ? payerView(row) : { status: row.status, failure_reason: row.failure_reason };
  const shownDone = view.shownCompletedAt; // set when a still-processing payment is shown as Successful
  return {
    reference: row.reference,
    type: row.type,
    direction: isDebit ? 'DEBIT' : 'CREDIT',
    status: view.status,
    amount: row.amount,
    fee: 0,
    currency: row.currency,
    note: row.note,
    failure_reason: view.failure_reason,
    provider: row.provider,
    provider_ref: row.provider_ref,
    external_account: row.external_account,
    capture_id: row.capture_id,
    payment_url: row.payment_url,
    dispute_status: row.dispute_status ?? null,
    counterparty,
    sender: row.sender_name ? { name: row.sender_name, account_id: row.sender_account_id } : null,
    receiver: row.receiver_name ? { name: row.receiver_name, account_id: row.receiver_account_id } : null,
    expected_settlement: shownDone ? null : row.settle_at,
    debited_at: row.debited_at,
    credited_at: shownDone ?? row.credited_at,
    reversed_at: row.reversed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: shownDone ?? row.completed_at,
  };
}

/** Serialize from the point of view of whoever initiated the transaction. */
export function serializeById(txId) {
  const row = q.txById.get(txId);
  return serialize(row, getWallet(row.initiated_by).id);
}

function visibleToWallet(row, walletId) {
  if (!row) return false;
  if (row.sender_wallet_id === walletId) return true;
  if (row.receiver_wallet_id !== walletId) return false;
  const hidden =
    row.type === 'TRANSFER' &&
    (row.status === 'FAILED' || row.scheduled_outcome === 'STUCK' || (row.provider === 'PAYPAL' && row.status === 'PENDING'));
  return !hidden;
}

export function getTransactionForUser(reference, userId) {
  const wallet = getWallet(userId);
  const row = q.txByRef.get(reference);
  if (!visibleToWallet(row, wallet.id)) throw new HttpError(404, 'Transaction not found.');
  const tx = serialize(row, wallet.id);
  // Disputes are opened by the payer, so only the person who initiated the payment sees them.
  tx.disputes = row.initiated_by === userId ? q.disputesForTx.all(row.id).map(publicDispute) : [];
  return tx;
}

const publicDispute = (d) => ({
  id: d.id, reason: d.reason, status: d.status, outcome: d.outcome, amount: d.amount, currency: d.currency,
  created_at: d.created_at, updated_at: d.updated_at,
});

// ---- Lookups used by PayPal webhooks and status sync -------------------------

export const findByProviderRef = (ref) => (ref ? q.byProviderRef.get(ref) : undefined);
export const findByCaptureId = (id) => (id ? q.byCaptureId.get(id) : undefined);
export const openRequests = () => q.openRequests.all();
/** PayPal checkouts still pending after `minutes` (abandoned, or approved but never captured). */
export const staleOrders = (minutes) => q.staleOrders.all(new Date(Date.now() - minutes * 60_000).toISOString());

export function recordDispute({ id, transactionId, reason, status, outcome, amount, currency, createdAt }) {
  q.upsertDispute.run(id, transactionId ?? null, reason ?? null, status ?? null, outcome ?? null, amount ?? null, currency ?? null,
    createdAt ?? nowIso(), nowIso());
}

// ---- Payment requests (PayPal Invoicing) --------------------------------------
// A request is recorded as a pending DEPOSIT into the requester's wallet (provider PAYPAL_INVOICE).
// It is credited only when PayPal reports the invoice as PAID.

export function createPaymentRequest({ userId, amount, payerEmail, note }) {
  const id = inTransaction(() => {
    const w = getWallet(userId);
    return insertTransaction({
      type: 'DEPOSIT',
      status: 'PENDING',
      amount,
      currency: w.currency,
      receiver_wallet_id: w.id,
      note,
      provider: 'PAYPAL_INVOICE',
      external_account: payerEmail,
      initiated_by: userId,
    });
  });
  return q.rawTx.get(id);
}

export function attachInvoice(txId, invoiceId, paymentUrl) {
  q.setInvoice.run(invoiceId, paymentUrl ?? null, nowIso(), txId);
}

/** The payer paid the invoice: credit the requester. Safe to call twice. */
export function completeRequest(txId) {
  inTransaction(() => {
    const tx = q.rawTx.get(txId);
    if (!tx || tx.status !== 'PENDING') return;
    const ts = nowIso();
    q.credit.run(tx.amount, tx.receiver_wallet_id);
    q.setDebited.run(ts, ts, txId);
    q.markSuccess.run(ts, ts, ts, txId);
  });
}

/** The request ended without payment (cancelled, or PayPal could not send it). No money moves. */
export function closeRequest(txId, reason) {
  const ts = nowIso();
  q.markFailed.run(reason, ts, ts, null, txId);
}

export function getRequestForOwner(reference, userId) {
  const row = q.rawTx.get(q.txByRef.get(reference)?.id ?? -1);
  if (!row || row.initiated_by !== userId || row.provider !== 'PAYPAL_INVOICE') throw new HttpError(404, 'Request not found.');
  return row;
}

export function listTransactions(userId, { filter = 'all', status, limit = 20, offset = 0 } = {}) {
  const wallet = getWallet(userId);
  const where = [VISIBLE_TO];
  const params = [wallet.id, wallet.id];

  if (filter === 'sent') {
    where.push(`t.type = 'TRANSFER' AND t.sender_wallet_id = ?`);
    params.push(wallet.id);
  } else if (filter === 'received') {
    where.push(`t.type = 'TRANSFER' AND t.receiver_wallet_id = ?`);
    params.push(wallet.id);
  } else if (filter === 'deposits') {
    where.push(`t.type = 'DEPOSIT' AND t.provider <> 'PAYPAL_INVOICE'`);
  } else if (filter === 'requests') {
    where.push(`t.provider = 'PAYPAL_INVOICE'`);
  } else if (filter === 'withdrawals') {
    where.push(`t.type = 'WITHDRAWAL'`);
  }
  if (['PENDING', 'SUCCESS', 'FAILED', 'REFUNDED'].includes(status)) {
    where.push(`${DISPLAY_STATUS_SQL} = ?`);
    params.push(wallet.id, wallet.id, status);
  }

  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const off = Math.max(Number(offset) || 0, 0);
  const rows = db
    .prepare(`${TX_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`)
    .all(...params, lim + 1, off);

  return {
    items: rows.slice(0, lim).map((r) => serialize(r, wallet.id)),
    has_more: rows.length > lim,
  };
}

function insertTransaction(fields) {
  const ts = nowIso();
  const { lastInsertRowid } = q.insertTx.run(
    newReference(),
    fields.type,
    fields.status,
    fields.amount,
    fields.currency,
    fields.sender_wallet_id ?? null,
    fields.receiver_wallet_id ?? null,
    fields.note || null,
    fields.failure_reason ?? null,
    fields.provider,
    fields.provider_ref ?? null,
    fields.external_account ?? null,
    fields.initiated_by,
    fields.idempotency_key ?? null,
    fields.settle_at ?? null,
    fields.scheduled_outcome ?? null,
    ts,
    ts,
    fields.status === 'PENDING' ? null : ts,
    fields.debited ? ts : null,
    fields.credited ? ts : null,
    fields.request_id ?? null,
  );
  return Number(lastInsertRowid);
}

const secondsFromNow = (s) => new Date(Date.now() + s * 1000).toISOString();

// ---- Transfers funded by FastPay balance ------------------------------------

/**
 * Send money from one user's wallet to another's.
 * simulate: success | pending (settles OK later) | pending_fail (fails later, held funds returned) | fail
 *           | credit_fail (sender debited, recipient never credited — stays stuck)
 * Always records the attempt and returns the transaction, even when it fails.
 */
export function transfer({ senderUserId, recipientUserId, amount, note, simulate, idempotencyKey }) {
  if (senderUserId === recipientUserId) throw new HttpError(400, 'You cannot send money to yourself.');

  const id = inTransaction(() => {
    if (idempotencyKey) {
      const existing = q.txByIdempotency.get(senderUserId, idempotencyKey);
      if (existing) return existing.id;
    }

    const from = getWallet(senderUserId);
    const to = getWallet(recipientUserId);
    if (from.currency !== to.currency) throw new HttpError(400, 'Cross-currency transfers are not supported.');

    const base = {
      type: 'TRANSFER',
      amount,
      currency: from.currency,
      sender_wallet_id: from.id,
      receiver_wallet_id: to.id,
      note,
      provider: 'FASTPAY',
      initiated_by: senderUserId,
      idempotency_key: idempotencyKey,
    };

    if (simulate === 'fail') {
      return insertTransaction({ ...base, status: 'FAILED', failure_reason: 'Payment declined by the processor (simulated).' });
    }

    // The debit only succeeds if funds are sufficient, so concurrent sends can never overdraw.
    const debited = q.debit.run(amount, from.id, amount).changes === 1;
    if (!debited) {
      return insertTransaction({ ...base, status: 'FAILED', failure_reason: 'Insufficient funds.' });
    }

    if (simulate === 'credit_fail') {
      // The debit committed but the credit leg never happened. Nothing resolves it automatically.
      return insertTransaction({
        ...base,
        status: 'PENDING',
        debited: true,
        scheduled_outcome: 'STUCK',
        failure_reason: 'The money left your balance but was never credited to the recipient (simulated).',
      });
    }

    if (simulate === 'pending' || simulate === 'pending_fail') {
      return insertTransaction({
        ...base,
        status: 'PENDING',
        debited: true,
        settle_at: secondsFromNow(config.pendingSeconds),
        scheduled_outcome: simulate === 'pending' ? 'SUCCESS' : 'FAILED',
      });
    }

    q.credit.run(amount, to.id);
    return insertTransaction({ ...base, status: 'SUCCESS', debited: true, credited: true });
  });

  return serialize(q.txById.get(id), getWallet(senderUserId).id);
}

/** Simulated (non-PayPal) deposit for demos and testing. */
export function simulatedDeposit({ userId, amount, simulate }) {
  if (simulate === 'credit_fail') throw new HttpError(400, 'That test outcome only applies to payments.');
  const id = inTransaction(() => {
    const w = getWallet(userId);
    const base = { type: 'DEPOSIT', amount, currency: w.currency, receiver_wallet_id: w.id, provider: 'SIMULATED', initiated_by: userId };
    if (simulate === 'fail') {
      return insertTransaction({ ...base, status: 'FAILED', failure_reason: 'Bank declined the deposit (simulated).' });
    }
    if (simulate === 'pending' || simulate === 'pending_fail') {
      return insertTransaction({
        ...base,
        status: 'PENDING',
        settle_at: secondsFromNow(config.pendingSeconds),
        scheduled_outcome: simulate === 'pending' ? 'SUCCESS' : 'FAILED',
      });
    }
    q.credit.run(amount, w.id);
    return insertTransaction({ ...base, status: 'SUCCESS', credited: true });
  });
  return serialize(q.txById.get(id), getWallet(userId).id);
}

// ---- PayPal Checkout orders (deposits and PayPal-funded transfers) ----------

/** Record a PayPal order before the buyer approves it. Recipient omitted = top-up of own wallet. */
export function createPendingPaypalOrder({ userId, amount, orderId, recipientUserId, note, requestId }) {
  const id = inTransaction(() => {
    const me = getWallet(userId);
    if (recipientUserId) {
      const to = getWallet(recipientUserId);
      return insertTransaction({
        type: 'TRANSFER',
        status: 'PENDING',
        amount,
        currency: me.currency,
        sender_wallet_id: me.id,
        receiver_wallet_id: to.id,
        note,
        provider: 'PAYPAL',
        provider_ref: orderId,
        initiated_by: userId,
        request_id: requestId,
      });
    }
    return insertTransaction({
      type: 'DEPOSIT',
      status: 'PENDING',
      amount,
      currency: me.currency,
      receiver_wallet_id: me.id,
      provider: 'PAYPAL',
      provider_ref: orderId,
      initiated_by: userId,
    });
  });
  return q.rawTx.get(id);
}

export function findPaypalOrder(orderId, userId) {
  const row = q.paypalOrder.get(orderId, userId);
  if (!row) throw new HttpError(404, 'Payment not found.');
  return row;
}

/**
 * Finish a PayPal order after capture. Safe to call twice.
 *   success    – PayPal charged the payer; credit the payee's wallet.
 *   stuck      – PayPal charged the payer but the credit to the payee "fails" (simulated).
 *   otherwise  – the payment failed at PayPal; nothing was charged.
 */
export function completePaypalOrder(txId, { success, stuck, failureReason, captureId }) {
  inTransaction(() => {
    const tx = q.rawTx.get(txId);
    if (!tx || tx.status !== 'PENDING' || tx.scheduled_outcome === 'STUCK') return;
    const ts = nowIso();
    // provider_ref keeps the PayPal order id; the capture id is stored separately to match disputes.
    if (captureId) q.setCaptureId.run(captureId, ts, txId);
    if (success || stuck) q.setDebited.run(ts, ts, txId);

    if (stuck) {
      q.markStuck.run('PayPal charged the payment but FastPay never credited the recipient (simulated).', ts, txId);
    } else if (success) {
      q.credit.run(tx.amount, tx.receiver_wallet_id);
      q.markSuccess.run(ts, ts, ts, txId);
      if (tx.request_id) q.markRequestPaid.run(tx.reference, ts, tx.request_id);
    } else {
      q.markFailed.run(failureReason || 'Payment failed.', ts, ts, null, txId);
    }
  });
  return serializeById(txId);
}

// ---- Withdrawals to PayPal (Payouts) ----------------------------------------

/** Debit the wallet and record a pending withdrawal. Returns the raw row (FAILED if funds are short). */
export function createWithdrawal({ userId, amount, email, idempotencyKey }) {
  const id = inTransaction(() => {
    if (idempotencyKey) {
      const existing = q.txByIdempotency.get(userId, idempotencyKey);
      if (existing) return existing.id;
    }
    const w = getWallet(userId);
    const base = {
      type: 'WITHDRAWAL',
      amount,
      currency: w.currency,
      sender_wallet_id: w.id,
      provider: 'PAYPAL',
      external_account: email,
      initiated_by: userId,
      idempotency_key: idempotencyKey,
    };
    if (q.debit.run(amount, w.id, amount).changes !== 1) {
      return insertTransaction({ ...base, status: 'FAILED', failure_reason: 'Insufficient funds.' });
    }
    return insertTransaction({ ...base, status: 'PENDING', debited: true });
  });
  return q.rawTx.get(id);
}

export function attachPayout(txId, payoutBatchId) {
  q.setProviderRef.run(payoutBatchId, nowIso(), txId);
}

/** PayPal paid out the money. */
export function completeWithdrawal(txId) {
  const ts = nowIso();
  q.markSuccess.run(ts, ts, ts, txId);
}

/** PayPal did not pay out, so the money never left FastPay: put it back in the wallet. */
export function failWithdrawal(txId, reason) {
  inTransaction(() => {
    const tx = q.rawTx.get(txId);
    if (!tx || tx.status !== 'PENDING') return;
    const ts = nowIso();
    if (tx.debited_at) q.credit.run(tx.amount, tx.sender_wallet_id);
    q.markFailed.run(`${reason} The amount is back in your FastPay balance.`, ts, ts, tx.debited_at ? ts : null, txId);
  });
}

export const pendingPayouts = () => q.pendingPayouts.all();

// ---- Settlement of simulated pending payments -------------------------------

function settle(txId) {
  inTransaction(() => {
    const tx = q.rawTx.get(txId);
    if (!tx || tx.status !== 'PENDING') return;
    const ts = nowIso();
    if (tx.scheduled_outcome === 'SUCCESS') {
      q.credit.run(tx.amount, tx.receiver_wallet_id);
      q.markSuccess.run(ts, ts, ts, txId);
      return;
    }
    if (tx.scheduled_outcome !== 'FAILED') return;
    const refund = Boolean(tx.sender_wallet_id && tx.debited_at);
    if (refund) q.credit.run(tx.amount, tx.sender_wallet_id);
    const reason =
      tx.type === 'TRANSFER'
        ? 'Payment could not be completed. The held funds were returned to your balance (simulated).'
        : 'Deposit was reversed by the bank (simulated).';
    q.markFailed.run(reason, ts, ts, refund ? ts : null, txId);
  });
}

export function startSettlementWorker(intervalMs = 3000) {
  const run = () => {
    for (const { id } of q.dueSettlements.all(nowIso())) {
      try {
        settle(id);
      } catch (err) {
        console.error('[settlement] failed to settle tx', id, err);
      }
    }
  };
  run(); // catch up on anything that came due while the server was down
  const timer = setInterval(run, intervalMs);
  timer.unref();
}

// ---- Money requests between FastPay users ---------------------------------------
// A request is only a note asking for money; nothing moves until the payer pays it.
// Paying creates a normal TRANSFER (from balance, or via PayPal) linked by request_id.

const requestRef = () => newReference().replace(/^FP-/, 'RQ-');

export function createInAppRequest({ requesterId, payerId, amount, note }) {
  if (requesterId === payerId) throw new HttpError(400, 'You cannot request money from yourself.');
  const w = getWallet(requesterId);
  const ts = nowIso();
  const reference = requestRef();
  q.insertRequest.run(reference, requesterId, payerId, amount, w.currency, note || null, ts, ts);
  return q.requestByRef.get(reference);
}

function requestFor(reference, userId, role) {
  const r = q.requestByRef.get(reference);
  const ok = r && (role === 'payer' ? r.payer_id === userId : r.requester_id === userId);
  if (!ok) throw new HttpError(404, 'Request not found.');
  return r;
}

export const getRequestAsPayer = (reference, userId) => requestFor(reference, userId, 'payer');

/** Pay an incoming request from the FastPay balance. Debit, credit and "paid" happen together. */
export function payRequestFromBalance(reference, payerId) {
  const txId = inTransaction(() => {
    const r = requestFor(reference, payerId, 'payer');
    if (r.status !== 'PENDING') throw new HttpError(409, `This request is already ${r.status.toLowerCase()}.`);
    const from = getWallet(payerId);
    const to = getWallet(r.requester_id);
    if (q.debit.run(r.amount, from.id, r.amount).changes !== 1) {
      throw new HttpError(422, 'Insufficient funds. Add money or pay with PayPal instead.');
    }
    q.credit.run(r.amount, to.id);
    const id = insertTransaction({
      type: 'TRANSFER',
      status: 'SUCCESS',
      amount: r.amount,
      currency: r.currency,
      sender_wallet_id: from.id,
      receiver_wallet_id: to.id,
      note: r.note,
      provider: 'FASTPAY',
      initiated_by: payerId,
      debited: true,
      credited: true,
      request_id: r.id,
    });
    q.markRequestPaid.run(q.rawTx.get(id).reference, nowIso(), r.id);
    return id;
  });
  return serialize(q.txById.get(txId), getWallet(payerId).id);
}

export function declineRequest(reference, payerId) {
  const r = requestFor(reference, payerId, 'payer');
  if (r.status !== 'PENDING') throw new HttpError(409, `This request is already ${r.status.toLowerCase()}.`);
  q.setRequestStatus.run('DECLINED', nowIso(), r.id);
}

export function cancelInAppRequest(reference, requesterId) {
  const r = requestFor(reference, requesterId, 'requester');
  if (r.status !== 'PENDING') throw new HttpError(409, `This request is already ${r.status.toLowerCase()}.`);
  q.setRequestStatus.run('CANCELLED', nowIso(), r.id);
}

const INVOICE_STATUS = { PENDING: 'PENDING', SUCCESS: 'PAID', FAILED: 'CANCELLED' };

/** Everything I've been asked to pay, and everything I've asked others for, in one shape. */
export function listRequests(user) {
  const incoming = [
    ...q.incomingRequests.all(user.id).map((r) => ({
      reference: r.reference, kind: 'FASTPAY', status: r.status, amount: r.amount, currency: r.currency, note: r.note,
      created_at: r.created_at, paid_reference: r.paid_reference,
      requester: { name: r.requester_name, account_id: r.requester_account_id },
    })),
    ...q.invoicesToMe.all(user.email, user.id).map((t) => ({
      reference: t.reference, kind: 'INVOICE', status: INVOICE_STATUS[t.status], amount: t.amount, currency: t.currency, note: t.note,
      created_at: t.created_at, payment_url: t.payment_url,
      requester: { name: t.requester_name, account_id: t.requester_account_id },
    })),
  ];
  const outgoing = [
    ...q.outgoingRequests.all(user.id).map((r) => ({
      reference: r.reference, kind: 'FASTPAY', status: r.status, amount: r.amount, currency: r.currency, note: r.note,
      created_at: r.created_at, paid_reference: r.paid_reference,
      payer: { name: r.payer_name, account_id: r.payer_account_id, email: r.payer_email },
    })),
    ...q.invoicesFromMe.all(user.id).map((t) => ({
      reference: t.reference, kind: 'INVOICE', status: INVOICE_STATUS[t.status], amount: t.amount, currency: t.currency, note: t.note,
      created_at: t.created_at, payment_url: t.payment_url, failure_reason: t.failure_reason,
      payer: { name: t.external_account, email: t.external_account },
    })),
  ];
  // Open requests first, then newest first.
  incoming.sort((a, b) => (b.status === 'PENDING') - (a.status === 'PENDING') || b.created_at.localeCompare(a.created_at));
  outgoing.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { incoming, outgoing };
}

export const countIncomingRequests = (user) => q.countIncoming.get(user.id, user.email, user.id).n;

// ---- Resolutions (Module 3) ---------------------------------------------------------
// Called only by the resolution window (routes/resolution.js), after Module 3's policy and approval
// checks. Each function re-checks the payment's legs itself, in one database transaction, and
// refuses (409) if the money has already moved: FastPay never trusts the caller about the state.
// They post normal ledger legs (credited_at / reversed_at, or a correcting transfer), so the balance
// reconciliation and the investigation see the result like any other payment.

const rq = {
  walletOwner: db.prepare('SELECT user_id FROM wallets WHERE id = ?'),
  // Money returned after a payment was already marked FAILED (a failed payout or credit, never returned).
  returnFailed: db.prepare(`UPDATE transactions SET reversed_at = ?, updated_at = ?, failure_reason = ?
                            WHERE id = ? AND status = 'FAILED' AND credited_at IS NULL AND reversed_at IS NULL`),
  // A stuck payment closed by giving the money back.
  returnPending: db.prepare(`UPDATE transactions SET status = 'FAILED', failure_reason = ?, updated_at = ?, completed_at = ?, reversed_at = ?,
                             settle_at = NULL, scheduled_outcome = NULL
                             WHERE id = ? AND status = 'PENDING' AND credited_at IS NULL AND reversed_at IS NULL`),
};

const conflict = (msg) => new HttpError(409, msg);
const paidFromWallet = (tx) => !(tx.type === 'TRANSFER' && tx.provider === 'PAYPAL');

/** Post the missing credit of a stuck payment (the money was taken; the credit leg never happened). */
export function resolveCredit(txId) {
  inTransaction(() => {
    const tx = q.rawTx.get(txId);
    if (!tx || !tx.receiver_wallet_id) throw conflict('This payment has no wallet to credit.');
    if (tx.status !== 'PENDING' || !tx.debited_at || tx.credited_at || tx.reversed_at) throw conflict('This payment is not waiting for its credit.');
    q.credit.run(tx.amount, tx.receiver_wallet_id);
    const ts = nowIso();
    if (q.markSuccess.run(ts, ts, ts, txId).changes !== 1) throw conflict('This payment changed while it was being resolved.');
    if (tx.request_id) q.markRequestPaid.run(tx.reference, ts, tx.request_id);
  });
  return q.rawTx.get(txId);
}

/** Give the money back to the payer's FastPay balance (stuck, or failed and never returned). */
export function resolveReturn(txId, note = 'Returned to your balance by FastPay support.') {
  inTransaction(() => {
    const tx = q.rawTx.get(txId);
    if (!tx || !tx.sender_wallet_id || !paidFromWallet(tx)) throw conflict('This payment was not paid from a FastPay balance.');
    if (!tx.debited_at || tx.credited_at || tx.reversed_at) throw conflict('This money was already delivered or returned.');
    const ts = nowIso();
    const stmt = tx.status === 'PENDING' ? rq.returnPending : tx.status === 'FAILED' ? rq.returnFailed : null;
    if (!stmt) throw conflict('This payment cannot be returned.');
    q.credit.run(tx.amount, tx.sender_wallet_id);
    const changed = tx.status === 'PENDING' ? stmt.run(note, ts, ts, ts, txId) : stmt.run(ts, ts, note, txId);
    if (changed.changes !== 1) throw conflict('This payment changed while it was being resolved.');
  });
  return q.rawTx.get(txId);
}

/** A PayPal-funded transfer whose capture PayPal has refunded: close it as returned. */
export function resolvePaypalRefunded(txId, refundId) {
  inTransaction(() => {
    const tx = q.rawTx.get(txId);
    if (!tx || tx.type !== 'TRANSFER' || tx.provider !== 'PAYPAL') throw conflict('This is not a PayPal-funded transfer.');
    if (tx.status !== 'PENDING' || tx.credited_at || tx.reversed_at) throw conflict('This payment was already delivered or returned.');
    const ts = nowIso();
    rq.returnPending.run(`Refunded to your PayPal by FastPay support (PayPal refund ${refundId}).`, ts, ts, ts, txId);
  });
  return q.rawTx.get(txId);
}

/**
 * The same payment went through twice: send the duplicate back from the recipient to the payer as a
 * correcting transfer. Refused if the recipient no longer holds the money (staff then follow up).
 */
export function resolveDuplicate(txId, idempotencyKey) {
  const out = inTransaction(() => {
    const tx = q.rawTx.get(txId);
    if (!tx || tx.type !== 'TRANSFER' || tx.provider !== 'FASTPAY' || tx.status !== 'SUCCESS' || !tx.credited_at) throw conflict('This is not a completed balance transfer.');
    const owner = rq.walletOwner.get(tx.receiver_wallet_id);
    const existing = q.txByIdempotency.get(owner.user_id, idempotencyKey);
    if (existing) return existing.id;
    if (q.debit.run(tx.amount, tx.receiver_wallet_id, tx.amount).changes !== 1) throw conflict("The recipient's balance no longer covers the duplicate.");
    q.credit.run(tx.amount, tx.sender_wallet_id);
    return insertTransaction({
      type: 'TRANSFER', status: 'SUCCESS', amount: tx.amount, currency: tx.currency,
      sender_wallet_id: tx.receiver_wallet_id, receiver_wallet_id: tx.sender_wallet_id,
      note: `Duplicate payment ${tx.reference} returned by FastPay support`, provider: 'FASTPAY',
      initiated_by: owner.user_id, idempotency_key: idempotencyKey, debited: true, credited: true,
    });
  });
  return q.rawTx.get(out);
}
