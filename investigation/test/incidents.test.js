// "Where it broke" and incident detection.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { whereItBroke } from '../src/investigate/breakpoint.js';
import { assessIncident } from '../src/investigate/incidents.js';
import { createFixture, createService } from './helpers/fixture.js';

// ---- Where it broke: rules ---------------------------------------------------------------

test('where it broke: each failure is put on the right party', () => {
  const w = (code, kind, facts) => whereItBroke({ code, kind, facts });
  assert.deepEqual([w('DEBITED_NOT_CREDITED', 'INTERNAL_TRANSFER').party, w('DEBITED_NOT_CREDITED', 'INTERNAL_TRANSFER').likely_bug], ['FASTPAY', true]);
  assert.equal(w('PAYMENT_CAPTURED_WALLET_NOT_CREDITED', 'PAYPAL_TRANSFER', { fastpay_recorded_charge: true }).stage, 'CREDIT_AFTER_PAYPAL_CHARGE');
  assert.equal(w('PAYMENT_CAPTURED_WALLET_NOT_CREDITED', 'PAYPAL_TOP_UP', { fastpay_recorded_charge: false }).stage, 'RECORDING_PAYPAL_CHARGE');
  assert.deepEqual(w('PAYOUT_FAILED', 'PAYPAL_CASH_OUT', { paypal_status: 'RETURNED' }).contributing, ['PAYPAL']);
  assert.equal(w('PAYMENT_FAILED', 'PAYPAL_TOP_UP', { order_status: 'APPROVED' }).stage, 'CAPTURE_NOT_COMPLETED');
  assert.equal(w('PAYMENT_FAILED', 'PAYPAL_TOP_UP', { order_status: 'APPROVED' }).party, 'FASTPAY');
  assert.equal(w('PAYMENT_FAILED', 'PAYPAL_TOP_UP', { order_status: 'CREATED' }).party, 'PAYER');
  assert.equal(w('PAYMENT_FAILED', 'PAYPAL_TRANSFER', { paypal_status: 'DECLINED' }).party, 'PAYPAL');
  assert.equal(w('PAYMENT_REFUNDED', 'PAYPAL_CASH_OUT', { paypal_status: 'FAILED' }).party, 'PAYPAL');
  assert.equal(w('PAYMENT_PENDING', 'PAYPAL_CASH_OUT', { pending_reason: 'PAYOUT_UNCLAIMED' }).party, 'RECIPIENT');
  assert.equal(w('PAYMENT_COMPLETED', 'INTERNAL_TRANSFER').party, 'NONE');
  assert.equal(w('INVESTIGATION_INCONCLUSIVE', 'PAYPAL_TRANSFER', { paypal_unreachable: true }).stage, 'PAYPAL_UNREACHABLE');
});

test('incident rules: a pattern across customers, not one unlucky payment', () => {
  const ch = { type: 'TRANSFER', provider: 'FASTPAY' };
  const base = { channel: ch, total: 10, failed: 0, webhook_errors: 0 };
  const bp = { stage: 'CREDIT_TO_RECIPIENT' };
  assert.equal(assessIncident({ ...base, stuck: 1, others_affected: 0 }, { kind: 'INTERNAL_TRANSFER', breakpoint: bp }).status, 'NONE');
  assert.equal(assessIncident({ ...base, stuck: 2, others_affected: 1 }, { kind: 'INTERNAL_TRANSFER', breakpoint: bp }).status, 'WATCH');
  const s = assessIncident({ ...base, stuck: 4, others_affected: 3 }, { kind: 'INTERNAL_TRANSFER', breakpoint: bp });
  assert.equal(s.status, 'SUSPECTED');
  assert.equal(s.signature, 'INTERNAL_TRANSFER:CREDIT_TO_RECIPIENT:TRANSFER:FASTPAY');
  // Many stuck payments from ONE customer is not an incident
  assert.equal(assessIncident({ ...base, stuck: 6, others_affected: 0 }, { kind: 'INTERNAL_TRANSFER', breakpoint: bp }).status, 'NONE');
  // Failing PayPal webhooks are a signal for PayPal channels
  assert.equal(assessIncident({ ...base, channel: { type: 'DEPOSIT', provider: 'PAYPAL' }, stuck: 0, others_affected: 0, webhook_errors: 5 }, { kind: 'PAYPAL_TOP_UP', breakpoint: bp }).status, 'SUSPECTED');
  assert.equal(assessIncident(null).status, 'UNAVAILABLE');
});

// ---- End to end, through FastPay's window --------------------------------------------------

let fx, musa;
const users = [];
before(async () => {
  fx = await createFixture();
  musa = fx.addUser('Musa Ibrahim', 'musa@test.dev');
  for (const n of ['Aisha', 'Bello', 'Chidi', 'Dayo', 'Emeka']) {
    const u = fx.addUser(`${n} Test`, `${n.toLowerCase()}@test.dev`);
    fx.fund(u, 50_000);
    users.push(u);
  }
});
after(() => fx.close());

const stuckPayment = (from, amount) => {
  const ref = fx.ledger.transfer({ senderUserId: from.id, recipientUserId: musa.id, amount, simulate: 'credit_fail' }).reference;
  fx.backdate(ref, 30); // stuck for 30 minutes
  return ref;
};

async function complain(service, user, message, ref) {
  const customer = await fx.login(user);
  let c = await service.openCase(customer, message);
  service.confirm(customer, c.id, ref);
  c = await service.investigate(customer, c.id);
  return { view: c, report: service.internalReport(c.id).report };
}

test('one stuck payment on its own: where it broke, but no incident', async () => {
  const ref = stuckPayment(users[0], 1100);
  const { service } = createService();
  const { view, report } = await complain(service, users[0], 'I sent Musa $11 but he did not get it', ref);
  assert.equal(report.broke_at.party, 'FASTPAY');
  assert.equal(report.broke_at.likely_bug, true);
  assert.equal(report.incident.status, 'NONE');
  assert.equal(view.result.incident_note, null);
  // Internal details never reach the customer
  assert.equal(view.result.broke_at, undefined);
  assert.doesNotMatch(JSON.stringify(view.result), /bug|FastPay processing fault/i);
});

test('many customers stuck the same way: a suspected incident, and cases are linked to it', async () => {
  const refs = users.slice(1).map((u, i) => stuckPayment(u, 2000 + i * 100));
  const { service, store } = createService();

  const first = await complain(service, users[1], 'I sent Musa $20 but he has not received it', refs[0]);
  assert.equal(first.report.incident.status, 'SUSPECTED');
  assert.match(first.report.incident.incident_id, /^INC-/);
  assert.ok(first.report.incident.reasons.some((r) => /other customer/.test(r)));
  assert.match(first.report.resolution_guidance, /suspected incident/);
  assert.match(first.view.result.incident_note, /similar problem with some other payments/);

  const second = await complain(service, users[2], 'I sent Musa $21 but he has not received it', refs[1]);
  assert.equal(second.report.incident.incident_id, first.report.incident.incident_id, 'same incident');
  const inc = store.incident(first.report.incident.incident_id);
  assert.equal(inc.case_count, 2);
  assert.equal(inc.likely_bug, true);
  assert.equal(inc.status, 'SUSPECTED'); // a flag for the team, never declared by the system

  // Signals are counts only: nothing about the other customers leaks into anyone's report
  const signals = JSON.stringify(first.report.incident.signals);
  for (const u of users) assert.doesNotMatch(signals, new RegExp(u.name.split(' ')[0]));
  for (const r of refs) assert.doesNotMatch(signals, new RegExp(r));
});

test('a completed payment is not checked for incidents at all', async () => {
  const u = users[0];
  const ref = fx.ledger.transfer({ senderUserId: u.id, recipientUserId: musa.id, amount: 300, simulate: 'success' }).reference;
  const { service } = createService();
  const { report } = await complain(service, u, 'I sent Musa $3 today but he says no', ref);
  assert.equal(report.broke_at.party, 'NONE');
  assert.equal(report.incident.status, 'NOT_CHECKED');
});

test("signals can only be asked about the customer's own payment", async () => {
  const ref = stuckPayment(users[3], 999);
  const outsider = await fx.login(users[4]);
  assert.equal(await outsider.api.signals(ref), null);
});
