import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { config, paypalEnabled } from '../config.js';
import { HttpError, parseAmount, parseSimulation } from '../util.js';
import * as ledger from '../ledger.js';
import * as paypal from '../paypal.js';
import { captureAndRecord, syncInvoice } from '../paypalSync.js';

const router = Router();

// ---- Users -----------------------------------------------------------------

const findByHandle = db.prepare(
  'SELECT id, account_id, name, email FROM users WHERE email = ? COLLATE NOCASE OR account_id = ?',
);

function lookupRecipient(handle, selfId) {
  const h = String(handle ?? '').trim();
  if (!h) throw new HttpError(400, 'Enter an email address or FastPay account ID.');
  const user = findByHandle.get(h.toLowerCase(), h.toUpperCase());
  if (!user) throw new HttpError(404, 'No FastPay user found with that email or account ID.');
  if (selfId && user.id === selfId) throw new HttpError(400, 'That is your own account.');
  return user;
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
}

router.get('/users/lookup', (req, res) => {
  const user = lookupRecipient(req.query.q, req.user.id);
  res.json({ recipient: { name: user.name, account_id: user.account_id, email: maskEmail(user.email) } });
});

router.patch('/users/me', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (name.length < 2 || name.length > 80) throw new HttpError(400, 'Please enter your full name.');
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  res.json({ user: { ...req.user, name } });
});

// ---- Wallet ----------------------------------------------------------------

router.get('/wallet', (req, res) => {
  res.json({ wallet: ledger.walletSummary(req.user.id) });
});

router.get('/wallet/stats', (req, res) => {
  res.json({ stats: ledger.walletStats(req.user.id) });
});

// ---- Transfers funded by FastPay balance -----------------------------------

router.post('/transfers', (req, res) => {
  const recipient = lookupRecipient(req.body?.recipient, req.user.id);
  const amount = parseAmount(req.body?.amount);
  const note = String(req.body?.note ?? '').trim().slice(0, 140);
  const simulate = parseSimulation(req.body?.simulate);
  const idempotencyKey = String(req.get('Idempotency-Key') ?? '').slice(0, 64) || null;

  const transaction = ledger.transfer({
    senderUserId: req.user.id,
    recipientUserId: recipient.id,
    amount,
    note,
    simulate,
    idempotencyKey,
  });
  res.status(201).json({ transaction });
});

// ---- Transactions ----------------------------------------------------------

router.get('/transactions', (req, res) => {
  const { filter, status, limit, offset } = req.query;
  res.json(ledger.listTransactions(req.user.id, { filter, status, limit, offset }));
});

router.get('/transactions/:reference', (req, res) => {
  res.json({ transaction: ledger.getTransactionForUser(req.params.reference, req.user.id) });
});

// ---- Test deposits ---------------------------------------------------------

router.post('/deposits/simulated', (req, res) => {
  if (!config.simulationEnabled) throw new HttpError(403, 'Simulated deposits are disabled.');
  const amount = parseAmount(req.body?.amount);
  const simulate = parseSimulation(req.body?.simulate);
  res.status(201).json({ transaction: ledger.simulatedDeposit({ userId: req.user.id, amount, simulate }) });
});

// ---- PayPal ----------------------------------------------------------------

function requirePaypal() {
  if (!paypalEnabled) throw new HttpError(503, 'PayPal is not connected yet. Add your PayPal keys to server/.env.');
}

async function createPaypalOrder(req, res, { recipientUserId, description, note, requestId }) {
  requirePaypal();
  const amount = parseAmount(req.body?.amount);
  const order = await paypal.createOrder({
    amountCents: amount,
    currency: config.currency,
    requestId: crypto.randomUUID(),
    description,
  });
  const tx = ledger.createPendingPaypalOrder({ userId: req.user.id, amount, orderId: order.id, recipientUserId, note, requestId });
  res.status(201).json({ orderId: order.id, reference: tx.reference });
}

// Add money: PayPal -> my FastPay wallet
router.post('/deposits/paypal/orders', (req, res) =>
  createPaypalOrder(req, res, { description: 'FastPay wallet top-up' }),
);

// Send money: PayPal -> another user's FastPay wallet
router.post('/transfers/paypal/orders', (req, res) => {
  const recipient = lookupRecipient(req.body?.recipient, req.user.id);
  const note = String(req.body?.note ?? '').trim().slice(0, 140);
  return createPaypalOrder(req, res, {
    recipientUserId: recipient.id,
    description: `FastPay payment to ${recipient.name}`,
    note,
  });
});

// Capture an approved order (shared by deposits and transfers).
router.post('/paypal/orders/:orderId/capture', async (req, res) => {
  requirePaypal();
  const tx = ledger.findPaypalOrder(req.params.orderId, req.user.id);
  if (tx.status === 'PENDING' && tx.scheduled_outcome !== 'STUCK') {
    await captureAndRecord(tx, { simulate: parseSimulation(req.body?.simulate) });
  }
  res.json({ transaction: ledger.serializeById(tx.id) });
});

router.post('/paypal/orders/:orderId/cancel', (req, res) => {
  requirePaypal();
  const tx = ledger.findPaypalOrder(req.params.orderId, req.user.id);
  const transaction = ledger.completePaypalOrder(tx.id, {
    success: false,
    failureReason: 'Checkout was cancelled at PayPal. You were not charged.',
  });
  res.json({ transaction });
});

// Cash out: my FastPay wallet -> a PayPal account (Payouts)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/withdrawals/paypal', async (req, res) => {
  requirePaypal();
  const amount = parseAmount(req.body?.amount);
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter the email address of the PayPal account.');
  const idempotencyKey = String(req.get('Idempotency-Key') ?? '').slice(0, 64) || null;

  const tx = ledger.createWithdrawal({ userId: req.user.id, amount, email, idempotencyKey });
  if (tx.status !== 'PENDING' || tx.provider_ref) {
    return res.status(201).json({ transaction: ledger.serializeById(tx.id) });
  }

  let result;
  try {
    result = await paypal.createPayout({ amountCents: amount, currency: tx.currency, email, reference: tx.reference });
  } catch (err) {
    ledger.failWithdrawal(tx.id, 'Could not reach PayPal.');
    throw err;
  }

  if (!result.ok) {
    const issue = result.data?.name || result.data?.details?.[0]?.issue || `HTTP_${result.status}`;
    console.warn('[paypal] payout failed', tx.reference, issue, JSON.stringify(result.data));
    const reason =
      issue === 'INSUFFICIENT_FUNDS'
        ? 'The FastPay PayPal business account does not have enough funds for payouts.'
        : issue === 'AUTHORIZATION_ERROR' || issue === 'PERMISSION_DENIED' || result.status === 403
          ? 'Payouts are not enabled for this PayPal app. Turn on "Payouts" in the PayPal developer dashboard.'
          : `PayPal rejected the payout (${issue}).`;
    ledger.failWithdrawal(tx.id, reason);
  } else {
    ledger.attachPayout(tx.id, result.data.batch_header.payout_batch_id);
  }
  res.status(201).json({ transaction: ledger.serializeById(tx.id) });
});

// ---- Requests --------------------------------------------------------------------
// One "Request money" entry point:
//   - the payer has a FastPay account  -> in-app request (shows in their app; they pay or decline)
//   - anyone else (by email)           -> PayPal invoice (PayPal emails them a payment link)

async function createInvoiceRequest(req, { payerEmail, amount, note }) {
  requirePaypal();
  const tx = ledger.createPaymentRequest({ userId: req.user.id, amount, payerEmail, note });
  const created = await paypal.createInvoice({
    reference: tx.reference,
    amountCents: amount,
    currency: tx.currency,
    payerEmail,
    requesterName: req.user.name,
    note,
  });
  if (!created.ok || !created.data?.id) {
    const issue = created.data?.details?.[0]?.issue || created.data?.name || `HTTP_${created.status}`;
    console.warn('[invoicing] create failed', tx.reference, issue, JSON.stringify(created.data));
    const reason =
      issue === 'NOT_AUTHORIZED'
        ? 'Invoicing is not enabled for this PayPal app.'
        : `PayPal could not create the invoice (${issue}).`;
    ledger.closeRequest(tx.id, reason);
    return { kind: 'INVOICE', transaction: ledger.serializeById(tx.id) };
  }

  const invoiceId = created.data.id;
  const sent = await paypal.sendInvoice(invoiceId, req.user.name);
  let url = sent.data?.links?.find((l) => l.rel === 'payer-view')?.href ?? sent.data?.href;
  if (!url) url = (await paypal.getInvoice(invoiceId)).data?.detail?.metadata?.recipient_view_url;
  ledger.attachInvoice(tx.id, invoiceId, url);

  if (!sent.ok) {
    const issue = sent.data?.details?.[0]?.issue || sent.data?.name || `HTTP_${sent.status}`;
    console.warn('[invoicing] send failed', tx.reference, issue);
    ledger.closeRequest(tx.id, `PayPal could not send the invoice (${issue}).`);
  }
  return { kind: 'INVOICE', transaction: ledger.serializeById(tx.id) };
}

router.post('/requests', async (req, res) => {
  const to = String(req.body?.to ?? req.body?.email ?? '').trim();
  if (!to) throw new HttpError(400, 'Enter an email address or FastPay account ID.');
  const amount = parseAmount(req.body?.amount);
  const note = String(req.body?.note ?? '').trim().slice(0, 500);

  const user = findByHandle.get(to.toLowerCase(), to.toUpperCase());
  if (user) {
    if (user.id === req.user.id) throw new HttpError(400, 'You cannot request money from yourself.');
    const r = ledger.createInAppRequest({ requesterId: req.user.id, payerId: user.id, amount, note });
    return res.status(201).json({ kind: 'FASTPAY', request: { reference: r.reference, amount: r.amount, currency: r.currency, payer: { name: user.name, account_id: user.account_id } } });
  }

  const payerEmail = to.toLowerCase();
  if (!EMAIL_RE.test(payerEmail)) throw new HttpError(404, 'No FastPay user has that account ID. To ask someone outside FastPay, enter their email.');
  if (payerEmail === req.user.email.toLowerCase()) throw new HttpError(400, 'You cannot request money from yourself.');
  if (!paypalEnabled) throw new HttpError(400, 'That email is not on FastPay. Connect PayPal to send them an invoice.');
  res.status(201).json(await createInvoiceRequest(req, { payerEmail, amount, note }));
});

// Kept for older clients: always sends a PayPal invoice.
router.post('/requests/paypal', async (req, res) => {
  const amount = parseAmount(req.body?.amount);
  const payerEmail = String(req.body?.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(payerEmail)) throw new HttpError(400, 'Enter the email address of the person who should pay.');
  if (payerEmail === req.user.email.toLowerCase()) throw new HttpError(400, 'You cannot request money from yourself.');
  const note = String(req.body?.note ?? '').trim().slice(0, 500);
  const { transaction } = await createInvoiceRequest(req, { payerEmail, amount, note });
  res.status(201).json({ transaction });
});

router.get('/requests', (req, res) => {
  res.json(ledger.listRequests(req.user));
});

router.get('/requests/count', (req, res) => {
  res.json({ incoming: ledger.countIncomingRequests(req.user) });
});

// Pay an in-app request from the FastPay balance.
router.post('/requests/:reference/pay', (req, res) => {
  res.json({ transaction: ledger.payRequestFromBalance(req.params.reference, req.user.id) });
});

// Pay an in-app request with PayPal: creates a PayPal order linked to the request.
router.post('/requests/:reference/paypal/orders', (req, res) => {
  const r = ledger.getRequestAsPayer(req.params.reference, req.user.id);
  if (r.status !== 'PENDING') throw new HttpError(409, `This request is already ${r.status.toLowerCase()}.`);
  req.body = { ...req.body, amount: (r.amount / 100).toFixed(2) };
  return createPaypalOrder(req, res, {
    recipientUserId: r.requester_id,
    description: 'FastPay payment request',
    note: r.note,
    requestId: r.id,
  });
});

router.post('/requests/:reference/decline', (req, res) => {
  ledger.declineRequest(req.params.reference, req.user.id);
  res.json({ ok: true });
});

// Cancel a request I sent: in-app requests (RQ-…) or PayPal invoices (FP-…).
router.post('/requests/:reference/cancel', async (req, res) => {
  if (req.params.reference.startsWith('RQ-')) {
    ledger.cancelInAppRequest(req.params.reference, req.user.id);
    return res.json({ ok: true });
  }
  requirePaypal();
  const tx = ledger.getRequestForOwner(req.params.reference, req.user.id);
  if (tx.status !== 'PENDING') throw new HttpError(409, 'This request is already closed.');
  const { ok, status, data } = await paypal.cancelInvoice(tx.provider_ref);
  if (!ok && status !== 422) {
    console.warn('[invoicing] cancel failed', tx.reference, JSON.stringify(data));
    throw new HttpError(502, 'PayPal could not cancel the invoice. Please try again.');
  }
  await syncInvoice(tx); // picks up PAID if they paid just before we cancelled
  ledger.closeRequest(tx.id, 'You cancelled this request.');
  res.json({ ok: true, transaction: ledger.serializeById(tx.id) });
});

export default router;
