// Keeps FastPay in step with PayPal.
//
// The same sync functions are triggered three ways:
//   1. directly, right after the user approves a payment in the browser
//   2. by a verified PayPal webhook (instant)
//   3. by background polling (fallback, in case a webhook is missed or not configured)
// Each one re-reads the object from PayPal's API rather than trusting the webhook payload,
// and every ledger update is idempotent, so running them more than once is harmless.
import { config, paypalEnabled } from './config.js';
import * as ledger from './ledger.js';
import * as paypal from './paypal.js';
import { formatCents } from './util.js';

// ---- Checkout orders (Add money, Send with PayPal) ---------------------------

/** Read the capture result from an order / capture response and record it on the transaction. */
function recordCapture(tx, orderData, { simulate } = {}) {
  const capture = orderData?.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) return false;
  const amountMatches = capture.amount?.value === formatCents(tx.amount) && capture.amount?.currency_code === tx.currency;

  if (capture.status === 'COMPLETED' && amountMatches) {
    ledger.completePaypalOrder(tx.id, {
      success: simulate !== 'credit_fail',
      stuck: simulate === 'credit_fail' && tx.type === 'TRANSFER',
      captureId: capture.id,
    });
  } else if (capture.status === 'PENDING') {
    // PayPal is holding the funds (e.g. eCheck or review). The PAYMENT.CAPTURE.COMPLETED webhook will settle it.
  } else {
    const reason = !amountMatches ? 'Captured amount did not match the order.' : `PayPal capture status: ${capture.status}.`;
    ledger.completePaypalOrder(tx.id, { success: false, failureReason: reason, captureId: capture.id });
  }
  return true;
}

/** Capture an approved order and record the result. Used by the browser flow and by background sync. */
export async function captureAndRecord(tx, { simulate } = {}) {
  const { ok, status, data } = await paypal.captureOrder(tx.provider_ref, { mockDecline: simulate === 'fail' });
  if (ok) {
    recordCapture(tx, data, { simulate });
    return;
  }
  const issue = data?.details?.[0]?.issue || data?.name || `HTTP_${status}`;
  if (issue === 'ORDER_ALREADY_CAPTURED') {
    // Captured elsewhere (webhook / another tab); read the real outcome instead of failing.
    await syncOrder(tx, { allowCapture: false });
    return;
  }
  console.warn('[paypal] capture failed', tx.provider_ref, issue);
  const reason =
    issue === 'INSTRUMENT_DECLINED'
      ? 'PayPal declined the payment method (INSTRUMENT_DECLINED). You were not charged.'
      : `PayPal could not complete the payment (${issue}). You were not charged.`;
  ledger.completePaypalOrder(tx.id, { success: false, failureReason: reason });
}

const ABANDON_AFTER_MS = 3 * 60 * 60 * 1000; // 3 hours

/** Bring one pending PayPal order up to date. */
export async function syncOrder(tx, { allowCapture = true } = {}) {
  if (!tx || tx.status !== 'PENDING' || tx.scheduled_outcome === 'STUCK') return;
  const { ok, status, data } = await paypal.getOrder(tx.provider_ref);
  if (!ok) {
    if (status === 404) ledger.completePaypalOrder(tx.id, { success: false, failureReason: 'PayPal has no record of this checkout.' });
    return;
  }
  if (data.status === 'COMPLETED') {
    recordCapture(tx, data);
  } else if (data.status === 'APPROVED' && allowCapture) {
    // The payer approved but the browser never confirmed (closed the tab, lost connection). Finish it for them.
    await captureAndRecord(tx);
  } else if (data.status === 'VOIDED') {
    ledger.completePaypalOrder(tx.id, { success: false, failureReason: 'The PayPal checkout was voided. You were not charged.' });
  } else if (Date.now() - new Date(tx.created_at).getTime() > ABANDON_AFTER_MS) {
    ledger.completePaypalOrder(tx.id, { success: false, failureReason: 'PayPal checkout was not completed. You were not charged.' });
  }
}

// ---- Payouts (Cash out) -------------------------------------------------------

const PAYOUT_FAILED = {
  FAILED: 'PayPal could not complete the payout.',
  RETURNED: 'PayPal returned the payout.',
  BLOCKED: 'PayPal blocked the payout.',
  DENIED: 'PayPal denied the payout.',
  REFUNDED: 'PayPal refunded the payout.',
  REVERSED: 'PayPal reversed the payout.',
};

export async function syncPayout(tx) {
  if (!tx || tx.type !== 'WITHDRAWAL' || tx.status !== 'PENDING') return;
  const { ok, data } = await paypal.getPayout(tx.provider_ref);
  if (!ok) return;
  const item = data.items?.[0];
  const itemStatus = item?.transaction_status;
  if (itemStatus === 'SUCCESS') {
    ledger.completeWithdrawal(tx.id);
  } else if (PAYOUT_FAILED[itemStatus]) {
    const detail = item?.errors?.message ? ` ${item.errors.message}` : '';
    ledger.failWithdrawal(tx.id, `${PAYOUT_FAILED[itemStatus]}${detail}`);
  } else if (data.batch_header?.batch_status === 'DENIED') {
    ledger.failWithdrawal(tx.id, 'PayPal denied the payout batch.');
  }
  // PENDING / UNCLAIMED / ONHOLD: keep waiting. UNCLAIMED = the email has no PayPal account yet.
}

// ---- Invoices (Request money) ---------------------------------------------------

export async function syncInvoice(tx) {
  if (!tx || tx.provider !== 'PAYPAL_INVOICE' || tx.status !== 'PENDING') return;
  const { ok, data } = await paypal.getInvoice(tx.provider_ref);
  if (!ok) return;
  if (data.status === 'PAID') {
    const paid = data.payments?.paid_amount?.value ?? data.amount?.value;
    if (paid === formatCents(tx.amount)) ledger.completeRequest(tx.id);
    else console.warn('[invoicing] paid amount mismatch', tx.reference, paid);
  } else if (data.status === 'CANCELLED') {
    ledger.closeRequest(tx.id, 'The request was cancelled.');
  } else if (['REFUNDED', 'MARKED_AS_REFUNDED'].includes(data.status)) {
    ledger.closeRequest(tx.id, 'The invoice was refunded by PayPal.');
  }
  // SENT / UNPAID / PAYMENT_PENDING / PARTIALLY_PAID: keep waiting.
}

// ---- Disputes -----------------------------------------------------------------------

export async function syncDispute(disputeId) {
  const { ok, data } = await paypal.getDispute(disputeId);
  if (!ok) return;
  const captureId = data.disputed_transactions?.[0]?.seller_transaction_id;
  const tx = ledger.findByCaptureId(captureId);
  const value = data.dispute_amount?.value;
  ledger.recordDispute({
    id: data.dispute_id,
    transactionId: tx?.id,
    reason: data.reason,
    status: data.status,
    outcome: data.dispute_outcome?.outcome_code,
    amount: value ? Math.round(Number(value) * 100) : null,
    currency: data.dispute_amount?.currency_code,
    createdAt: data.create_time,
  });
  if (!tx) console.warn('[disputes] no FastPay transaction for capture', captureId);
}

// ---- Webhook routing ---------------------------------------------------------------------

/** Route a verified webhook event to the right sync. Returns the resource id it acted on. */
export async function handleWebhookEvent(event) {
  const type = event.event_type ?? '';
  const r = event.resource ?? {};

  if (type.startsWith('PAYMENT.CAPTURE.')) {
    const orderId = r.supplementary_data?.related_ids?.order_id;
    const tx = ledger.findByProviderRef(orderId) ?? ledger.findByCaptureId(r.id);
    // Webhooks never auto-capture: the browser may be capturing at this very moment.
    await syncOrder(tx, { allowCapture: false });
    return orderId ?? r.id;
  }
  if (type.startsWith('PAYMENT.PAYOUTS-ITEM.') || type.startsWith('PAYMENT.PAYOUTSBATCH.')) {
    const batchId = r.payout_batch_id ?? r.batch_header?.payout_batch_id;
    await syncPayout(ledger.findByProviderRef(batchId));
    return batchId;
  }
  if (type.startsWith('INVOICING.INVOICE.')) {
    const invoiceId = r.invoice?.id ?? r.id;
    await syncInvoice(ledger.findByProviderRef(invoiceId));
    return invoiceId;
  }
  if (type.startsWith('CUSTOMER.DISPUTE.')) {
    await syncDispute(r.dispute_id);
    return r.dispute_id;
  }
  return null; // event type we don't use
}

// ---- Background polling (fallback) -------------------------------------------------

async function runAll(label, items, fn) {
  for (const tx of items) {
    try {
      await fn(tx);
    } catch (err) {
      console.error(`[paypal-sync] ${label} ${tx.reference}:`, err.message);
    }
  }
}

export function startPaypalSync() {
  if (!paypalEnabled) return;
  // With webhooks configured, polling is only a safety net, so it can run less often.
  const slow = config.paypal.webhookId ? 4 : 1;
  const every = (ms, fn) => { fn(); setInterval(fn, ms * slow).unref(); };

  every(15_000, () => runAll('payout', ledger.pendingPayouts(), syncPayout));
  every(30_000, () => runAll('invoice', ledger.openRequests(), syncInvoice));
  every(60_000, () => runAll('order', ledger.staleOrders(2), (tx) => syncOrder(tx)));
}
