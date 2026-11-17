// The resolution policy: what may be done about an investigated payment, and who must authorize it.
// Pure code, no model. The agent can read the result but never change it.
//
// Two kinds of resolution:
//   CUSTOMER_CHOICE  the money is stuck somewhere it could still be delivered. The customer chooses
//                    (deliver it, or give it back), and only their server-side approval lets it run.
//   POLICY           the records prove the fault is FastPay's. Nothing to choose: the policy
//                    authorizes putting the customer right (above the limit, staff must also approve).
//
// Money actions (the only three that can ever run):
//   CREDIT_WALLET     post the missing credit to a FastPay wallet (the recipient's, or the customer's own)
//   REFUND_PAYPAL     refund the PayPal capture to the payer's PayPal
//   RETURN_TO_WALLET  put the money back on the payer's FastPay balance
// Other options (no money moves): WAIT, ESCALATE.

export const MONEY_ACTIONS = new Set(['CREDIT_WALLET', 'REFUND_PAYPAL', 'RETURN_TO_WALLET']);

export const DECISIONS = {
  ELIGIBLE: 'Eligible for resolution',
  NOT_YET: 'Too early: the payment may still finish on its own',
  NEEDS_RECHECK: 'The report is too old to act on: check again first',
  NEEDS_STAFF: 'A person must review this case',
  NOTHING_TO_DO: 'Nothing to resolve',
  ALREADY_RESOLVED: 'Already resolved',
};

const decision = (code, reason, extra = {}) => ({ code, label: DECISIONS[code], reason, ...extra });

/**
 * Case Evaluator. `report` is Module 2's internal report; `live` is the transaction as FastPay has it now
 * (from the customer's own window); `prior` is any resolution already recorded for this transaction.
 */
export function evaluate({ report, live, viewer, prior, settings, now = new Date() }) {
  const code = report?.finding?.code;
  if (!report || !code) return decision('NOTHING_TO_DO', 'There is no investigation report.');
  if (prior) return decision('ALREADY_RESOLVED', `This payment was already resolved (${prior.id}: ${prior.status}).`, { prior: prior.id });

  // The transaction must still belong to the signed-in customer, and say what the report said.
  if (!live) return decision('NEEDS_STAFF', 'FastPay no longer returns this payment for this customer.');
  const mine = live.sender_wallet_id === viewer.walletId || live.receiver_wallet_id === viewer.walletId;
  if (!mine) return decision('NEEDS_STAFF', 'The payment is not in this customer\'s wallet.');
  if (live.reference !== report.transaction.reference || live.amount !== report.transaction.amount || live.currency !== report.transaction.currency) {
    return decision('NEEDS_STAFF', 'The payment no longer matches the investigation report.');
  }

  if (['PAYMENT_COMPLETED', 'PAYMENT_FAILED', 'PAYMENT_REFUNDED'].includes(code)) {
    return decision('NOTHING_TO_DO', {
      PAYMENT_COMPLETED: 'The payment completed and the wallet credit is recorded.',
      PAYMENT_FAILED: 'No money was taken, so there is nothing to give back.',
      PAYMENT_REFUNDED: 'The money was already returned.',
    }[code]);
  }
  if (code === 'PAYMENT_PENDING') return decision('NOT_YET', report.pending?.says ?? 'The payment is still being processed.');
  if (code === 'INVESTIGATION_INCONCLUSIVE') return decision('NEEDS_STAFF', 'The records are missing or disagree. A person must review it; nothing is done automatically.');

  // Never act on records that disagree, or on a low-confidence report.
  if (report.discrepancies?.length) return decision('NEEDS_STAFF', `The records disagree: ${report.discrepancies.map((d) => d.code).join(', ')}.`);
  if (report.confidence === 'LOW') return decision('NEEDS_STAFF', 'The investigation is not confident enough to act on.');
  if (report.claim_assessment?.result === 'NOT_SUPPORTED') return decision('NOTHING_TO_DO', 'The records do not support the complaint.');

  // Something changed since the report: the money settled on its own (late credit, refund, return).
  // (A duplicate went through normally, so only a return counts for it.)
  if (live.reversed_at || (live.credited_at && code !== 'DUPLICATE_PAYMENT')) return decision('NOTHING_TO_DO', 'Since the report, FastPay has recorded the money as delivered or returned.');

  const ageMin = (now - new Date(report.generated_at)) / 60_000;
  if (ageMin > settings.reportMaxAgeMinutes) return decision('NEEDS_RECHECK', `The report is ${Math.round(ageMin)} minutes old.`);

  return decision('ELIGIBLE', report.claim_assessment?.note ?? 'The records show money was taken and not delivered or returned.');
}

/**
 * Resolution Planner. Returns the only options that exist for this case. Each money option names its
 * exact action, amount, currency and target; those terms are frozen when an approval is created.
 */
export function plan({ report, live, settings, now = new Date() }) {
  const code = report.finding.code;
  const kind = report.kind;
  const payer = report.perspective === 'PAYER';
  const amount = report.amount_at_issue?.amount || live.amount;
  const currency = live.currency;
  const recipient = report.transaction.payee?.name ?? 'the recipient';
  const fromPayPal = ['PAYPAL_TRANSFER', 'PAYPAL_TOP_UP'].includes(kind) && live.capture_id;
  const ageHours = (now - new Date(live.debited_at ?? live.created_at)) / 3600_000;

  const credit = (walletId, who, rule) => ({
    action: 'CREDIT_WALLET', rule, amount, currency,
    target: { type: 'FASTPAY_WALLET', wallet_id: walletId, name: who },
  });
  const refund = (rule, captureId = live.capture_id, ref = live.reference) => ({
    action: 'REFUND_PAYPAL', rule, amount, currency,
    target: { type: 'PAYPAL_CAPTURE', capture_id: captureId, reference: ref },
  });
  const giveBack = (rule) => ({
    action: 'RETURN_TO_WALLET', rule, amount, currency,
    target: { type: 'FASTPAY_WALLET', wallet_id: live.sender_wallet_id, name: 'your FastPay balance' },
  });
  const wait = { action: 'WAIT', rule: 'customer-may-wait' };
  const choice = (rule, options) => ({ type: 'CUSTOMER_CHOICE', rule, options: [...options, wait] });
  const policy = (rule, option, why) => ({ type: 'POLICY', rule, options: [option], why });
  const staff = (rule, why) => ({ type: 'STAFF', rule, options: [{ action: 'ESCALATE', rule }], why });

  if (code === 'PAYMENT_CAPTURED_WALLET_NOT_CREDITED') {
    if (kind === 'PAYPAL_TRANSFER' && payer && fromPayPal) {
      return choice('captured-transfer:payer-chooses', [
        credit(live.receiver_wallet_id, recipient, 'captured-transfer:deliver'),
        refund('captured-transfer:refund'),
      ]);
    }
    if (kind === 'PAYPAL_TRANSFER') {
      return policy('captured-transfer:deliver-to-payee', credit(live.receiver_wallet_id, 'your FastPay wallet', 'captured-transfer:deliver-to-payee'),
        'PayPal collected the money for you, and FastPay failed to post it. FastPay posts it.');
    }
    if (kind === 'PAYPAL_TOP_UP' || kind === 'PAYPAL_REQUEST') {
      return policy(`${kind === 'PAYPAL_TOP_UP' ? 'top-up' : 'invoice'}:credit-own-wallet`, credit(live.receiver_wallet_id, 'your FastPay wallet', 'captured:credit-own-wallet'),
        'PayPal completed the payment into your account, and FastPay failed to credit it. FastPay credits it.');
    }
  }

  if (code === 'DEBITED_NOT_CREDITED') {
    if (!payer) {
      return policy('debited:deliver-to-payee', credit(live.receiver_wallet_id, 'your FastPay wallet', 'debited:deliver-to-payee'),
        'The money left the sender and FastPay never posted your credit. FastPay posts it.');
    }
    if (ageHours >= settings.autoReturnHours) {
      return policy('debited:auto-return', giveBack('debited:auto-return'),
        `The money has been stuck for more than ${settings.autoReturnHours} hours. FastPay returns it to your balance.`);
    }
    return choice('debited:payer-chooses', [
      credit(live.receiver_wallet_id, recipient, 'debited:deliver'),
      giveBack('debited:return'),
    ]);
  }

  if (code === 'PAYOUT_FAILED') {
    if (!payer) return staff('payout-failed:payee', 'The payment failed on FastPay\'s side, and the money belongs to the sender. Staff will return it to them.');
    return policy('payout-failed:return', giveBack('payout-failed:return'),
      'The payment was taken, then failed, and was never returned. FastPay returns it to your balance.');
  }

  if (code === 'DUPLICATE_PAYMENT') {
    const extras = report.related_references ?? [];
    if (!payer || extras.length !== 1) return staff('duplicate:review', 'More than one duplicate needs untangling. Staff will review it.');
    // The extra payment is returned. Which one is "extra" is decided by the service from the live records.
    return { type: 'POLICY', rule: 'duplicate:return-extra', duplicate_of: extras[0], options: [], why: 'The same payment went through twice. FastPay returns the extra one.' };
  }

  return staff('unknown', 'No policy covers this case.');
}

/** What the customer sees for an option. Never includes internal ids. */
export function describeOption(o, { amountDisplay, recipient }) {
  switch (o.action) {
    case 'CREDIT_WALLET':
      return o.target.name === 'your FastPay wallet'
        ? { title: `Credit ${amountDisplay} to your FastPay wallet`, detail: 'FastPay posts the missing credit to your wallet.' }
        : { title: `Credit ${o.target.name}'s FastPay wallet`, detail: `FastPay posts the ${amountDisplay} credit to ${o.target.name}'s wallet, as you intended.` };
    case 'REFUND_PAYPAL':
      return { title: `Refund ${amountDisplay} to your PayPal`, detail: 'FastPay refunds the PayPal payment to the way you paid. Payment to the recipient is cancelled.' };
    case 'RETURN_TO_WALLET':
      return { title: `Return ${amountDisplay} to your FastPay balance`, detail: `The money comes back to your balance${recipient ? `, and ${recipient} is not credited` : ''}.` };
    case 'WAIT':
      return { title: 'Wait and check again later', detail: 'Nothing changes now. You can come back and check again.' };
    case 'ESCALATE':
      return { title: 'Passed to our payments team', detail: 'A person reviews it. Nothing changes until they do.' };
    default:
      return { title: o.action, detail: '' };
  }
}
