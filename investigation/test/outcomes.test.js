// The outcome rules: money charged, payment completed and recipient credited are three different facts.
// Each scenario is made with FastPay's real ledger, read through FastPay's real investigation window,
// with a fake PayPal answering, exactly as in production.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { investigateTransaction } from '../src/investigate/engine.js';
import { postResultIntent, smallTalk } from '../src/conversation.js';
import { createFixture, createService, paypalCapture, paypalOrder, minutesFromNow } from './helpers/fixture.js';

let fx, me, musa;
const C = {};

before(async () => {
  fx = await createFixture();
  me = fx.addUser('Abdul Ishaq', 'abdul@test.dev');
  musa = fx.addUser('Musty Bala', 'musty@test.dev');
  fx.fund(me, 100_000);
  C.me = await fx.login(me);
});
after(() => fx.close());

function paypalTransfer(orderId, outcome) {
  const row = fx.ledger.createPendingPaypalOrder({ userId: me.id, amount: 2500, orderId, recipientUserId: musa.id });
  if (outcome === 'success') fx.ledger.completePaypalOrder(row.id, { success: true, captureId: `CAP-${orderId}` });
  if (outcome === 'stuck') fx.ledger.completePaypalOrder(row.id, { stuck: true, captureId: `CAP-${orderId}` });
  return row.reference;
}

/** Tell the fake PayPal about an order and its capture. */
function paypalSays(orderId, { status = 'COMPLETED', reason, throws = false } = {}) {
  const capId = `CAP-${orderId}`;
  if (throws) {
    fx.paypal.routes[`/v2/checkout/orders/${orderId}`] = { throws: true };
    return;
  }
  const order = paypalOrder(orderId, { captureId: capId, status, value: '25.00' });
  order.purchase_units[0].description = 'FastPay payment to Musty Bala';
  const capture = paypalCapture(capId, { status, value: '25.00' });
  if (reason) {
    // PayPal puts the hold reason on the capture, both inside the order and on the capture itself.
    capture.status_details = { reason };
    order.purchase_units[0].payments.captures[0].status_details = { reason };
  }
  fx.paypal.routes[`/v2/checkout/orders/${orderId}`] = { body: order };
  fx.paypal.routes[`/v2/payments/captures/${capId}`] = { body: capture };
}

const investigate = async (reference, now = new Date()) =>
  investigateTransaction({
    tx: await C.me.api.transaction(reference),
    viewerWalletId: C.me.wallet.id,
    viewerUserId: C.me.id,
    complaint: { complaint_type: 'RECIPIENT_NOT_CREDITED' },
    fastpay: C.me.api,
    paypal: C.me.api.paypal,
    now,
    timezone: 'Africa/Lagos',
    processingWindowMinutes: 10,
  });

/** The whole case through the chat, so we see exactly what the customer sees. */
async function caseFor(reference, { now } = {}) {
  const svc = createService(now ? { now } : {});
  let c = await svc.service.openCase(C.me, 'I paid Musty $25 with PayPal today and he has not received it');
  assert.ok(c.candidates.some((x) => x.reference === reference), 'the payment is found');
  svc.service.confirm(C.me, c.id, reference);
  c = await svc.service.investigate(C.me, c.id);
  return { ...svc, c };
}

const stepStates = (v) => v.timeline.map((s) => `${s.label}: ${s.state_text || s.at_display}`);

// ---- The five scenarios ----------------------------------------------------------------

test('1. PayPal pending + no FastPay credit -> PAYMENT_PENDING, with the reason PayPal gave', async () => {
  const ref = paypalTransfer('OUT-PENDING', 'none');
  paypalSays('OUT-PENDING', { status: 'PENDING' });
  const r = await investigate(ref);
  assert.equal(r.finding.code, 'PAYMENT_PENDING');
  assert.equal(r.pending.reason, 'PAYPAL_CAPTURE_PENDING');
  assert.equal(r.pending.says, 'PayPal has not provided a final completion status');

  const { c } = await caseFor(ref);
  const v = c.result;
  assert.equal(v.headline, 'Pending');
  assert.equal(v.amount_display, '$25.00');
  assert.equal(v.status, 'Your payment is still being processed.');
  assert.equal(v.details[0], "PayPal has not provided a final completion status, and FastPay has not recorded the recipient's wallet credit.");
  assert.deepEqual(v.next_steps, [
    'Do not send the money again.',
    'Check the payment status again shortly.',
    'If it remains pending beyond the expected processing time, the case will be escalated.',
  ]);
  assert.deepEqual(v.timeline.map((s) => [s.label, s.state]), [
    ['Payment started', 'done'], ['Payment processing', 'pending'], ['Recipient wallet credit', 'missing'],
  ]);
  assert.equal(v.timeline[2].state_text, 'Not yet recorded');
  assert.equal(v.can_check_again, true);
});

test('1b. a PayPal hold reason is explained in plain words, only when PayPal gave it', async () => {
  const ref = paypalTransfer('OUT-REVIEW', 'none');
  paypalSays('OUT-REVIEW', { status: 'PENDING', reason: 'PENDING_REVIEW' });
  const r = await investigate(ref);
  assert.equal(r.finding.code, 'PAYMENT_PENDING');
  assert.equal(r.pending.paypal_reason, 'PENDING_REVIEW');
  assert.match(r.pending.says, /PayPal is reviewing the payment/);
});

test('2. PayPal completed + no FastPay credit -> PAYMENT_CAPTURED_WALLET_NOT_CREDITED, even minutes after', async () => {
  const ref = paypalTransfer('OUT-CAPTURED', 'stuck');
  paypalSays('OUT-CAPTURED');
  const r = await investigate(ref); // 0 minutes old: still not called "processing" once PayPal has completed
  assert.equal(r.finding.code, 'PAYMENT_CAPTURED_WALLET_NOT_CREDITED');
  assert.equal(r.amount_at_issue, 2500);
  const ask = (q) => r.checks.find((x) => x.question.startsWith(q))?.answer;
  assert.equal(ask('What status did PayPal return'), 'COMPLETED');
  assert.equal(ask("Did FastPay receive and accept PayPal's payment"), 'YES');
  assert.equal(ask("Has FastPay's wallet ledger recorded the credit"), 'NO');
  assert.equal(ask("Do PayPal's references match"), 'YES');
  assert.equal(ask('Do the amount and currency PayPal charged match'), 'YES');
  assert.equal(ask("Does the recipient on PayPal's order match"), 'YES');

  const { c, store } = await caseFor(ref);
  const v = c.result;
  assert.equal(v.status, "PayPal completed the payment, but FastPay has not yet recorded the recipient's wallet credit.");
  assert.deepEqual(v.timeline.map((s) => [s.label, s.state]), [
    ['Payment started', 'done'], ['PayPal payment completed', 'done'], ['Recipient wallet credit', 'missing'],
  ]);
  assert.equal(v.timeline[2].state_text, 'Not yet recorded');
  const all = JSON.stringify(v);
  assert.doesNotMatch(all, /Did not happen|failed|still being processed/i, 'a missing credit is not called a failure or "processing"');
  // An exception is opened for staff, with an owner and an escalation time.
  const exc = store.exception(c.id);
  assert.equal(exc.status, 'OPEN');
  assert.equal(exc.owner, 'Payments operations');
  assert.equal(exc.finding, 'PAYMENT_CAPTURED_WALLET_NOT_CREDITED');
  assert.ok(new Date(exc.escalate_at) > new Date(exc.opened_at));
});

test('3. PayPal completed + FastPay credited -> PAYMENT_COMPLETED', async () => {
  const ref = paypalTransfer('OUT-DONE', 'success');
  paypalSays('OUT-DONE');
  const r = await investigate(ref);
  assert.equal(r.finding.code, 'PAYMENT_COMPLETED');
  const { c, store } = await caseFor(ref);
  assert.equal(c.result.status, "The payment is complete, and Musty Bala's FastPay wallet has been credited.");
  assert.equal(store.exception(c.id), null, 'no exception for a completed payment');
});

test('4. PayPal completed + FastPay recorded the credit as failed -> PAYOUT_FAILED', async () => {
  const ref = paypalTransfer('OUT-PAYOUT', 'stuck');
  fx.db.prepare("UPDATE transactions SET status = 'FAILED' WHERE reference = ?").run(ref); // test DB only
  paypalSays('OUT-PAYOUT');
  const r = await investigate(ref);
  assert.equal(r.finding.code, 'PAYOUT_FAILED');
  assert.equal(r.amount_at_issue, 2500);
  assert.ok(r.checks.some((x) => x.question === 'Did FastPay record the wallet credit as failed?' && x.answer === 'YES'));
});

test('5. PayPal status unavailable + no FastPay credit -> INVESTIGATION_INCONCLUSIVE', async () => {
  const ref = paypalTransfer('OUT-DOWN', 'stuck');
  paypalSays('OUT-DOWN', { throws: true });
  const r = await investigate(ref);
  assert.equal(r.finding.code, 'INVESTIGATION_INCONCLUSIVE');
  assert.equal(r.confidence, 'LOW');
  const { c } = await caseFor(ref);
  assert.equal(c.result.status, 'We cannot yet confirm the final payment status.');
  assert.equal(c.result.next_steps[0], 'Do not send the money again.');
  assert.equal(c.result.timeline[1].state, 'unknown');
});

test('a missing credit is never read as PAYMENT_FAILED', async () => {
  paypalSays('OUT-NF1');
  const refs = [
    paypalTransfer('OUT-NF1', 'stuck'), // PayPal completed, no credit
    fx.ledger.transfer({ senderUserId: me.id, recipientUserId: musa.id, amount: 300, simulate: 'credit_fail' }).reference, // balance debited, no credit
  ];
  for (const ref of refs) {
    for (const at of [new Date(), minutesFromNow(600)]) assert.notEqual((await investigate(ref, at)).finding.code, 'PAYMENT_FAILED');
  }
});

// ---- Exceptions: open, age, escalate, close ---------------------------------------------

test('a payment pending too long becomes an exception, and a later completion closes it', async () => {
  const ref = fx.ledger.transfer({ senderUserId: me.id, recipientUserId: musa.id, amount: 1100, simulate: 'pending' }).reference;
  let clock = new Date();
  const svc = createService({ now: () => clock });
  let c = await svc.service.openCase(C.me, 'I sent Musty $11 today and he has not received it');
  svc.service.confirm(C.me, c.id, ref);
  c = await svc.service.investigate(C.me, c.id);
  assert.equal(c.result.finding_code, 'PAYMENT_PENDING');
  assert.equal(svc.store.exception(c.id), null, 'freshly pending: no exception yet');

  clock = minutesFromNow(30); // past the processing window, still no credit
  c = await svc.service.investigate(C.me, c.id, { again: true });
  assert.equal(c.result.finding_code, 'DEBITED_NOT_CREDITED');
  assert.equal(svc.store.exception(c.id).status, 'OPEN');
  assert.equal(svc.service.internalExceptions('OPEN').some((e) => e.case_id === c.id), true);

  // FastPay finishes the payment; checking again closes the exception.
  fx.db.prepare("UPDATE transactions SET settle_at = '2000-01-01T00:00:00.000Z' WHERE reference = ?").run(ref);
  fx.ledger.startSettlementWorker(60_000);
  c = await svc.service.investigate(C.me, c.id, { again: true });
  assert.equal(c.result.finding_code, 'PAYMENT_COMPLETED');
  const closed = svc.store.exception(c.id);
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.closed_reason, 'Re-investigated: PAYMENT_COMPLETED');
  const events = svc.store.auditFor(c.id).map((a) => a.event);
  assert.ok(events.includes('EXCEPTION_OPENED') && events.includes('EXCEPTION_CLOSED'));
});

// ---- The chat is a conversation ------------------------------------------------------------

test('"hi" gets a greeting, not a payment search', async () => {
  const { service } = createService();
  const c = await service.openCase(C.me, 'hi');
  assert.equal(c.status, 'NEEDS_DETAILS');
  assert.match(c.messages.at(-1).body, /^Hi Abdul, I'm here to help/);
  assert.equal(c.candidates.length, 0);
});

test('the first reply shows it understood, with sympathy', async () => {
  const ref = fx.ledger.transfer({ senderUserId: me.id, recipientUserId: musa.id, amount: 4400, simulate: 'success' }).reference;
  const { service } = createService();
  const c = await service.openCase(C.me, 'I sent Musty $44 today but he has not received it');
  assert.ok(c.candidates.some((x) => x.reference === ref));
  assert.match(c.messages.at(-1).body, /^I'm sorry Musty hasn't received the \$44\.00 yet\. Let's find out what happened\. I found this payment/);
});

test('after the result, the customer can keep talking', async () => {
  const ref = paypalTransfer('OUT-CHAT', 'stuck');
  paypalSays('OUT-CHAT');
  const { service, c: first } = await caseFor(ref);
  assert.equal(first.messages.at(-1).body.split('. PayPal confirmed')[0], "I found the issue. PayPal completed the payment, but FastPay has not yet recorded the recipient's wallet credit");
  assert.match(first.messages.at(-1).body, /Please do not send the money again. The timeline and next steps are below.$/);

  let c = await service.addMessage(C.me, first.id, 'why did this happen?');
  assert.match(c.messages.at(-1).body, /^Here's what the records show\. PayPal confirmed that the \$25\.00 payment was completed/);
  c = await service.addMessage(C.me, first.id, 'will I get my money back?');
  assert.match(c.messages.at(-1).body, /I can't move money, so no refund or payment has been made yet/);
  c = await service.addMessage(C.me, first.id, 'can I talk to a person?');
  assert.match(c.messages.at(-1).body, /already been assigned to our payments team for review/);
  c = await service.addMessage(C.me, first.id, 'thank you');
  assert.match(c.messages.at(-1).body, /^You're welcome, Abdul\./);

  // "check again" re-runs the investigation and says whether anything changed.
  c = await service.addMessage(C.me, first.id, 'can you check again?');
  assert.match(c.messages.at(-1).body, /^I've checked again, and nothing has changed yet\./);
  assert.equal(c.result.after_message, c.messages.length - 1, 'the new result card sits under its message');
});

test('chat intents', () => {
  assert.equal(smallTalk('hello!'), 'GREETING');
  assert.equal(smallTalk('hi i sent 25$ to musty'), null, 'a greeting with a complaint in it is a complaint');
  assert.equal(postResultIntent('ok, check again'), 'CHECK');
  assert.equal(postResultIntent('thanks'), 'THANKS');
  assert.equal(postResultIntent('what does that mean'), 'WHY');
  assert.equal(postResultIntent('I want a refund'), 'MONEY');
  assert.equal(postResultIntent('I have another problem with a different payment'), 'OTHER_PAYMENT');
});

test('captured-not-credited wording: review, not a promised resolution; no refund issued', async () => {
  const ref = paypalTransfer('OUT-WORDING', 'stuck');
  paypalSays('OUT-WORDING');
  const { c } = await caseFor(ref);
  const v = c.result;
  assert.equal(v.headline, 'Recipient wallet credit not yet recorded');
  assert.match(v.details[0], /^PayPal confirmed that the \$25\.00 payment was completed at /);
  assert.match(v.details.at(-1), /and no refund has been issued to you\.$/);
  assert.equal(v.next_steps[1], 'Your case and its evidence have been recorded and assigned to our payments team for review because the recipient wallet credit has not yet been recorded.');
  assert.doesNotMatch(JSON.stringify(v), /to resolve|money has not been returned/);
});
