// The whole module, end to end: Understand -> Find -> Confirm -> Investigate -> Report.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, createService, minutesFromNow } from './helpers/fixture.js';

let fx, me, musa, musaBello, other;
const C = {}; // the same people, as signed-in customers seen through FastPay's investigation window

before(async () => {
  fx = await createFixture();
  me = fx.addUser('Abdul Ishaq', 'abdul@test.dev');
  musa = fx.addUser('Musa Ibrahim', 'musa@test.dev');
  musaBello = fx.addUser('Musa Bello', 'mbello@test.dev');
  other = fx.addUser('Zainab Yusuf', 'zainab@test.dev');
  fx.fund(me, 100_000);
  fx.fund(other, 100_000);
  for (const [k, u] of Object.entries({ me, musa, musaBello, other })) C[k] = await fx.login(u);
});
after(() => fx.close());

const send = (from, to, amount, simulate) => fx.ledger.transfer({ senderUserId: from.id, recipientUserId: to.id, amount, simulate }).reference;

test('the brief example: "I sent Musa $50 yesterday, but he hasn\'t received it."', async () => {
  const stuck = send(me, musa, 5000, 'credit_fail');
  fx.backdate(stuck, 24 * 60); // yesterday
  const noise = [send(me, musa, 2000, 'success'), send(me, musaBello, 5000, 'success')]; // other payments today
  const { service, store } = createService();

  // Stage 1 + 2
  let c = await service.openCase(C.me, "I sent Musa $50 yesterday, but he hasn't received it.");
  assert.equal(c.status, 'AWAITING_CONFIRMATION');
  assert.equal(c.complaint_type, 'RECIPIENT_NOT_CREDITED');
  assert.equal(c.candidates[0].reference, stuck, 'the stuck payment from yesterday ranks first');
  assert.ok(!c.candidates.some((x) => x.reference === noise[0] && x.rank === 1));
  assert.equal(c.candidates[0].display.counterparty, 'Musa Ibrahim');
  assert.ok(c.candidates[0].reasons.some((r) => /Amount is \$50\.00/.test(r)));

  // Stage 4 is refused before stage 3
  await assert.rejects(service.investigate(C.me, c.id), /confirm which payment/);

  // Stage 3
  c = service.confirm(C.me, c.id, stuck);
  assert.equal(c.status, 'CONFIRMED');
  assert.equal(c.confirmation.reference, stuck);

  // Stage 4
  c = await service.investigate(C.me, c.id);
  assert.equal(c.status, 'INVESTIGATED');
  // What the customer sees: a plain result, no internal evidence.
  assert.equal(c.report, undefined);
  assert.equal(c.result.headline, 'Recipient wallet credit not yet recorded');
  assert.match(c.result.status, /FastPay has not recorded the recipient's wallet credit/);
  assert.ok(c.result.next_steps.some((s) => /Do not send the money again/.test(s)));
  assert.equal(c.result.evidence, undefined);
  assert.equal(c.result.checks, undefined);
  assert.match(c.result.money_note, /No refund or new payment has been made/);

  const report = service.internalReport(c.id).report; // the internal view
  assert.equal(report.finding.code, 'DEBITED_NOT_CREDITED');
  assert.equal(report.claim_assessment.result, 'SUPPORTED');
  assert.equal(report.amount_at_issue.amount, 5000);
  assert.equal(report.transaction.reference, stuck);
  assert.equal(report.confirmation.reference, stuck);
  assert.equal(report.complaint.claimed.counterparty, 'Musa');
  assert.deepEqual(report.complaint.statements, ["I sent Musa $50 yesterday, but he hasn't received it."]);
  assert.ok(report.sources_checked.includes('FASTPAY_TRANSACTIONS') && report.sources_checked.includes('FASTPAY_WALLETS'));
  assert.match(report.summary, /has not recorded the credit to Musa Ibrahim's wallet 1 day later/);
  assert.match(report.report_id, /^RPT-/);

  // Asking again returns the same report, not a new one
  const again = await service.investigate(C.me, c.id);
  assert.equal(service.internalReport(again.id).report.report_id, report.report_id);

  // Everything is on the audit trail
  const events = store.auditFor(c.id).map((a) => a.event);
  for (const e of ['CASE_OPENED', 'CUSTOMER_MESSAGE', 'COMPLAINT_UNDERSTOOD', 'TRANSACTIONS_SEARCHED', 'GUARD_BLOCKED', 'TRANSACTION_CONFIRMED', 'INVESTIGATION_STARTED', 'REPORT_CREATED']) {
    assert.ok(events.includes(e), e);
  }
});

test('several matches: the customer is asked to choose', async () => {
  send(me, musa, 700, 'success');
  send(me, musaBello, 700, 'success');
  const { service } = createService();
  const c = await service.openCase(C.me, 'I sent Musa $7 today and he says he did not get it');
  assert.equal(c.status, 'AWAITING_CONFIRMATION');
  assert.equal(c.candidates.length, 2);
  assert.match(c.messages.at(-1).body, /found 2 payments/);
});

test('no details: FastPay asks for more before searching', async () => {
  const { service } = createService();
  let c = await service.openCase(C.me, 'My money did not reach him');
  assert.equal(c.status, 'NEEDS_DETAILS');
  assert.match(c.messages.at(-1).body, /how much it was/);

  send(me, musa, 3300, 'success');
  c = await service.addMessage(C.me, c.id, 'It was $33 to Musa today');
  assert.equal(c.status, 'AWAITING_CONFIRMATION');
  assert.equal(c.candidates[0].display.amount, 3300);
});

test('nothing matches: FastPay says what it searched for and asks again', async () => {
  const { service } = createService();
  const c = await service.openCase(C.me, 'I sent Musa $999 on 1 Nov 2026 and he did not get it');
  assert.equal(c.status, 'NEEDS_DETAILS');
  assert.match(c.messages.at(-1).body, /couldn't find a payment of \$999\.00 to Musa on Sun, 1 Nov 2026/);
});

test('"none of these" hides the shown payments', async () => {
  const shown = send(me, musa, 4400, 'success');
  const { service } = createService();
  let c = await service.openCase(C.me, 'I sent Musa $44 today but he did not get it');
  assert.equal(c.candidates[0].reference, shown);
  c = service.rejectCandidates(C.me, c.id);
  assert.equal(c.status, 'NEEDS_DETAILS');
  c = await service.addMessage(C.me, c.id, 'It was $44 to Musa Ibrahim today');
  assert.ok(!c.candidates.some((x) => x.reference === shown));
});

test('only a payment that was shown can be confirmed', async () => {
  const shown = send(me, musa, 5100, 'success');
  const notShown = send(me, other, 5100, 'success');
  const { service } = createService();
  const c = await service.openCase(C.me, 'I sent Musa Ibrahim $51 today, not received');
  assert.ok(c.candidates.some((x) => x.reference === shown));
  assert.throws(() => service.confirm(C.me, c.id, notShown), /choose one of the payments shown/);
  assert.throws(() => service.confirm(C.me, c.id, 'FP-000000-NOTREAL'), /choose one of the payments shown/);
  service.confirm(C.me, c.id, shown);
  assert.equal(service.confirm(C.me, c.id, shown).confirmation.reference, shown); // double tap is fine
});

test("a customer can never see or investigate someone else's case or payment", async () => {
  const hers = send(other, musa, 6100, 'success');
  const { service } = createService();
  // Zainab's payment never shows up for me
  const mine = await service.openCase(C.me, 'I sent Musa $61 today and he did not get it');
  assert.ok(!mine.candidates.some((x) => x.reference === hers));
  // and her case is invisible to me
  const theirs = await service.openCase(C.other, 'I sent Musa $61 today and he did not get it');
  assert.throws(() => service.getCase(C.me, theirs.id), /Case not found/);
  assert.throws(() => service.confirm(C.me, theirs.id, hers), /Case not found/);
  await assert.rejects(service.investigate(C.me, theirs.id), /Case not found/);
});

test('the recipient complaining: "Musa said he sent me money"', async () => {
  const stuck = send(me, musa, 2500, 'credit_fail');
  const { service } = createService({ now: () => minutesFromNow(30) });
  // Musa can't see the stuck payment in FastPay, but the investigation can find it for him
  let c = await service.openCase(C.musa, 'Abdul said he sent me $25 today but I have not received it');
  assert.equal(c.complaint_type, 'EXPECTED_MONEY_NOT_RECEIVED');
  assert.equal(c.candidates[0].reference, stuck);
  service.confirm(C.musa, c.id, stuck);
  c = await service.investigate(C.musa, c.id);
  assert.equal(service.internalReport(c.id).report.finding.code, 'DEBITED_NOT_CREDITED');
  assert.match(service.internalReport(c.id).report.summary, /^Abdul Ishaq sent you \$25\.00/);
  assert.match(service.internalReport(c.id).report.finding.explanation, /has not recorded the credit to your wallet/);
});

test('a still-processing result can be checked again later', async () => {
  const ref = send(me, musa, 1900, 'credit_fail');
  let clock = new Date();
  const { service } = createService({ now: () => clock });
  let c = await service.openCase(C.me, 'I sent Musa $19 today, not received');
  service.confirm(C.me, c.id, ref);
  c = await service.investigate(C.me, c.id);
  assert.equal(service.internalReport(c.id).report.finding.code, 'PAYMENT_PENDING');
  assert.equal(service.internalReport(c.id).report.claim_assessment.result, 'PENDING');
  clock = minutesFromNow(30);
  c = await service.investigate(C.me, c.id, { again: true });
  assert.equal(service.internalReport(c.id).report.finding.code, 'DEBITED_NOT_CREDITED');
});

test('the recipient was credited: the complaint is not supported', async () => {
  const ref = send(me, musa, 1800, 'success');
  const { service } = createService();
  let c = await service.openCase(C.me, 'I sent Musa $18 today but he says he never got it');
  service.confirm(C.me, c.id, ref);
  c = await service.investigate(C.me, c.id);
  assert.equal(service.internalReport(c.id).report.finding.code, 'PAYMENT_COMPLETED');
  assert.equal(service.internalReport(c.id).report.claim_assessment.result, 'NOT_SUPPORTED');
  assert.equal(service.internalReport(c.id).report.amount_at_issue.amount, 0);
});

// ---- Review fixes: dates, wording, privacy ------------------------------------------------

test('a payment from another day is never passed off as the one they meant', async () => {
  const today = send(me, musa, 8800, 'success'); // the only $88 payment is from today
  const { service } = createService();
  const c = await service.openCase(C.me, 'I sent Musa $88 yesterday but he has not received it');
  assert.equal(c.candidates[0].reference, today);
  assert.equal(c.candidates[0].display.date_mismatch, true);
  assert.match(c.candidates[0].display.warnings[0], /^Made on .+, not yesterday/);
  assert.match(c.messages.at(-1).body, /couldn't find a matching payment yesterday, but I found this one from/);
  assert.match(c.messages.at(-1).body, /check the date carefully/);
});

test('when the right day has a match, payments from other days are not shown', async () => {
  const yesterday = send(me, musa, 7700, 'success');
  fx.backdate(yesterday, 24 * 60);
  send(me, musa, 7700, 'success'); // same amount today
  const { service } = createService();
  const c = await service.openCase(C.me, 'I sent Musa $77 yesterday but he has not received it');
  assert.deepEqual(c.candidates.map((x) => x.reference), [yesterday]);
  assert.equal(c.candidates[0].display.date_mismatch, false);
});

test('successful payment: plain wording, "credited to the wallet", and next steps', async () => {
  const ref = send(me, musa, 600, 'success');
  const { service } = createService();
  let c = await service.openCase(C.me, 'I sent Musa $6 today but he says he never got it');
  service.confirm(C.me, c.id, ref);
  c = await service.investigate(C.me, c.id);
  const v = c.result;
  assert.equal(v.headline, 'Payment completed');
  assert.equal(v.tone, 'good');
  assert.equal(v.status, "The payment is complete, and Musa Ibrahim's FastPay wallet has been credited.");
  assert.ok(v.next_steps[0].startsWith('Ask Musa to refresh the FastPay app'));
  assert.match(v.next_steps.at(-1), /escalate/);
  const all = JSON.stringify(v);
  assert.doesNotMatch(all, /do not support|not supported|your complaint/i, 'never tells the customer they are wrong');
  assert.doesNotMatch(all, /Musa received/i, 'says "credited", not "received"');
  assert.match(c.messages.at(-1).body, /^Good news, I've finished checking\. The payment is complete/);
  assert.equal(service.internalReport(c.id).report.resolution_guidance.startsWith('No refund'), true);
});

test("the recipient isn't shown the sender's failed attempts", async () => {
  const failed = send(me, musa, 3900, 'fail'); // nothing left the sender
  const { service } = createService();
  const c = await service.openCase(C.musa, 'Abdul said he sent me $39 today but I have not received it');
  assert.ok(!c.candidates.some((x) => x.reference === failed));
});
