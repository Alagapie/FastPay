// Every scenario is created with FastPay's own ledger code (in a temp database), then investigated
// through FastPay's real read-only investigation window, as the complaining customer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { investigateTransaction } from '../src/investigate/engine.js';
import { createFixture, paypalCapture, paypalOrder, paypalPayout, minutesFromNow } from './helpers/fixture.js';

const TZ = 'Africa/Lagos';
let fx, me, musa;

before(async () => {
  fx = await createFixture();
  me = fx.addUser('Abdul Ishaq', 'abdul@test.dev');
  musa = fx.addUser('Musa Ibrahim', 'musa@test.dev');
  fx.fund(me, 100_000); // $1,000
});
after(() => fx.close());

async function investigate(reference, { now = new Date(), complaint = { complaint_type: 'RECIPIENT_NOT_CREDITED' }, viewer = me } = {}) {
  const customer = await fx.login(viewer); // exactly what the module gets: a customer limited to their own records
  return investigateTransaction({
    tx: await customer.api.transaction(reference),
    viewerWalletId: customer.wallet.id,
    viewerUserId: customer.id,
    complaint,
    fastpay: customer.api,
    paypal: customer.api.paypal,
    now,
    timezone: TZ,
    processingWindowMinutes: 10,
  });
}

const send = (amount, simulate, to = musa, from = me) =>
  fx.ledger.transfer({ senderUserId: from.id, recipientUserId: to.id, amount, simulate }).reference;
const answer = (r, startsWith) => r.checks.find((c) => c.question.startsWith(startsWith))?.answer;

// ---- Internal transfers -------------------------------------------------------------

test('internal transfer that completed', async () => {
  const r = await investigate(send(5000, 'success'));
  assert.equal(r.finding.code, 'PAYMENT_COMPLETED');
  assert.equal(r.kind, 'INTERNAL_TRANSFER');
  assert.equal(r.confidence, 'HIGH');
  assert.equal(answer(r, 'Was your FastPay balance debited'), 'YES');
  assert.equal(answer(r, "Has FastPay's wallet ledger recorded the credit to Musa Ibrahim's FastPay wallet"), 'YES');
  assert.equal(r.discrepancies.length, 0);
  assert.match(r.intro, /^You sent \$50\.00 to Musa Ibrahim from your FastPay balance/);
});

test('debited but not credited: still processing at first, then a confirmed problem', async () => {
  const ref = send(5000, 'credit_fail');
  const early = await investigate(ref);
  assert.equal(early.finding.code, 'PAYMENT_PENDING');

  const later = await investigate(ref, { now: minutesFromNow(30) });
  assert.equal(later.finding.code, 'DEBITED_NOT_CREDITED');
  assert.equal(later.amount_at_issue, 5000);
  assert.equal(answer(later, 'Was your FastPay balance debited'), 'YES');
  assert.equal(answer(later, "Has FastPay's wallet ledger recorded the credit to Musa Ibrahim's FastPay wallet"), 'NO');
  assert.equal(answer(later, 'Was the money returned'), 'NO');
  assert.equal(answer(later, 'Does your FastPay balance match'), 'YES'); // only YOUR wallet is checked
  assert.match(later.finding.explanation, /has not recorded the credit/);
  assert.deepEqual(later.money_trail.map((s) => s.state), ['done', 'done', 'missing']);
});

test('payment that failed instantly: nothing was taken', async () => {
  const r = await investigate(send(5000, 'fail'));
  assert.equal(r.finding.code, 'PAYMENT_FAILED');
  assert.equal(r.amount_at_issue, 0);
});

test('insufficient funds: nothing was taken', async () => {
  const r = await investigate(send(99_999_00, 'success'));
  assert.equal(r.finding.code, 'PAYMENT_FAILED');
});

test('pending payment that failed later and was refunded', async () => {
  const ref = send(2000, 'pending_fail');
  fx.db.prepare("UPDATE transactions SET settle_at = '2000-01-01T00:00:00.000Z' WHERE reference = ?").run(ref); // due now (test DB only)
  fx.ledger.startSettlementWorker(60_000); // FastPay's own worker settles it immediately
  const r = await investigate(ref, { now: minutesFromNow(30) });
  assert.equal(r.finding.code, 'PAYMENT_REFUNDED');
  assert.equal(answer(r, 'Was the money returned'), 'YES');
});

test('the investigation never sees FastPay test-mode labels', async () => {
  const tx = await (await fx.login(me)).api.transaction(send(100, 'credit_fail'));
  for (const hidden of ['scheduled_outcome', 'settle_at', 'failure_reason', 'idempotency_key']) assert.equal(hidden in tx, false, hidden);
});

// ---- Payments with PayPal ---------------------------------------------------------------

function paypalTransfer({ orderId, amount = 5000, outcome = 'success', captureId = `CAP-${orderId}`, to = musa }) {
  const row = fx.ledger.createPendingPaypalOrder({ userId: me.id, amount, orderId, recipientUserId: to?.id });
  if (outcome === 'success') fx.ledger.completePaypalOrder(row.id, { success: true, captureId });
  if (outcome === 'stuck') fx.ledger.completePaypalOrder(row.id, { stuck: true, captureId });
  return row.reference;
}

/** Tell the fake PayPal what to answer for these paths. FastPay (not this module) will ask it. */
function registerPayPal(routes) {
  Object.assign(fx.paypal.routes, routes);
  return { calls: fx.paypal.calls };
}

const paypalWith = (orderId, captureId, opts = {}) =>
  registerPayPal({
    [`/v2/checkout/orders/${orderId}`]: { body: paypalOrder(orderId, { captureId, ...opts }) },
    ...(captureId ? { [`/v2/payments/captures/${captureId}`]: { body: paypalCapture(captureId, opts) } } : {}),
  });

test('PayPal charged the payer but the recipient was never credited', async () => {
  const ref = paypalTransfer({ orderId: 'ORDER-STUCK', outcome: 'stuck' });
  const pp = paypalWith('ORDER-STUCK', 'CAP-ORDER-STUCK');
  const r = await investigate(ref, { now: minutesFromNow(30) });
  assert.equal(r.finding.code, 'PAYMENT_CAPTURED_WALLET_NOT_CREDITED');
  assert.equal(r.kind, 'PAYPAL_TRANSFER');
  assert.equal(r.confidence, 'HIGH');
  assert.equal(answer(r, 'What status did PayPal return'), 'COMPLETED');
  assert.equal(answer(r, 'Do the amount and currency PayPal charged match'), 'YES');
  assert.equal(answer(r, "Has FastPay's wallet ledger recorded the credit to Musa Ibrahim's FastPay wallet"), 'NO');
  const sources = r.evidence.map((e) => e.source);
  assert.ok(sources.includes('PAYPAL_ORDERS') && sources.includes('PAYPAL_PAYMENTS'));
  assert.equal(r.evidence.find((e) => e.source === 'PAYPAL_ORDERS').paypal_debug_id, 'dbg-test-123');
  // Read-only: apart from the OAuth sign-in, it only ever sent GET requests.
  assert.ok(pp.calls.length > 0 && pp.calls.every((c) => c.method === 'GET' || c.path === '/v1/oauth2/token'));
});

test('PayPal transfer that completed', async () => {
  const ref = paypalTransfer({ orderId: 'ORDER-OK' });
  paypalWith('ORDER-OK', 'CAP-ORDER-OK');
  const r = await investigate(ref);
  assert.equal(r.finding.code, 'PAYMENT_COMPLETED');
});

test('PayPal cannot be reached: inconclusive, not a guess', async () => {
  const ref = paypalTransfer({ orderId: 'ORDER-DOWN', outcome: 'stuck' });
  const pp = registerPayPal({ '/v2/checkout/orders/ORDER-DOWN': { throws: true } });
  const r = await investigate(ref, { now: minutesFromNow(30) });
  assert.equal(r.finding.code, 'INVESTIGATION_INCONCLUSIVE');
  assert.equal(r.confidence, 'LOW');
  assert.equal(answer(r, 'What status did PayPal return'), 'UNKNOWN');
});

test('PayPal charged, but FastPay never recorded the charge (lost capture response)', async () => {
  const ref = paypalTransfer({ orderId: 'ORDER-LOST', outcome: 'none' });
  paypalWith('ORDER-LOST', 'CAP-LOST');
  const r = await investigate(ref, { now: minutesFromNow(30) });
  assert.equal(r.finding.code, 'PAYMENT_CAPTURED_WALLET_NOT_CREDITED');
  assert.equal(r.facts.fastpay_recorded_charge, false);
  assert.ok(r.discrepancies.some((d) => d.code === 'FASTPAY_CHARGE_NOT_RECORDED'));
  assert.equal(r.amount_at_issue, 5000);
});

test('PayPal charged a different amount than FastPay recorded', async () => {
  const ref = paypalTransfer({ orderId: 'ORDER-AMT' });
  paypalWith('ORDER-AMT', 'CAP-ORDER-AMT', { value: '55.00' });
  const r = await investigate(ref);
  assert.equal(r.finding.code, 'INVESTIGATION_INCONCLUSIVE');
  assert.ok(r.discrepancies.some((d) => d.code === 'AMOUNT_MISMATCH'));
  assert.equal(r.amount_at_issue, 500);
});

test('PayPal refunded the charge', async () => {
  const ref = paypalTransfer({ orderId: 'ORDER-REF', outcome: 'stuck' });
  paypalWith('ORDER-REF', 'CAP-ORDER-REF', { status: 'REFUNDED' });
  const r = await investigate(ref, { now: minutesFromNow(30) });
  assert.equal(r.finding.code, 'PAYMENT_REFUNDED');
});

test('PayPal checkout approved but not captured: pending while FastPay can still finish it, then not charged', async () => {
  const ref = paypalTransfer({ orderId: 'ORDER-OPEN', outcome: 'none' });
  registerPayPal({ '/v2/checkout/orders/ORDER-OPEN': { body: paypalOrder('ORDER-OPEN', { orderStatus: 'APPROVED' }) } });
  const early = await investigate(ref, { now: minutesFromNow(30) });
  assert.equal(early.finding.code, 'PAYMENT_PENDING');
  assert.equal(early.pending.reason, 'AWAITING_CAPTURE');
  assert.match(early.pending.says, /PayPal has not taken the money yet/);
  const late = await investigate(ref, { now: minutesFromNow(200) }); // FastPay gives up after 3 hours
  assert.equal(late.finding.code, 'PAYMENT_FAILED');
});

test('add money with PayPal that completed', async () => {
  const ref = paypalTransfer({ orderId: 'ORDER-TOPUP', to: null });
  paypalWith('ORDER-TOPUP', 'CAP-ORDER-TOPUP');
  const r = await investigate(ref, { complaint: { complaint_type: 'TOP_UP_NOT_REFLECTED' } });
  assert.equal(r.kind, 'PAYPAL_TOP_UP');
  assert.equal(r.finding.code, 'PAYMENT_COMPLETED');
});

// ---- Cash out to PayPal ---------------------------------------------------------------

function cashOut(batchId, amount = 3000) {
  const row = fx.ledger.createWithdrawal({ userId: me.id, amount, email: 'me@paypal.test' });
  fx.ledger.attachPayout(row.id, batchId);
  return row;
}
const payoutApi = (batchId, opts) => registerPayPal({ [`/v1/payments/payouts/${batchId}`]: { body: paypalPayout(batchId, opts) } });
const cashComplaint = { complaint_type: 'CASH_OUT_NOT_RECEIVED' };

test('cash out that PayPal paid', async () => {
  const row = cashOut('BATCH-OK');
  fx.ledger.completeWithdrawal(row.id);
  payoutApi('BATCH-OK');
  const r = await investigate(row.reference, { complaint: cashComplaint });
  assert.equal(r.finding.code, 'PAYMENT_COMPLETED');
});

test('cash out that PayPal failed, with the money returned', async () => {
  const row = cashOut('BATCH-FAILED');
  fx.ledger.failWithdrawal(row.id, 'PayPal could not complete the payout.');
  payoutApi('BATCH-FAILED', { status: 'FAILED' });
  const r = await investigate(row.reference, { complaint: cashComplaint, now: minutesFromNow(30) });
  assert.equal(r.finding.code, 'PAYMENT_REFUNDED');
});

test('cash out that PayPal failed, but the money was never returned', async () => {
  const row = cashOut('BATCH-STUCK');
  payoutApi('BATCH-STUCK', { status: 'RETURNED' });
  const r = await investigate(row.reference, { complaint: cashComplaint, now: minutesFromNow(30) });
  assert.equal(r.finding.code, 'PAYOUT_FAILED');
  assert.equal(r.amount_at_issue, 3000);
});

test('cash out waiting to be claimed', async () => {
  const row = cashOut('BATCH-UNCLAIMED');
  payoutApi('BATCH-UNCLAIMED', { status: 'UNCLAIMED' });
  const r = await investigate(row.reference, { complaint: cashComplaint, now: minutesFromNow(30) });
  assert.equal(r.finding.code, 'PAYMENT_PENDING');
  assert.match(r.finding.explanation, /unclaimed/);
  assert.equal(r.pending.reason, 'PAYOUT_UNCLAIMED');
});

// ---- Payment request (PayPal invoice) --------------------------------------------------

test('payment request paid through PayPal and credited', async () => {
  const row = fx.ledger.createPaymentRequest({ userId: me.id, amount: 2500, payerEmail: 'friend@paypal.test' });
  fx.ledger.attachInvoice(row.id, 'INV2-TEST', 'https://paypal.test/invoice');
  fx.ledger.completeRequest(row.id);
  const money = { currency_code: 'USD', value: '25.00' };
  const pp = registerPayPal({
    '/v2/invoicing/invoices/INV2-TEST': {
      body: { id: 'INV2-TEST', status: 'PAID', amount: money, payments: { paid_amount: money, transactions: [{ payment_id: 'PAY-1', payment_date: '2026-11-12', amount: money }] } },
    },
  });
  const r = await investigate(row.reference, { complaint: { complaint_type: 'EXPECTED_MONEY_NOT_RECEIVED' } });
  assert.equal(r.kind, 'PAYPAL_REQUEST');
  assert.equal(r.finding.code, 'PAYMENT_COMPLETED');
});

// ---- Complaint-specific checks ------------------------------------------------------------

test('charged twice: two identical payments went through', async () => {
  const first = send(1500, 'success');
  send(1500, 'success');
  const r = await investigate(first, { complaint: { complaint_type: 'DUPLICATE_PAYMENT' } });
  assert.equal(r.finding.code, 'DUPLICATE_PAYMENT');
  assert.equal(r.amount_at_issue, 1500);
  assert.equal(r.related_references.length, 1);
});

test('charged twice: claim not supported when only one payment went through', async () => {
  const ref = send(1234, 'success');
  send(1234, 'fail'); // a failed retry moves no money
  const r = await investigate(ref, { complaint: { complaint_type: 'DUPLICATE_PAYMENT' } });
  assert.equal(r.finding.code, 'PAYMENT_COMPLETED');
  assert.equal(answer(r, 'Did an identical payment go through'), 'NO');
});

test('your own wallet off by exactly the payment amount makes the finding inconclusive', async () => {
  const a = fx.addUser('Tester One', 't1@test.dev');
  const b = fx.addUser('Tester Two', 't2@test.dev');
  fx.fund(a, 10_000);
  const ref = send(4000, 'credit_fail', b, a);
  fx.db.prepare('UPDATE wallets SET balance = balance + 4000 WHERE id = ?').run(a.wallet.id); // the money came back with no record (test DB only)
  const r = await investigate(ref, { viewer: a, now: minutesFromNow(30) });
  assert.equal(r.finding.code, 'INVESTIGATION_INCONCLUSIVE');
  assert.equal(r.discrepancies[0].code, 'WALLET_BALANCE_MISMATCH');
  assert.equal(answer(r, 'Does your FastPay balance match'), 'NO');
});

// ---- FastPay's receipt says "Successful", but the money never arrived ------------------

test('receipt shows Successful for a stuck payment, and the investigation still finds the problem', async () => {
  const ref = send(5000, 'credit_fail');
  const receipt = fx.ledger.getTransactionForUser(ref, me.id); // exactly what FastPay shows the payer
  assert.equal(receipt.status, 'SUCCESS');
  assert.equal(receipt.failure_reason, null);
  const r = await investigate(ref, { now: minutesFromNow(30) });
  assert.equal(r.finding.code, 'DEBITED_NOT_CREDITED');
});

test('receipt shows Successful for a stuck PayPal payment, and the investigation still finds the problem', async () => {
  const ref = paypalTransfer({ orderId: 'ORDER-RECEIPT', outcome: 'stuck' });
  assert.equal(fx.ledger.getTransactionForUser(ref, me.id).status, 'SUCCESS');
  paypalWith('ORDER-RECEIPT', 'CAP-ORDER-RECEIPT');
  const r = await investigate(ref, { now: minutesFromNow(30) });
  assert.equal(r.finding.code, 'PAYMENT_CAPTURED_WALLET_NOT_CREDITED');
});

test('receipt shows Refunded, and the investigation agrees the money came back', async () => {
  const ref = send(2100, 'pending_fail');
  fx.db.prepare("UPDATE transactions SET settle_at = '2000-01-01T00:00:00.000Z' WHERE reference = ?").run(ref);
  fx.ledger.startSettlementWorker(60_000);
  assert.equal(fx.ledger.getTransactionForUser(ref, me.id).status, 'REFUNDED');
  assert.equal((await investigate(ref, { now: minutesFromNow(30) })).finding.code, 'PAYMENT_REFUNDED');
});

// ---- Only the customer's own account is ever looked at -----------------------------------

test("the other person's wallet is never opened, and the report says what it can't see", async () => {
  const ref = send(4500, 'credit_fail');
  const r = await investigate(ref, { now: minutesFromNow(30) });
  assert.equal(r.finding.code, 'DEBITED_NOT_CREDITED');
  const wallets = r.evidence.filter((e) => e.source === 'FASTPAY_WALLETS');
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].label, 'Your FastPay wallet');
  assert.ok(!r.checks.some((c) => /Musa Ibrahim's (wallet balance|balance)/.test(c.question)));
  assert.ok(!JSON.stringify(r.evidence).includes('musa@test.dev'), "no recipient email in the evidence");
  assert.equal(r.destination.type, 'FASTPAY_WALLET');
  assert.match(r.limits[0], /does not open Musa Ibrahim's account/);
});

test('cash out: delivery is confirmed by PayPal, never by looking at the PayPal account', async () => {
  const row = cashOut('BATCH-LIMITS');
  fx.ledger.completeWithdrawal(row.id);
  payoutApi('BATCH-LIMITS');
  const r = await investigate(row.reference, { complaint: cashComplaint });
  assert.equal(r.destination.type, 'EXTERNAL_PAYPAL_ACCOUNT');
  assert.match(r.destination.confirmed_by, /PayPal's payout status/);
  assert.match(r.limits.join(' '), /cannot see the PayPal account/);
  assert.equal(r.facts.paypal_transaction_id, 'TX-BATCH-LIMITS');
});
