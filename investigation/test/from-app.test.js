// Opening payment help from a payment in the FastPay app (/?ref=FP-…).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, createService } from './helpers/fixture.js';

let fx, me, musa, other;
const C = {};

before(async () => {
  fx = await createFixture();
  me = fx.addUser('Abdul Ishaq', 'abdul@test.dev');
  musa = fx.addUser('Musty Bala', 'musty@test.dev');
  other = fx.addUser('Zainab Yusuf', 'zainab@test.dev');
  fx.fund(me, 100_000);
  fx.fund(other, 100_000);
  for (const [k, u] of Object.entries({ me, musa, other })) C[k] = await fx.login(u);
});
after(() => fx.close());

const send = (from, to, amount, simulate) => fx.ledger.transfer({ senderUserId: from.id, recipientUserId: to.id, amount, simulate }).reference;

test('help opened from a payment: that payment is the one to confirm, after the customer says what went wrong', async () => {
  const ref = send(me, musa, 2500, 'credit_fail');
  const { service, store } = createService();
  let c = await service.openCaseForPayment(C.me, ref);
  assert.equal(c.status, 'NEEDS_DETAILS');
  assert.equal(c.pinned.reference, ref);
  assert.match(c.messages[0].body, /^Hi Abdul, I can see you need help with your \$25\.00 payment to Musty Bala on .+\(FP-.+\)\. What went wrong with it\?$/);
  assert.equal(store.auditFor(c.id)[0].detail.from, 'FASTPAY_APP');

  // Stage 1 still happens: the customer describes the problem in their own words.
  c = await service.addMessage(C.me, c.id, 'I sent this payment to Musty Bala but they have not received it');
  assert.equal(c.status, 'AWAITING_CONFIRMATION');
  assert.equal(c.complaint_type, 'RECIPIENT_NOT_CREDITED');
  assert.deepEqual(c.candidates.map((x) => x.reference), [ref]);
  assert.match(c.messages.at(-1).body, /please confirm this is the payment you mean/);

  // Stage 3 and 4 as usual.
  service.confirm(C.me, c.id, ref);
  c = await service.investigate(C.me, c.id);
  assert.equal(c.status, 'INVESTIGATED');
  assert.ok(c.result);
});

test('"hi" on a case opened from a payment asks what went wrong with that payment', async () => {
  const ref = send(me, musa, 700, 'success');
  const { service } = createService();
  let c = await service.openCaseForPayment(C.me, ref);
  c = await service.addMessage(C.me, c.id, 'hello');
  assert.match(c.messages.at(-1).body, /what went wrong with this \$7\.00 payment/);
  assert.equal(c.status, 'NEEDS_DETAILS');
});

test('"none of these" on the opened payment falls back to a normal search', async () => {
  const opened = send(me, musa, 1200, 'success');
  const meant = send(me, musa, 3300, 'success');
  const { service } = createService();
  let c = await service.openCaseForPayment(C.me, opened);
  c = await service.addMessage(C.me, c.id, 'I sent Musty $33 today but he has not received it');
  assert.deepEqual(c.candidates.map((x) => x.reference), [opened]);
  c = service.rejectCandidates(C.me, c.id);
  c = await service.addMessage(C.me, c.id, 'it was $33 to Musty today');
  assert.ok(c.candidates.some((x) => x.reference === meant));
  assert.ok(!c.candidates.some((x) => x.reference === opened));
});

test("a link can't open someone else's payment", async () => {
  const theirs = send(other, musa, 900, 'success');
  const { service } = createService();
  await assert.rejects(service.openCaseForPayment(C.me, theirs), /could not be found in your FastPay account/);
  await assert.rejects(service.openCaseForPayment(C.me, 'not a reference!'), /could not be found/);
});

test("a receiver can't use a link to see a transfer that never reached them", async () => {
  const stuck = send(me, musa, 1500, 'credit_fail'); // Musty can't see it in FastPay
  const failed = send(me, musa, 1600, 'fail');
  const { service } = createService();
  await assert.rejects(service.openCaseForPayment(C.musa, stuck), /could not be found/);
  await assert.rejects(service.openCaseForPayment(C.musa, failed), /could not be found/);
  const credited = send(me, musa, 1700, 'success');
  const c = await service.openCaseForPayment(C.musa, credited);
  assert.match(c.messages[0].body, /help with the \$17\.00 from Abdul Ishaq/);
});
