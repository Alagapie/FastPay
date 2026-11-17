// Stage 2: Find the transaction.
// Plain code, no AI: scores each of the customer's own transactions against the details from
// stage 1 (amount, who, when, kind of payment) and returns the best few for them to choose from.
import { formatMoney } from '../util.js';
import { describeRange, formatDay, formatLocal, localDate } from '../understand/dates.js';

const MAX_CANDIDATES = 5;
const MIN_SCORE = 25;

/** How a transaction looks from the customer's side. */
export function perspective(tx, walletId) {
  const outgoing = tx.type !== 'DEPOSIT' && tx.sender_wallet_id === walletId;
  let counterparty;
  if (tx.type === 'WITHDRAWAL') counterparty = { name: 'PayPal', email: tx.external_account };
  else if (tx.type === 'DEPOSIT' && tx.provider === 'PAYPAL_INVOICE') counterparty = { name: tx.external_account, email: tx.external_account };
  else if (tx.type === 'DEPOSIT') counterparty = { name: tx.provider === 'PAYPAL' ? 'PayPal' : 'Test bank deposit' };
  else if (outgoing) counterparty = { name: tx.receiver_name, account_id: tx.receiver_account_id, email: tx.receiver_email };
  else counterparty = { name: tx.sender_name, account_id: tx.sender_account_id, email: tx.sender_email };
  return { outgoing, counterparty };
}

export function kindLabel(tx, outgoing) {
  if (tx.type === 'WITHDRAWAL') return 'Cash out to PayPal';
  if (tx.type === 'DEPOSIT') return tx.provider === 'PAYPAL_INVOICE' ? 'Payment request (PayPal invoice)' : 'Add money';
  return outgoing ? 'Money sent' : 'Money received';
}

export function channelLabel(tx) {
  if (tx.type === 'WITHDRAWAL') return 'PayPal';
  if (tx.provider === 'PAYPAL' || tx.provider === 'PAYPAL_INVOICE') return 'PayPal';
  if (tx.provider === 'SIMULATED') return 'Test bank';
  return 'FastPay balance';
}

// Which transactions each kind of complaint can be about.
const FITS = {
  RECIPIENT_NOT_CREDITED: (t, p) => t.type === 'TRANSFER' && p.outgoing,
  TOP_UP_NOT_REFLECTED: (t) => t.type === 'DEPOSIT' && t.provider !== 'PAYPAL_INVOICE',
  CASH_OUT_NOT_RECEIVED: (t) => t.type === 'WITHDRAWAL',
  EXPECTED_MONEY_NOT_RECEIVED: (t, p) => (t.type === 'TRANSFER' && !p.outgoing) || t.provider === 'PAYPAL_INVOICE',
  DUPLICATE_PAYMENT: (t, p) => p.outgoing || t.type === 'DEPOSIT',
  REFUND_NOT_RECEIVED: (t, p) => p.outgoing,
  UNRECOGNIZED_TRANSACTION: (t, p) => p.outgoing,
};

const STOP_WORDS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'my', 'friend', 'brother', 'sister', 'alhaji', 'alhaja', 'mallam', 'malam', 'oga', 'madam']);
const tokens = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP_WORDS.has(w));

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

function scoreName(claim, cp) {
  if (!claim || !cp) return null;
  const c = claim.trim().toLowerCase();
  if ((cp.account_id && c === cp.account_id.toLowerCase()) || (cp.email && c === cp.email.toLowerCase())) {
    return { points: 40, reason: `${cp.account_id && c === cp.account_id.toLowerCase() ? 'Account ID' : 'Email'} matches` };
  }
  const want = tokens(claim);
  const have = [...tokens(cp.name), ...tokens(cp.email?.split('@')[0])];
  if (!want.length || !have.length) return { points: 0, reason: null };
  if (want.every((w) => have.includes(w))) return { points: want.length > 1 ? 35 : 30, reason: `"${claim}" matches ${cp.name}` };
  if (want.some((w) => have.includes(w))) return { points: 25, reason: `"${claim}" partly matches ${cp.name}` };
  if (want.some((w) => w.length >= 4 && have.some((h) => editDistance(w, h) <= 1))) {
    return { points: 18, reason: `"${claim}" is close to ${cp.name}` };
  }
  return { points: -15, reason: null }; // they named someone else
}

function scoreAmount(claimCents, claimCurrency, tx) {
  if (claimCents == null) return null;
  if (claimCurrency && claimCurrency !== tx.currency) return { points: 0, reason: null };
  if (claimCents === tx.amount) return { points: 45, reason: `Amount is ${formatMoney(tx.amount, tx.currency)}` };
  if (Math.abs(claimCents - tx.amount) <= Math.max(100, claimCents * 0.05)) {
    return { points: 15, reason: `Amount ${formatMoney(tx.amount, tx.currency)} is close to what you said` };
  }
  return { points: -20, reason: null }; // they told us the amount, and this isn't it
}

function scoreDate(range, txDay) {
  if (!range) return null;
  if (txDay >= range.from && txDay <= range.to) return { points: 20, reason: `Made ${range.label ?? 'on the day you said'}`, dateMatch: true };
  const dayMs = 86_400_000;
  const gap = Math.min(Math.abs(Date.parse(txDay) - Date.parse(range.from)), Math.abs(Date.parse(txDay) - Date.parse(range.to))) / dayMs;
  // Never pass off a payment from another day as a match: say plainly that the day is different.
  const warning = `Made on ${formatDay(txDay)}, not ${range.label ?? 'the day you said'} (${describeRange(range)})`;
  if (gap <= 1) return { points: 8, reason: null, warning, dateMatch: false };
  return { points: -15, reason: null, warning, dateMatch: false };
}

export function candidateDisplay(tx, walletId, timezone) {
  const { outgoing, counterparty } = perspective(tx, walletId);
  return {
    reference: tx.reference,
    kind: kindLabel(tx, outgoing),
    direction: tx.type === 'DEPOSIT' ? 'IN' : outgoing ? 'OUT' : 'IN',
    counterparty: counterparty.name ?? 'Unknown',
    amount: tx.amount,
    currency: tx.currency,
    amount_display: formatMoney(tx.amount, tx.currency),
    channel: channelLabel(tx),
    created_at: tx.created_at,
    when_display: formatLocal(tx.created_at, timezone),
    day_display: formatDay(localDate(tx.created_at, timezone)),
    note: tx.note ?? null,
  };
}

/**
 * @param extraction  stage 1 output
 * @param transactions  the customer's own transactions (from the read-only FastPay reader)
 * @param exclude  references the customer already said are not the one
 */
export function findCandidates({ extraction, walletId, transactions, timezone, now = new Date(), exclude = [] }) {
  const ex = extraction;
  const fits = FITS[ex.complaint_type] ?? (() => true);
  const skip = new Set(exclude);
  const scored = [];

  for (const tx of transactions) {
    if (skip.has(tx.reference)) continue;
    const p = perspective(tx, walletId);
    // A receiver is never shown transfers that didn't reach them, except when that is exactly
    // what they are asking about ("Musa says he sent me money"), and even then only payments
    // that actually left the sender. Failed attempts are the sender's business.
    if (tx.type === 'TRANSFER' && !p.outgoing && !tx.credited_at && (ex.complaint_type !== 'EXPECTED_MONEY_NOT_RECEIVED' || !tx.debited_at)) continue;
    if (!fits(tx, p)) continue;

    const date = scoreDate(ex.date_range, localDate(tx.created_at, timezone));
    const parts = [scoreAmount(ex.amount_cents, ex.currency, tx), scoreName(ex.counterparty, p.counterparty), date];
    let score = parts.reduce((s, x) => s + (x?.points ?? 0), 0);
    const reasons = parts.map((x) => x?.reason).filter(Boolean);
    const warnings = parts.map((x) => x?.warning).filter(Boolean);

    if (ex.complaint_type !== 'OTHER') score += 5; // the kind of transaction fits the complaint
    if (ex.channel === 'PAYPAL' && channelLabel(tx) === 'PayPal') score += 5;
    if (ex.channel === 'FASTPAY_BALANCE' && tx.provider === 'FASTPAY') score += 5;
    if (!ex.date_range && now - new Date(tx.created_at) < 7 * 86_400_000) score += 3; // recent first when no date given

    if (score >= MIN_SCORE && reasons.length) scored.push({ tx, score, reasons, warnings, dateMismatch: date?.dateMatch === false });
  }

  scored.sort((a, b) => b.score - a.score || b.tx.created_at.localeCompare(a.tx.created_at));
  const top = scored[0]?.score ?? 0;
  // A payment from another day is only worth showing if nothing on the right day matches better.
  const bestOnDay = Math.max(-Infinity, ...scored.filter((c) => !c.dateMismatch && ex.date_range).map((c) => c.score));
  return scored
    .filter((c) => c.score >= top - 40)
    .filter((c) => !c.dateMismatch || c.score > bestOnDay)
    .slice(0, MAX_CANDIDATES)
    .map((c) => ({
      reference: c.tx.reference,
      score: c.score,
      reasons: c.reasons,
      warnings: c.warnings,
      date_mismatch: c.dateMismatch,
      display: candidateDisplay(c.tx, walletId, timezone),
    }));
}

/** What to ask when we can't search yet, or found nothing. */
export function followUpQuestion(extraction, { searched }) {
  const ex = extraction;
  const needsPerson = ['RECIPIENT_NOT_CREDITED', 'EXPECTED_MONEY_NOT_RECEIVED', 'OTHER'].includes(ex.complaint_type);
  const missing = [];
  if (ex.amount_cents == null) missing.push('how much it was');
  if (!ex.counterparty && needsPerson) missing.push(ex.complaint_type === 'EXPECTED_MONEY_NOT_RECEIVED' ? 'who sent it' : 'who it was to');
  if (!ex.date_range) missing.push('roughly when it happened (for example "yesterday" or "12 Nov")');

  const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0]);
  if (!searched) return `I need a little more to find the payment. Could you tell me ${list(missing)}?`;

  const said = [
    ex.amount_cents != null && `of ${formatMoney(ex.amount_cents, ex.currency ?? 'USD')}`,
    ex.counterparty && (ex.complaint_type === 'EXPECTED_MONEY_NOT_RECEIVED' ? `from ${ex.counterparty}` : `to ${ex.counterparty}`),
    ex.date_range?.label,
  ].filter(Boolean);
  const intro = said.length ? `I couldn't find a payment ${said.join(' ')} in your FastPay history.` : "I couldn't find a matching payment in your FastPay history.";
  return missing.length
    ? `${intro} Could you tell me ${list(missing)}?`
    : `${intro} Could you check the amount, the name, or the day, and tell me again?`;
}

/** At least one detail to search with. */
export const canSearch = (ex) => ex.amount_cents != null || Boolean(ex.counterparty) || Boolean(ex.date_range) || ['TOP_UP_NOT_REFLECTED', 'CASH_OUT_NOT_RECEIVED'].includes(ex.complaint_type);
