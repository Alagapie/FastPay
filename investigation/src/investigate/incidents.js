// Incident detection: is this one customer's problem, or is it happening to many people at once?
//
// Uses only COUNTS from FastPay's window (no other customer's details), around the time and on the
// channel of the payment being investigated. The result is a FLAG for the team to confirm, never a
// declared outage.

export const INCIDENT_RULES = {
  minStuck: 3, // at least this many stuck payments on the channel...
  minOthersAffected: 2, // ...belonging to at least this many OTHER customers
  stuckShare: 0.3, // or: this share of all payments on the channel is stuck
  minTotalForShare: 5,
  minWebhookErrors: 3, // or: PayPal webhook processing is failing
};

const CHANNEL_LABEL = {
  'TRANSFER:FASTPAY': 'transfers from FastPay balance',
  'TRANSFER:PAYPAL': 'transfers paid with PayPal',
  'DEPOSIT:PAYPAL': 'PayPal top-ups',
  'DEPOSIT:PAYPAL_INVOICE': 'PayPal payment requests',
  'DEPOSIT:SIMULATED': 'test bank deposits',
  'WITHDRAWAL:PAYPAL': 'cash outs to PayPal',
};

export const channelLabel = (ch) => CHANNEL_LABEL[`${ch?.type}:${ch?.provider}`] ?? 'payments on this channel';

/** Should this case look for an incident at all? Only when something is wrong or unresolved. */
export const worthChecking = (findingCode, breakpoint) =>
  ['FASTPAY', 'PAYPAL', 'UNKNOWN'].includes(breakpoint.party) || ['PAYMENT_PENDING', 'INVESTIGATION_INCONCLUSIVE'].includes(findingCode);

/**
 * @returns { status: NOT_CHECKED | UNAVAILABLE | NONE | WATCH | SUSPECTED, reasons[], signals, signature }
 */
export function assessIncident(signals, { kind, breakpoint, rules = INCIDENT_RULES } = {}) {
  if (signals === undefined) return { status: 'NOT_CHECKED', reasons: [], signals: null };
  if (signals === null) return { status: 'UNAVAILABLE', reasons: ['FastPay could not provide incident signals.'], signals: null };

  const label = channelLabel(signals.channel);
  const reasons = [];
  const many = signals.stuck >= rules.minStuck && signals.others_affected >= rules.minOthersAffected;
  const share = signals.total >= rules.minTotalForShare && signals.stuck / signals.total >= rules.stuckShare && signals.others_affected >= 1;
  const hooks = signals.webhook_errors >= rules.minWebhookErrors && signals.channel.provider !== 'FASTPAY';

  if (many) reasons.push(`${signals.stuck} ${label} are stuck in this window, affecting ${signals.others_affected} other customer(s).`);
  if (share) reasons.push(`${Math.round((signals.stuck / signals.total) * 100)}% of ${label} in this window are stuck (${signals.stuck} of ${signals.total}).`);
  if (hooks) reasons.push(`${signals.webhook_errors} PayPal webhook events failed to process in this window.`);

  let status = 'NONE';
  if (many || share || hooks) status = 'SUSPECTED';
  else if (signals.others_affected >= 1 && signals.stuck >= 2) {
    status = 'WATCH';
    reasons.push(`${signals.stuck} ${label} are stuck in this window, including another customer's. Not enough yet to call it an incident.`);
  } else {
    reasons.push(`No unusual pattern: ${signals.stuck} stuck of ${signals.total} ${label} in this window.`);
  }

  return {
    status,
    reasons,
    signals,
    // Cases with the same broken step on the same channel belong to the same incident.
    signature: `${kind}:${breakpoint?.stage ?? 'UNKNOWN'}:${signals.channel.type}:${signals.channel.provider}`,
    channel_label: label,
  };
}
