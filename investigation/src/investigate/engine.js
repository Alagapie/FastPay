// Stage 4: Investigate the confirmed transaction.
//
// Rules-based and evidence-only. All records come through FastPay's read-only investigation window
// (src/fastpay/api.js), limited to the complaining customer. Every check records its source:
//   - FastPay's transaction record (debited_at / credited_at / reversed_at)
//   - the customer's OWN wallet only (does their balance add up to their transactions?)
//   - PayPal's own records, read live by FastPay (which keeps the keys): orders, captures, payouts, invoices
// FastPay's status labels are never used to decide the finding. If a needed record can't be
// read, the finding is INCONCLUSIVE rather than a guess.
import { FINDINGS } from './findings.js';
import { capitalize, formatMoney, valueToCents } from '../util.js';
import { formatLocal } from '../understand/dates.js';

export const KINDS = {
  INTERNAL_TRANSFER: 'Transfer from FastPay balance',
  PAYPAL_TRANSFER: 'Transfer paid with PayPal',
  PAYPAL_TOP_UP: 'Add money with PayPal',
  TEST_TOP_UP: 'Test bank deposit',
  PAYPAL_REQUEST: 'Payment request paid through a PayPal invoice',
  PAYPAL_CASH_OUT: 'Cash out to PayPal',
};

export function classifyTransaction(tx) {
  if (tx.type === 'TRANSFER') return tx.provider === 'PAYPAL' ? 'PAYPAL_TRANSFER' : 'INTERNAL_TRANSFER';
  if (tx.type === 'WITHDRAWAL') return 'PAYPAL_CASH_OUT';
  if (tx.provider === 'PAYPAL') return 'PAYPAL_TOP_UP';
  if (tx.provider === 'PAYPAL_INVOICE') return 'PAYPAL_REQUEST';
  return 'TEST_TOP_UP';
}

// ---- Evidence log ---------------------------------------------------------------

function createLog(now) {
  const evidence = [];
  const checks = [];
  const discrepancies = [];
  const trail = [];
  return {
    evidence,
    checks,
    discrepancies,
    trail,
    add(source, label, data, meta = {}) {
      const id = `E${evidence.length + 1}`;
      evidence.push({
        id,
        source,
        label,
        retrieved_at: meta.retrieved_at ?? now.toISOString(),
        ...(meta.debug_id ? { paypal_debug_id: meta.debug_id } : {}),
        data,
      });
      return id;
    },
    /** answer: YES | NO | COMPLETED | PENDING | NOT_CHARGED | NOT_PAID | FAILED | REFUNDED | NOT_FOUND | UNKNOWN | N/A | INFO */
    check(question, answer, detail, ids = []) {
      checks.push({ id: `C${checks.length + 1}`, question, answer, detail, evidence: ids.filter(Boolean) });
    },
    flag(code, detail, ids = []) {
      discrepancies.push({ code, detail, evidence: ids.filter(Boolean) });
    },
    /** state: done | missing (not recorded) | pending | returned | unknown (could not be checked) */
    step(label, at, state, source) {
      trail.push({ step: label, at: at ?? null, state, source });
    },
  };
}

// ---- Who is who, from the customer's point of view --------------------------------

function party(isYou, name) {
  return isYou
    ? { isYou: true, name: name ?? 'you', subj: 'you', obj: 'you', pos: 'your', be: 'were' }
    : { isYou: false, name, subj: name, obj: name, pos: `${name}'s`, be: 'was' };
}

function parties(tx, kind, viewerWalletId) {
  const you = (w) => w != null && w === viewerWalletId;
  switch (kind) {
    case 'INTERNAL_TRANSFER':
    case 'PAYPAL_TRANSFER':
      return { payer: party(you(tx.sender_wallet_id), tx.sender_name), payee: party(you(tx.receiver_wallet_id), tx.receiver_name) };
    case 'PAYPAL_REQUEST':
      return { payer: party(false, tx.external_account), payee: party(you(tx.receiver_wallet_id), tx.receiver_name) };
    case 'PAYPAL_CASH_OUT':
      return { payer: party(you(tx.sender_wallet_id), tx.sender_name), payee: party(false, `the PayPal account ${tx.external_account}`) };
    default: // top-ups: the customer pays into their own wallet
      return { payer: party(you(tx.receiver_wallet_id), tx.receiver_name), payee: party(you(tx.receiver_wallet_id), tx.receiver_name) };
  }
}

// ---- Summaries of the records we read --------------------------------------------

function transactionEvidence(tx) {
  return {
    reference: tx.reference,
    type: tx.type,
    provider: tx.provider,
    amount: formatMoney(tx.amount, tx.currency),
    amount_cents: tx.amount,
    currency: tx.currency,
    recorded_status: tx.status,
    created_at: tx.created_at,
    debited_at: tx.debited_at,
    credited_at: tx.credited_at,
    reversed_at: tx.reversed_at,
    completed_at: tx.completed_at,
    sender: tx.sender_name ? { name: tx.sender_name, account_id: tx.sender_account_id } : null,
    receiver: tx.receiver_name ? { name: tx.receiver_name, account_id: tx.receiver_account_id } : null,
    external_account: tx.external_account,
    paypal_reference: tx.provider_ref,
    capture_id: tx.capture_id,
    note: tx.note,
  };
}

const money = (m) => (m ? { value: m.value, currency: m.currency_code ?? m.currency } : null);

const orderSummary = (d) => {
  const pu = d?.purchase_units?.[0] ?? {};
  return {
    order_id: d?.id,
    status: d?.status,
    create_time: d?.create_time,
    update_time: d?.update_time,
    amount: money(pu.amount),
    description: pu.description ?? null,
    captures: (pu.payments?.captures ?? []).map((c) => ({ id: c.id, status: c.status, amount: money(c.amount), create_time: c.create_time, update_time: c.update_time })),
    refunds: (pu.payments?.refunds ?? []).map((r) => ({ id: r.id, status: r.status, amount: money(r.amount), create_time: r.create_time })),
  };
};

const captureSummary = (c) => ({
  capture_id: c?.id,
  status: c?.status,
  status_reason: c?.status_details?.reason ?? null,
  amount: money(c?.amount),
  final_capture: c?.final_capture,
  create_time: c?.create_time,
  update_time: c?.update_time,
});

const payoutSummary = (d) => ({
  batch_id: d?.batch_header?.payout_batch_id,
  batch_status: d?.batch_header?.batch_status,
  items: (d?.items ?? []).map((i) => ({
    payout_item_id: i.payout_item_id,
    transaction_id: i.transaction_id ?? null,
    transaction_status: i.transaction_status,
    amount: money(i.payout_item?.amount),
    receiver: i.payout_item?.receiver,
    time_processed: i.time_processed ?? null,
    error: i.errors?.name ?? i.errors?.message ?? null,
  })),
});

const invoiceSummary = (d) => ({
  invoice_id: d?.id,
  status: d?.status,
  invoice_number: d?.detail?.invoice_number,
  amount: money(d?.amount),
  paid_amount: money(d?.payments?.paid_amount),
  payments: (d?.payments?.transactions ?? []).map((p) => ({ payment_id: p.payment_id, date: p.payment_date, amount: money(p.amount), method: p.method })),
});

// ---- Shared helpers ----------------------------------------------------------------

async function readPayPal(c, what, fn, id, source, label, summarize) {
  const r = await fn(id);
  c.onPayPalRead?.({ what, id, ok: r.ok, status: r.status, debug_id: r.debug_id ?? null, error: r.error ?? null });
  const data = r.ok ? summarize(r.data) : { error: r.error, http_status: r.status || null };
  return { ...r, evId: c.log.add(source, label, data, { retrieved_at: r.retrieved_at, debug_id: r.debug_id }) };
}

function amountMatches(m, tx) {
  if (!m) return null;
  const cur = m.currency_code ?? m.currency;
  return valueToCents(m.value) === tx.amount && cur === tx.currency;
}

async function reconcileWallets(c) {
  const { tx, kind, P, log } = c;
  const roles =
    kind === 'INTERNAL_TRANSFER'
      ? [['payer', tx.sender_wallet_id], ['payee', tx.receiver_wallet_id]]
      : kind === 'PAYPAL_CASH_OUT'
        ? [['payer', tx.sender_wallet_id]]
        : [['payee', tx.receiver_wallet_id]];
  // Only the customer's OWN wallet is ever checked. The other person's account is never opened:
  // delivery to them is confirmed from FastPay's own record of this payment (or PayPal's status),
  // the same way a bank can only confirm its side of a transfer.
  const own = roles.filter(([role]) => P[role].isYou);
  const out = {};
  const seen = new Set();
  for (const [role, walletId] of own) {
    if (walletId == null || seen.has(walletId)) continue;
    seen.add(walletId);
    const r = await c.fastpay.reconcileWallet(walletId);
    if (!r) continue;
    const who = P[role];
    const fm = (x) => formatMoney(x, r.currency);
    const evId = log.add('FASTPAY_WALLETS', 'Your FastPay wallet', {
      recorded_balance: fm(r.recorded_balance),
      expected_balance: fm(r.expected_balance),
      credits_total: fm(r.credits),
      debits_total: fm(r.debits),
      returns_total: fm(r.returns),
      transactions_counted: r.transactions_counted,
      matches: r.matches,
      difference: fm(r.difference),
    });
    log.check(
      'Does your FastPay balance match your transaction history?',
      r.matches ? 'YES' : 'NO',
      r.matches
        ? `Your balance of ${fm(r.recorded_balance)} equals all your credits minus debits plus returns.`
        : `Your balance is ${fm(r.recorded_balance)}, but your transactions add up to ${fm(r.expected_balance)} (a difference of ${fm(r.difference)}).`,
      [evId],
    );
    if (!r.matches) log.flag('WALLET_BALANCE_MISMATCH', `The customer's wallet balance differs from their transactions by ${fm(r.difference)}.`, [evId]);
    out[role] = { ...r, evId };
  }
  return out;
}

/** Timeline label for the credit leg: "Recipient wallet credit", or "Credit to your wallet". */
const creditLabel = (P) => (P.payee.isYou ? 'Credit to your wallet' : 'Recipient wallet credit');

/** The credit leg, from FastPay's wallet ledger record of THIS payment, not from the recipient's account. */
function creditCheck(c, ids) {
  const { tx, log, P, amt, t } = c;
  log.check(
    `Has FastPay's wallet ledger recorded the credit to ${P.payee.pos} FastPay wallet?`,
    tx.credited_at ? 'YES' : 'NO',
    tx.credited_at
      ? `FastPay's record of this payment shows ${amt} was credited at ${t(tx.credited_at)}.`
      : "FastPay's record of this payment has no wallet credit recorded yet.",
    ids,
  );
}

/** FastPay's own ledger marked the payment FAILED after the money was taken (an explicit credit failure). */
const fastpayFailedAfterDebit = (tx) => tx.status === 'FAILED' && Boolean(tx.debited_at) && !tx.credited_at && !tx.reversed_at;

/** Why a payment is pending, in words the customer can read. Only ever built from what the evidence shows. */
function pending(c, reason, says, extra = {}) {
  c.facts.pending_reason = reason;
  c.facts.pending_says = says;
  return { reason, says, ...extra };
}

// ---- Internal transfer (FastPay balance -> FastPay wallet) --------------------------

function decideInternal(c) {
  const { tx, log, txEv, P, amt, t } = c;
  const payerEv = c.recon.payer?.evId;
  const payeeEv = c.recon.payee?.evId;
  log.check(`Was ${P.payer.pos} FastPay balance debited?`, tx.debited_at ? 'YES' : 'NO',
    tx.debited_at ? `${amt} was debited at ${t(tx.debited_at)}.` : 'FastPay has no debit for this payment.', [txEv, payerEv]);
  creditCheck(c, [txEv, payeeEv]);
  log.check(`Was the money returned to ${P.payer.obj}?`, tx.reversed_at ? 'YES' : 'NO',
    tx.reversed_at ? `Returned at ${t(tx.reversed_at)}.` : 'No return is recorded.', [txEv]);
  if (fastpayFailedAfterDebit(tx)) {
    log.check('Did FastPay record the credit as failed?', 'YES', "FastPay's ledger marks this payment as failed after the debit, with no credit and no return.", [txEv]);
  }

  log.step('Payment started', tx.created_at, 'done', 'FastPay');
  if (!tx.debited_at) {
    log.step(`Debit from ${P.payer.pos} balance`, null, 'missing', 'FastPay');
    return { code: 'PAYMENT_FAILED', explanation: `The payment was not completed. ${capitalize(P.payer.pos)} balance was never debited, so no money was taken, and no credit to ${P.payee.pos} wallet was due.` };
  }
  log.step(`Debit from ${P.payer.pos} balance`, tx.debited_at, 'done', 'FastPay');
  log.step(creditLabel(P), tx.credited_at, tx.credited_at ? 'done' : 'missing', 'FastPay');
  if (tx.reversed_at) log.step(`Return to ${P.payer.pos} balance`, tx.reversed_at, 'returned', 'FastPay');

  if (tx.credited_at && tx.reversed_at) {
    log.flag('CREDITED_AND_RETURNED', 'The payment was both credited to the recipient and returned to the payer.', [txEv]);
    return { code: 'INVESTIGATION_INCONCLUSIVE', explanation: `FastPay's records say the money was both credited to ${P.payee.obj} and returned to ${P.payer.obj}, which should never happen. This needs a manual review.` };
  }
  if (tx.credited_at) {
    return { code: 'PAYMENT_COMPLETED', explanation: `${capitalize(P.payer.pos)} balance was debited ${amt} at ${t(tx.debited_at)}, and FastPay recorded the credit to ${P.payee.pos} wallet at ${t(tx.credited_at)}.` };
  }
  if (tx.reversed_at) {
    return { code: 'PAYMENT_REFUNDED', explanation: `${capitalize(P.payer.pos)} balance was debited ${amt} at ${t(tx.debited_at)}. The payment did not complete, no credit to ${P.payee.pos} wallet was recorded, and the money was returned to ${P.payer.pos} balance at ${t(tx.reversed_at)}.` };
  }
  if (fastpayFailedAfterDebit(tx)) {
    return { code: 'PAYOUT_FAILED', amountAtIssue: tx.amount, explanation: `${capitalize(P.payer.pos)} balance was debited ${amt} at ${t(tx.debited_at)}. FastPay recorded the credit to ${P.payee.pos} wallet as failed, and the money has not been returned.` };
  }
  if (c.recent(tx.debited_at)) {
    return {
      code: 'PAYMENT_PENDING',
      pending: pending(c, 'FASTPAY_PROCESSING', 'The money has left the balance, and FastPay is still processing the transfer'),
      explanation: `${capitalize(P.payer.pos)} balance was debited ${amt} at ${t(tx.debited_at)}. FastPay has not recorded the credit to ${P.payee.pos} wallet yet, and the payment is only ${c.minutesSince(tx.debited_at)} minutes old.`,
    };
  }
  return {
    code: 'DEBITED_NOT_CREDITED',
    amountAtIssue: tx.amount,
    explanation: `${capitalize(P.payer.pos)} balance was debited ${amt} at ${t(tx.debited_at)}, but FastPay has not recorded the credit to ${P.payee.pos} wallet ${c.elapsed(tx.debited_at)} later. The money has not been returned to ${P.payer.obj}.`,
  };
}

// ---- PayPal checkout (top-up, or transfer paid with PayPal) -------------------------

// PayPal capture status -> what it means for the money.
const CAPTURE_STATE = { COMPLETED: 'CHARGED', PARTIALLY_REFUNDED: 'CHARGED', REFUNDED: 'REFUNDED', PENDING: 'PENDING', DECLINED: 'NOT_CHARGED', FAILED: 'NOT_CHARGED' };
// FastPay finishes approved PayPal orders in the background and gives up after 3 hours.
const CAPTURE_WINDOW_MINUTES = 180;
// PayPal's reasons for holding a capture (status_details.reason), in plain words.
const HOLD_REASONS = {
  PENDING_REVIEW: 'PayPal is reviewing the payment and has not provided a final completion status',
  ECHECK: 'The payment was made by eCheck, and PayPal has not yet confirmed that it has cleared. eChecks can take several days',
  BUYER_COMPLAINT: 'PayPal is holding the payment because a complaint was raised with PayPal',
  VERIFICATION_REQUIRED: 'PayPal is holding the payment until an account verification is finished',
};

async function decidePayPalCheckout(c) {
  const { tx, log, txEv, P, amt, t } = c;
  let state = 'UNKNOWN';
  let reason = '';
  let cap = null;
  let order = null;
  const ids = [txEv];

  if (!tx.provider_ref) {
    reason = 'FastPay has no PayPal order ID for this payment';
  } else {
    order = await readPayPal(c, 'order', c.paypal.getOrder, tx.provider_ref, 'PAYPAL_ORDERS', `PayPal order ${tx.provider_ref}`, orderSummary);
    ids.push(order.evId);
    if (order.ok) {
      c.facts.order_status = order.data?.status ?? null;
      const caps = order.data?.purchase_units?.[0]?.payments?.captures ?? [];
      const orderCap = (tx.capture_id && caps.find((x) => x.id === tx.capture_id)) || caps[0] || null;
      const refsMatch = (order.data?.id ?? tx.provider_ref) === tx.provider_ref && !(tx.capture_id && caps.length && !caps.some((x) => x.id === tx.capture_id));
      log.check("Do PayPal's references match FastPay's record?", refsMatch ? 'YES' : 'NO',
        refsMatch
          ? `PayPal order ${tx.provider_ref}${tx.capture_id ? ` and capture ${tx.capture_id}` : ''} match FastPay's record.`
          : `FastPay recorded order ${tx.provider_ref}${tx.capture_id ? ` and capture ${tx.capture_id}` : ''}, but PayPal returned ${order.data?.id}${caps.length ? ` with capture(s) ${caps.map((x) => x.id).join(', ')}` : ''}.`,
        [txEv, order.evId]);
      if (!refsMatch) log.flag('CAPTURE_ID_MISMATCH', `FastPay recorded capture ${tx.capture_id}, but PayPal's order has ${caps.map((x) => x.id).join(', ')}.`, [txEv, order.evId]);

      const captureId = tx.capture_id || orderCap?.id;
      if (captureId) {
        const live = await readPayPal(c, 'capture', c.paypal.getCapture, captureId, 'PAYPAL_PAYMENTS', `PayPal capture ${captureId}`, captureSummary);
        ids.push(live.evId);
        cap = live.ok ? live.data : orderCap; // the live capture shows refunds made after the order closed
      }
      const approvedAt = order.data?.update_time ?? tx.created_at;
      if (cap) {
        state = CAPTURE_STATE[cap.status] ?? 'UNKNOWN';
        reason = `capture ${cap.id} is ${cap.status}`;
      } else if (order.data?.status === 'APPROVED' && c.minutesSince(approvedAt) < CAPTURE_WINDOW_MINUTES) {
        state = 'AWAITING_CAPTURE';
        reason = 'the payer approved the PayPal checkout, but it has not been captured yet';
      } else if (order.data?.status === 'COMPLETED') {
        reason = 'PayPal shows the order as completed but returned no capture';
      } else {
        state = 'NOT_CHARGED';
        reason = `the PayPal checkout was never completed (order status ${order.data?.status ?? 'unknown'})`;
      }
    } else if (order.status === 404) {
      state = 'NOT_CHARGED';
      reason = 'PayPal has no record of this order';
    } else {
      reason = `PayPal could not be reached (${order.error})`;
    }
  }

  const chargedMoney = cap?.amount ?? null;
  const chargedAt = cap?.create_time ?? cap?.update_time ?? tx.debited_at ?? null;
  const charged = ['CHARGED', 'REFUNDED'].includes(state);
  c.facts.charged_at = charged ? chargedAt : null;
  c.facts.paypal_status = cap?.status ?? null;
  const holdReason = cap?.status_details?.reason ?? cap?.status_reason ?? null; // raw PayPal capture, or its summary
  c.facts.paypal_hold_reason = holdReason;
  c.facts.paypal_unreachable = state === 'UNKNOWN' && Boolean(order) && !order.ok;
  c.facts.paypal_state = state;
  c.facts.fastpay_recorded_charge = Boolean(tx.debited_at);
  const amountOk = amountMatches(chargedMoney, tx);
  const chargedAmt = chargedMoney ? formatMoney(valueToCents(chargedMoney.value), chargedMoney.currency_code ?? chargedMoney.currency) : amt;

  // 1. What status did PayPal return?
  log.check(
    `What status did PayPal return for ${P.payer.pos} payment?`,
    { CHARGED: 'COMPLETED', REFUNDED: 'REFUNDED', PENDING: 'PENDING', AWAITING_CAPTURE: 'PENDING', NOT_CHARGED: 'NOT_CHARGED' }[state] ?? 'UNKNOWN',
    state === 'UNKNOWN' ? `Could not be confirmed: ${reason}.` : `${capitalize(reason)}${chargedAt && charged ? `, completed at ${t(chargedAt)}` : ''}.`,
    ids.slice(1),
  );
  // 2. Do amount, currency and recipient match?
  if (chargedMoney) {
    log.check("Do the amount and currency PayPal charged match FastPay's record?", amountOk ? 'YES' : 'NO',
      amountOk ? `Both show ${amt}.` : `PayPal charged ${chargedAmt}; FastPay recorded ${amt}.`, ids);
    if (!amountOk) log.flag('AMOUNT_MISMATCH', `PayPal charged ${chargedAmt}; FastPay recorded ${amt}.`, ids);
  }
  const orderDescription = order?.ok ? order.data?.purchase_units?.[0]?.description : null;
  let recipientOk = null;
  if (c.kind === 'PAYPAL_TRANSFER' && orderDescription && tx.receiver_name) {
    recipientOk = orderDescription.includes(tx.receiver_name);
    log.check("Does the recipient on PayPal's order match FastPay's record?", recipientOk ? 'YES' : 'NO',
      recipientOk ? `PayPal's order is for a payment to ${tx.receiver_name}.` : `PayPal's order says "${orderDescription}", but FastPay recorded the recipient as ${tx.receiver_name}.`, [txEv, order.evId]);
    if (!recipientOk) log.flag('RECIPIENT_MISMATCH', `PayPal's order description "${orderDescription}" does not name ${tx.receiver_name}.`, [txEv, order.evId]);
  }
  // 3. Did FastPay receive and accept PayPal's payment?
  log.check("Did FastPay receive and accept PayPal's payment?", tx.debited_at ? 'YES' : 'NO',
    tx.debited_at ? `FastPay recorded the PayPal payment at ${t(tx.debited_at)}.` : 'FastPay has not recorded the PayPal payment.', [txEv]);
  // 4. Has FastPay's wallet ledger recorded the credit?
  creditCheck(c, [txEv, c.recon.payee?.evId]);
  if (fastpayFailedAfterDebit(tx)) {
    log.check('Did FastPay record the wallet credit as failed?', 'YES', "FastPay's ledger marks this payment as failed after accepting PayPal's payment, with no credit recorded.", [txEv]);
  }
  if (state === 'REFUNDED' || cap?.status === 'PARTIALLY_REFUNDED') {
    log.check('Did PayPal refund the payment?', 'YES', `The capture status is ${cap.status}.`, ids.slice(-1));
  }

  log.step('Payment started', tx.created_at, 'done', 'FastPay');
  if (charged) log.step('PayPal payment completed', chargedAt, 'done', 'PayPal');
  else if (state === 'PENDING') log.step('Payment processing', cap?.create_time ?? cap?.update_time ?? null, 'pending', 'PayPal');
  else if (state === 'AWAITING_CAPTURE') log.step('Payment processing', order?.data?.update_time ?? null, 'pending', 'PayPal');
  else if (state === 'NOT_CHARGED') log.step('PayPal payment', null, 'missing', 'PayPal');
  else log.step('PayPal payment status', null, 'unknown', 'PayPal');
  log.step(creditLabel(P), tx.credited_at, tx.credited_at ? 'done' : 'missing', 'FastPay');
  if (state === 'REFUNDED') log.step('Refunded by PayPal', cap?.update_time ?? null, 'returned', 'PayPal');

  if (state === 'UNKNOWN') {
    return {
      code: 'INVESTIGATION_INCONCLUSIVE',
      explanation: `PayPal's status for this payment could not be confirmed: ${reason}. FastPay's own records show ${tx.credited_at ? `the credit to ${P.payee.pos} wallet was recorded at ${t(tx.credited_at)}` : `no credit to ${P.payee.pos} wallet recorded yet`}.`,
    };
  }
  if (state === 'NOT_CHARGED') {
    if (tx.credited_at) {
      log.flag('CREDITED_WITHOUT_PAYPAL_CHARGE', `FastPay credited ${amt}, but PayPal shows no completed charge.`, ids);
      return { code: 'INVESTIGATION_INCONCLUSIVE', explanation: `FastPay recorded a credit of ${amt} to ${P.payee.pos} wallet, but PayPal shows no completed charge (${reason}). This needs a manual review.` };
    }
    return { code: 'PAYMENT_FAILED', explanation: `PayPal did not complete the payment: ${reason}. No money was taken, and no wallet credit was due.` };
  }
  if (state === 'REFUNDED') {
    if (tx.credited_at) log.flag('CREDITED_AND_REFUNDED', `PayPal refunded the charge, but FastPay also credited ${amt}.`, ids);
    return { code: 'PAYMENT_REFUNDED', explanation: `PayPal charged ${P.payer.obj} ${chargedAmt} at ${t(chargedAt)} and later refunded it in full (capture status REFUNDED).${tx.credited_at ? ` FastPay had also recorded a credit to ${P.payee.pos} wallet at ${t(tx.credited_at)}.` : ''}` };
  }
  if (state === 'PENDING' || state === 'AWAITING_CAPTURE') {
    if (tx.credited_at) {
      log.flag('CREDITED_BEFORE_PAYPAL_COMPLETED', `FastPay credited ${amt}, but PayPal has not completed the payment (${reason}).`, ids);
      return { code: 'INVESTIGATION_INCONCLUSIVE', explanation: `FastPay recorded a credit to ${P.payee.pos} wallet, but PayPal has not completed the payment yet (${reason}). This needs a manual review.` };
    }
    const why = state === 'AWAITING_CAPTURE'
      ? pending(c, 'AWAITING_CAPTURE', 'You approved the payment at PayPal, but it has not been completed yet, so PayPal has not taken the money yet')
      : pending(c, 'PAYPAL_CAPTURE_PENDING', HOLD_REASONS[holdReason] ?? 'PayPal has not provided a final completion status', { paypal_reason: holdReason });
    return {
      code: 'PAYMENT_PENDING',
      pending: why,
      explanation: `${capitalize(reason)}${holdReason ? ` (PayPal reason ${holdReason})` : ''}. PayPal has not completed the payment, and FastPay has not recorded the credit to ${P.payee.pos} wallet.`,
    };
  }
  // PayPal completed the payment (CHARGED).
  if (amountOk === false || recipientOk === false) {
    const diff = amountOk === false ? Math.abs(valueToCents(chargedMoney.value) - tx.amount) : 0;
    return {
      code: 'INVESTIGATION_INCONCLUSIVE',
      amountAtIssue: diff,
      explanation: amountOk === false
        ? `PayPal charged ${P.payer.obj} ${chargedAmt}, but FastPay recorded ${amt} (a difference of ${formatMoney(diff, tx.currency)}). The records disagree and need a manual review.`
        : `PayPal's order and FastPay's record name different recipients. The records disagree and need a manual review.`,
    };
  }
  if (tx.credited_at) {
    return { code: 'PAYMENT_COMPLETED', explanation: `PayPal completed ${P.payer.pos} ${amt} payment at ${t(chargedAt)} (${reason}), and FastPay's wallet ledger recorded the credit to ${P.payee.pos} wallet at ${t(tx.credited_at)}.` };
  }
  if (fastpayFailedAfterDebit(tx)) {
    return {
      code: 'PAYOUT_FAILED',
      amountAtIssue: tx.amount,
      explanation: `PayPal completed ${P.payer.pos} ${amt} payment at ${t(chargedAt)} (${reason}), and FastPay accepted it, but FastPay recorded the credit to ${P.payee.pos} wallet as failed. PayPal has not refunded it.`,
    };
  }
  if (!tx.debited_at) log.flag('FASTPAY_CHARGE_NOT_RECORDED', `PayPal completed ${reason}, but FastPay has not recorded the payment.`, ids);
  return {
    code: 'PAYMENT_CAPTURED_WALLET_NOT_CREDITED',
    amountAtIssue: tx.amount,
    explanation: `PayPal completed ${P.payer.pos} ${amt} payment at ${t(chargedAt)} (${reason}), ${tx.debited_at ? 'and FastPay accepted it' : 'but FastPay has not recorded the payment'}. FastPay's wallet ledger has no credit to ${P.payee.pos} wallet recorded ${c.elapsed(chargedAt)} later. PayPal has not refunded it.`,
  };
}

// ---- Payment request paid through a PayPal invoice -----------------------------------

const INVOICE_STATE = {
  PAID: 'PAID', MARKED_AS_PAID: 'PAID', PARTIALLY_PAID: 'PENDING', PAYMENT_PENDING: 'PENDING',
  REFUNDED: 'REFUNDED', PARTIALLY_REFUNDED: 'REFUNDED', MARKED_AS_REFUNDED: 'REFUNDED',
  DRAFT: 'UNPAID', SENT: 'UNPAID', SCHEDULED: 'UNPAID', UNPAID: 'UNPAID', CANCELLED: 'CANCELLED',
};

async function decideInvoice(c) {
  const { tx, log, txEv, P, amt, t } = c;
  log.step('Request created', tx.created_at, 'done', 'FastPay');
  if (!tx.provider_ref) {
    log.check('Was the request sent through PayPal?', 'NO', 'FastPay has no PayPal invoice ID for this request.', [txEv]);
    log.step('Sent as a PayPal invoice', null, 'missing', 'PayPal');
    return { code: 'PAYMENT_FAILED', explanation: `The request was never sent through PayPal, so ${P.payer.subj} could not pay it. No money moved.` };
  }
  const inv = await readPayPal(c, 'invoice', c.paypal.getInvoice, tx.provider_ref, 'PAYPAL_INVOICING', `PayPal invoice ${tx.provider_ref}`, invoiceSummary);
  if (!inv.ok && inv.status !== 404) {
    c.facts.paypal_unreachable = true;
    log.check('What status did PayPal return for the invoice?', 'UNKNOWN', `Could not be confirmed: ${inv.error}.`, [inv.evId]);
    log.step(`Payment by ${P.payer.subj} through PayPal`, null, 'unknown', 'PayPal');
    log.step(creditLabel(P), tx.credited_at, tx.credited_at ? 'done' : 'missing', 'FastPay');
    return { code: 'INVESTIGATION_INCONCLUSIVE', explanation: `PayPal's invoice status could not be confirmed (${inv.error}). FastPay shows ${tx.credited_at ? `the credit to ${P.payee.pos} wallet was recorded at ${t(tx.credited_at)}` : `no credit to ${P.payee.pos} wallet recorded yet`}.` };
  }
  const status = inv.ok ? inv.data?.status : 'NOT_FOUND';
  const state = inv.ok ? INVOICE_STATE[status] ?? 'UNKNOWN' : 'CANCELLED';
  const paidMoney = inv.data?.payments?.paid_amount ?? (state === 'PAID' ? inv.data?.amount : null);
  const paidAt = inv.data?.payments?.transactions?.at(-1)?.payment_date ?? null;
  c.facts.charged_at = paidAt;
  c.facts.paypal_status = status;
  const amountOk = amountMatches(paidMoney, tx);

  log.check('What status did PayPal return for the invoice?', { PAID: 'COMPLETED', REFUNDED: 'REFUNDED', PENDING: 'PENDING', UNPAID: 'NOT_PAID', CANCELLED: 'NOT_PAID' }[state] ?? 'UNKNOWN',
    inv.ok ? `PayPal shows the invoice as ${status}${paidAt ? `, paid on ${paidAt}` : ''}.` : 'PayPal has no record of this invoice.', [inv.evId]);
  if (paidMoney) {
    log.check("Do the amount and currency paid match FastPay's record?", amountOk ? 'YES' : 'NO',
      amountOk ? `Both show ${amt}.` : `PayPal shows ${paidMoney.value} ${paidMoney.currency_code}; FastPay recorded ${amt}.`, [txEv, inv.evId]);
    if (!amountOk) log.flag('AMOUNT_MISMATCH', `PayPal shows ${paidMoney.value} ${paidMoney.currency_code} paid; FastPay recorded ${amt}.`, [txEv, inv.evId]);
  }
  creditCheck(c, [txEv, c.recon.payee?.evId]);
  const payStep = `Payment by ${P.payer.subj} through PayPal`;
  if (['PAID', 'REFUNDED'].includes(state)) log.step(payStep, paidAt, 'done', 'PayPal');
  else if (['PENDING', 'UNPAID'].includes(state)) log.step(payStep, null, 'pending', 'PayPal');
  else log.step(payStep, null, state === 'UNKNOWN' ? 'unknown' : 'missing', 'PayPal');
  log.step(creditLabel(P), tx.credited_at, tx.credited_at ? 'done' : 'missing', 'FastPay');

  const manual = status === 'MARKED_AS_PAID' ? ' It was marked as paid by hand, outside PayPal checkout.' : '';
  if (state === 'UNKNOWN') return { code: 'INVESTIGATION_INCONCLUSIVE', explanation: `PayPal shows the invoice with an unexpected status (${status}).` };
  if ((state === 'UNPAID' || state === 'CANCELLED' || state === 'PENDING') && tx.credited_at) {
    log.flag('CREDITED_WITHOUT_PAYMENT', `FastPay credited ${amt}, but PayPal shows the invoice as ${status}.`, [txEv, inv.evId]);
    return { code: 'INVESTIGATION_INCONCLUSIVE', explanation: `FastPay recorded a credit to ${P.payee.pos} wallet, but PayPal shows the invoice as ${status}. This needs a manual review.` };
  }
  if (state === 'CANCELLED') {
    return { code: 'PAYMENT_FAILED', explanation: status === 'CANCELLED' ? 'The PayPal invoice was cancelled before anyone paid it. No money moved.' : 'PayPal has no record of this invoice, so it could not be paid. No money moved.' };
  }
  if (state === 'UNPAID') {
    return {
      code: 'PAYMENT_PENDING',
      pending: pending(c, 'AWAITING_PAYER', `${capitalize(P.payer.subj)} has not paid the PayPal invoice yet`),
      explanation: `${capitalize(P.payer.subj)} has not paid the request yet (PayPal shows the invoice as ${status}). No money has moved.`,
    };
  }
  if (state === 'REFUNDED') return { code: 'PAYMENT_REFUNDED', explanation: `The invoice was paid and then refunded (PayPal status ${status}).` };
  if (state === 'PENDING') {
    return {
      code: 'PAYMENT_PENDING',
      pending: pending(c, 'PAYPAL_INVOICE_PROCESSING', 'PayPal shows the invoice payment as still processing'),
      explanation: `PayPal shows the invoice as ${status}. FastPay records the wallet credit once PayPal confirms the full payment.`,
    };
  }
  if (amountOk === false) {
    const diff = Math.abs(valueToCents(paidMoney.value) - tx.amount);
    return { code: 'INVESTIGATION_INCONCLUSIVE', amountAtIssue: diff, explanation: `PayPal shows ${paidMoney.value} ${paidMoney.currency_code} paid, but FastPay recorded ${amt}. The records disagree and need a manual review.` };
  }
  if (tx.credited_at) return { code: 'PAYMENT_COMPLETED', explanation: `${capitalize(P.payer.subj)} paid the PayPal invoice${paidAt ? ` on ${paidAt}` : ''}, and FastPay's wallet ledger recorded the credit of ${amt} to ${P.payee.pos} wallet at ${t(tx.credited_at)}.${manual}` };
  return {
    code: 'PAYMENT_CAPTURED_WALLET_NOT_CREDITED',
    amountAtIssue: tx.amount,
    explanation: `PayPal shows ${P.payer.subj} paid the invoice${paidAt ? ` on ${paidAt}` : ''}, but FastPay's wallet ledger has no credit of ${amt} to ${P.payee.pos} wallet recorded.${manual}`,
  };
}

// ---- Cash out (FastPay balance -> PayPal payout) ---------------------------------

const PAYOUT_STATE = {
  SUCCESS: 'PAID', FAILED: 'NOT_PAID', RETURNED: 'NOT_PAID', BLOCKED: 'NOT_PAID', DENIED: 'NOT_PAID', REFUNDED: 'NOT_PAID',
  REVERSED: 'NOT_PAID', UNCLAIMED: 'UNCLAIMED', PENDING: 'PENDING', ONHOLD: 'PENDING', NEW: 'PENDING',
};

async function decideCashOut(c) {
  const { tx, log, txEv, P, amt, t } = c;
  const payerEv = c.recon.payer?.evId;
  log.check(`Was ${P.payer.pos} FastPay balance debited?`, tx.debited_at ? 'YES' : 'NO',
    tx.debited_at ? `${amt} was debited at ${t(tx.debited_at)}.` : 'FastPay has no debit for this cash out.', [txEv, payerEv]);
  log.step('Cash out started', tx.created_at, 'done', 'FastPay');
  if (!tx.debited_at) {
    log.step(`Debit from ${P.payer.pos} balance`, null, 'missing', 'FastPay');
    return { code: 'PAYMENT_FAILED', explanation: `The cash out was not completed. ${capitalize(P.payer.pos)} balance was not debited, so no money was taken.` };
  }
  log.step(`Debit from ${P.payer.pos} balance`, tx.debited_at, 'done', 'FastPay');
  const returned = () => {
    log.check(`Was the money returned to ${P.payer.pos} FastPay balance?`, tx.reversed_at ? 'YES' : 'NO',
      tx.reversed_at ? `Returned at ${t(tx.reversed_at)}.` : 'No return is recorded.', [txEv, payerEv]);
    if (tx.reversed_at) log.step(`Return to ${P.payer.pos} balance`, tx.reversed_at, 'returned', 'FastPay');
  };

  let status = null;
  let item = null;
  let payoutEv = null;
  log.check('Did FastPay send the payout instruction to PayPal?', tx.provider_ref ? 'YES' : 'NO',
    tx.provider_ref ? `FastPay sent payout batch ${tx.provider_ref}.` : 'FastPay has no PayPal payout reference for this cash out.', [txEv]);
  if (tx.provider_ref) {
    const payout = await readPayPal(c, 'payout', c.paypal.getPayout, tx.provider_ref, 'PAYPAL_PAYOUTS', `PayPal payout ${tx.provider_ref}`, payoutSummary);
    payoutEv = payout.evId;
    if (!payout.ok && payout.status !== 404) {
      c.facts.paypal_unreachable = true;
      log.check('What status did PayPal return for the payout?', 'UNKNOWN', `Could not be confirmed: ${payout.error}.`, [payoutEv]);
      returned();
      log.step(`Payout to ${P.payee.subj}`, null, 'unknown', 'PayPal');
      return { code: 'INVESTIGATION_INCONCLUSIVE', explanation: `PayPal's payout status could not be confirmed (${payout.error}). ${capitalize(P.payer.pos)} balance was debited ${amt} at ${t(tx.debited_at)}${tx.reversed_at ? ` and the money was returned at ${t(tx.reversed_at)}` : ''}.` };
    }
    if (payout.ok) {
      item = payout.data?.items?.[0] ?? null;
      c.facts.paid_out_at = item?.time_processed ?? null;
      c.facts.paypal_transaction_id = item?.transaction_id ?? null;
      status = item?.transaction_status ?? (payout.data?.batch_header?.batch_status === 'DENIED' ? 'DENIED' : 'PENDING');
      c.facts.paypal_status = status;
    }
  }
  const state = status ? PAYOUT_STATE[status] ?? 'PENDING' : 'NEVER_SENT';
  const paidMoney = item?.payout_item?.amount ?? null;
  const amountOk = amountMatches(paidMoney, tx);

  log.check('What status did PayPal return for the payout?', { PAID: 'COMPLETED', NOT_PAID: 'FAILED', UNCLAIMED: 'PENDING', PENDING: 'PENDING', NEVER_SENT: 'NOT_FOUND' }[state],
    state === 'NEVER_SENT'
      ? tx.provider_ref ? 'PayPal has no record of this payout.' : 'The payout was never sent to PayPal.'
      : `PayPal shows the payout item as ${status}${item?.time_processed ? `, processed at ${t(item.time_processed)}` : ''}${item?.errors?.message ? ` (${item.errors.message})` : ''}.`,
    [payoutEv ?? txEv]);
  if (paidMoney) {
    log.check("Do the amount and currency PayPal paid out match FastPay's record?", amountOk ? 'YES' : 'NO',
      amountOk ? `Both show ${amt}.` : `PayPal shows ${paidMoney.value} ${paidMoney.currency}; FastPay recorded ${amt}.`, [txEv, payoutEv]);
    if (!amountOk) log.flag('AMOUNT_MISMATCH', `PayPal paid out ${paidMoney.value} ${paidMoney.currency}; FastPay debited ${amt}.`, [txEv, payoutEv]);
  }
  returned();
  const payStep = `Payout to ${P.payee.subj}`;
  if (state === 'PAID') log.step(payStep, item?.time_processed ?? null, 'done', 'PayPal');
  else if (['PENDING', 'UNCLAIMED'].includes(state)) log.step(payStep, null, 'pending', 'PayPal');
  else log.step(payStep, null, 'missing', 'PayPal');

  if (state === 'PAID') {
    if (tx.reversed_at) {
      log.flag('PAID_OUT_AND_RETURNED', 'PayPal paid out the money, and FastPay also returned it to the balance.', [txEv, payoutEv]);
      return { code: 'INVESTIGATION_INCONCLUSIVE', explanation: `PayPal paid out ${amt}, but FastPay also returned the money to ${P.payer.pos} balance at ${t(tx.reversed_at)}. This needs a manual review.` };
    }
    if (amountOk === false) {
      const diff = Math.abs(valueToCents(paidMoney.value) - tx.amount);
      return { code: 'INVESTIGATION_INCONCLUSIVE', amountAtIssue: diff, explanation: `PayPal paid out ${paidMoney.value} ${paidMoney.currency}, but FastPay debited ${amt}. The records disagree and need a manual review.` };
    }
    return { code: 'PAYMENT_COMPLETED', explanation: `${capitalize(P.payer.pos)} balance was debited ${amt} at ${t(tx.debited_at)}, and PayPal paid it out to ${P.payee.subj}${item?.time_processed ? ` at ${t(item.time_processed)}` : ''} (payout item ${item?.payout_item_id}, status SUCCESS).` };
  }
  if (state === 'UNCLAIMED') {
    return {
      code: 'PAYMENT_PENDING',
      pending: pending(c, 'PAYOUT_UNCLAIMED', `PayPal sent the payout, but ${tx.external_account} does not have a PayPal account yet`),
      explanation: `PayPal sent the payout, but it is unclaimed: ${tx.external_account} does not have a PayPal account yet. It is paid when that email signs up for PayPal. Otherwise PayPal returns it after 30 days.`,
    };
  }
  if (state === 'PENDING') {
    return {
      code: 'PAYMENT_PENDING',
      pending: pending(c, 'PAYPAL_PAYOUT_PROCESSING', 'PayPal is still processing the payout and has not provided a final status'),
      explanation: `PayPal is still processing the payout (status ${status}). ${capitalize(P.payer.pos)} balance was debited ${amt} at ${t(tx.debited_at)}.`,
    };
  }
  // NOT_PAID or NEVER_SENT
  const why = state === 'NEVER_SENT' ? (tx.provider_ref ? 'PayPal has no record of the payout' : 'the payout was never sent to PayPal') : `PayPal did not pay it out (status ${status})`;
  if (tx.reversed_at) {
    return { code: 'PAYMENT_REFUNDED', explanation: `${capitalize(P.payer.pos)} balance was debited ${amt} at ${t(tx.debited_at)}, but ${why}. The money was returned to ${P.payer.pos} balance at ${t(tx.reversed_at)}.` };
  }
  c.facts.payout_failure = state === 'NEVER_SENT' ? 'NEVER_SENT' : 'PAYPAL_DECLINED';
  return {
    code: 'PAYOUT_FAILED',
    amountAtIssue: tx.amount,
    explanation: `${capitalize(P.payer.pos)} balance was debited ${amt} at ${t(tx.debited_at)}, but ${why}, and the money has not been returned to ${P.payer.pos} balance${c.recent(tx.debited_at) ? ' yet (FastPay normally returns it shortly after)' : ''}.`,
  };
}

// ---- Test bank deposit (simulated, no outside record) ------------------------------

function decideTestTopUp(c) {
  const { tx, log, txEv, P, amt, t } = c;
  log.check('Is there an outside payment record to check?', 'N/A', "Test bank deposits are simulated, so only FastPay's own records could be checked.", [txEv]);
  creditCheck(c, [txEv, c.recon.payee?.evId]);
  log.step('Deposit started', tx.created_at, 'done', 'FastPay');
  log.step(creditLabel(P), tx.credited_at, tx.credited_at ? 'done' : tx.completed_at ? 'missing' : 'pending', 'FastPay');
  if (tx.credited_at) return { code: 'PAYMENT_COMPLETED', explanation: `FastPay recorded the credit of ${amt} to ${P.payee.pos} wallet at ${t(tx.credited_at)}.` };
  if (tx.completed_at) return { code: 'PAYMENT_FAILED', explanation: `The test bank deposit was declined or reversed at ${t(tx.completed_at)}, and nothing was credited.` };
  if (c.recent(tx.created_at)) {
    return {
      code: 'PAYMENT_PENDING',
      pending: pending(c, 'TEST_DEPOSIT_PROCESSING', 'The test bank deposit has not finished yet'),
      explanation: `The test bank deposit has not finished yet. It was started ${c.minutesSince(tx.created_at)} minutes ago.`,
    };
  }
  return { code: 'INVESTIGATION_INCONCLUSIVE', explanation: 'The test bank deposit is still open with no credit, and there is no outside record to check.' };
}

// ---- Checks that depend on what the customer complained about ----------------------

async function applyComplaint(c, outcome, complaint) {
  const { tx, log, txEv, amt, t } = c;
  const type = complaint?.complaint_type;
  if (type === 'DUPLICATE_PAYMENT') {
    const moved = (x) => (x.type === 'DEPOSIT' ? Boolean(x.credited_at) : Boolean(x.debited_at) && !x.reversed_at);
    const similar = await c.fastpay.similarTransactions(tx, 60);
    const evId = log.add('FASTPAY_TRANSACTIONS', 'Identical payments within an hour', similar.map((s) => ({
      reference: s.reference, created_at: s.created_at, debited_at: s.debited_at, credited_at: s.credited_at, reversed_at: s.reversed_at,
    })));
    const wentThrough = [tx, ...similar].filter(moved);
    if (moved(tx) && wentThrough.length > 1) {
      const refs = wentThrough.map((x) => x.reference);
      log.check('Did an identical payment go through within an hour?', 'YES', `${wentThrough.length} identical payments of ${amt} went through: ${refs.join(', ')}.`, [txEv, evId]);
      return {
        ...outcome,
        code: 'DUPLICATE_PAYMENT',
        amountAtIssue: (wentThrough.length - 1) * tx.amount,
        related: refs.filter((r) => r !== tx.reference),
        explanation: `${wentThrough.length} identical payments of ${amt} went through within an hour of each other (${refs.join(', ')}). For this one: ${outcome.explanation}`,
      };
    }
    log.check('Did an identical payment go through within an hour?', 'NO',
      similar.length ? `${similar.length} similar attempt(s) were found, but no money moved on them.` : 'No identical payment was found.', [evId]);
  }
  if (type === 'WRONG_AMOUNT' && complaint.amount_cents != null) {
    const same = complaint.amount_cents === tx.amount;
    log.check('Does the amount the customer mentioned match the record?', same ? 'YES' : 'NO',
      same ? `Both are ${amt}.` : `The customer mentioned ${formatMoney(complaint.amount_cents, complaint.currency ?? tx.currency)}; the record shows ${amt}.`, [txEv]);
  }
  if (type === 'UNRECOGNIZED_TRANSACTION') {
    const byYou = tx.initiated_by === c.viewerUserId;
    log.check('Who started this transaction?', 'INFO',
      `It was started ${byYou ? 'from your own FastPay account' : 'by another FastPay account'} at ${t(tx.created_at)}. FastPay does not keep device or login records, so these records can't show whether it was authorised.`, [txEv]);
  }
  return outcome;
}

/** A wallet that is off by exactly this payment's amount means the money may have moved without a record. */
function applyWalletDiscrepancies(c, outcome) {
  const suspicious = Object.values(c.recon).find((r) => !r.matches && Math.abs(r.difference) === c.tx.amount);
  if (!suspicious || outcome.code === 'INVESTIGATION_INCONCLUSIVE') return outcome;
  return {
    ...outcome,
    code: 'INVESTIGATION_INCONCLUSIVE',
    amountAtIssue: 0,
    explanation: `${outcome.explanation} However, a wallet balance involved is off from its records by exactly ${c.amt}, so the money may have moved without a matching record. This needs a manual review.`,
  };
}

function describe(c) {
  const { tx, kind, P, amt, t } = c;
  const when = t(tx.created_at);
  const lead = {
    INTERNAL_TRANSFER: P.payer.isYou ? `You sent ${amt} to ${P.payee.name} from your FastPay balance on ${when}` : `${P.payer.name} sent you ${amt} from their FastPay balance on ${when}`,
    PAYPAL_TRANSFER: P.payer.isYou ? `You paid ${amt} to ${P.payee.name} with PayPal on ${when}` : `${P.payer.name} paid you ${amt} with PayPal on ${when}`,
    PAYPAL_TOP_UP: `You added ${amt} to your FastPay wallet with PayPal on ${when}`,
    TEST_TOP_UP: `You added ${amt} to your FastPay wallet with a test bank deposit on ${when}`,
    PAYPAL_REQUEST: `You requested ${amt} from ${tx.external_account} with a PayPal invoice on ${when}`,
    PAYPAL_CASH_OUT: `You cashed out ${amt} to the PayPal account ${tx.external_account} on ${when}`,
  }[kind];
  return `${lead} (reference ${tx.reference}).`;
}

/** Where the money was going, and what confirms it got there. */
function destinationOf(kind, counterparty) {
  if (kind === 'INTERNAL_TRANSFER' || kind === 'PAYPAL_TRANSFER') {
    return { type: 'FASTPAY_WALLET', name: counterparty, confirmed_by: "FastPay's own record of this transfer (whether its credit was posted)" };
  }
  if (kind === 'PAYPAL_CASH_OUT') {
    return { type: 'EXTERNAL_PAYPAL_ACCOUNT', name: counterparty, confirmed_by: "PayPal's payout status (the network's confirmation)" };
  }
  return { type: 'OWN_FASTPAY_WALLET', name: 'your FastPay wallet', confirmed_by: 'Your own FastPay wallet records' };
}

/** What this investigation can NOT see, stated plainly. */
function limitsOf(kind, perspective, counterparty) {
  const out = [];
  if ((kind === 'INTERNAL_TRANSFER' || kind === 'PAYPAL_TRANSFER') && perspective === 'PAYER') {
    out.push(`FastPay confirms the credit to ${counterparty} from its own record of this payment. It does not open ${counterparty}'s account, and it cannot tell whether ${counterparty} has seen the money.`);
  }
  if ((kind === 'INTERNAL_TRANSFER' || kind === 'PAYPAL_TRANSFER') && perspective === 'PAYEE') {
    out.push(`FastPay confirms this payment from its own record of it. It does not open ${counterparty}'s account.`);
  }
  if (kind === 'PAYPAL_CASH_OUT') {
    out.push(`FastPay cannot see the PayPal account ${counterparty}. Delivery is confirmed only by PayPal's payout status.`);
  }
  if (kind === 'PAYPAL_TRANSFER' || kind === 'PAYPAL_TOP_UP') {
    out.push("PayPal's records show whether the PayPal account or card was charged. FastPay cannot see bank or card statements.");
  }
  if (kind === 'PAYPAL_REQUEST') out.push(`FastPay cannot see the payer's PayPal account. Payment is confirmed only by PayPal's invoice status.`);
  if (kind === 'TEST_TOP_UP') out.push('Test bank deposits have no outside record. Only FastPay records were checked.');
  return out;
}

/**
 * Investigate one confirmed transaction.
 * @param tx  a row from the read-only FastPay reader
 * @param viewerWalletId / viewerUserId  the customer who complained
 */
export async function investigateTransaction({
  tx, viewerWalletId, viewerUserId, complaint, fastpay, paypal, now = new Date(), timezone = 'Africa/Lagos', processingWindowMinutes = 10, onPayPalRead,
}) {
  const log = createLog(now);
  const kind = classifyTransaction(tx);
  const minutesSince = (iso) => Math.max(0, Math.round((now - new Date(iso)) / 60_000));
  const c = {
    tx, kind, log, fastpay, paypal, onPayPalRead, viewerUserId,
    facts: {},
    P: parties(tx, kind, viewerWalletId),
    amt: formatMoney(tx.amount, tx.currency),
    t: (iso) => formatLocal(iso, timezone),
    minutesSince,
    /** "12 minutes", "3 hours", "2 days": how long ago, in words. */
    elapsed: (iso) => {
      const m = minutesSince(iso);
      const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
      return m < 60 ? unit(m, 'minute') : m < 1440 ? unit(Math.round(m / 60), 'hour') : unit(Math.round(m / 1440), 'day');
    },
    recent: (iso) => Boolean(iso) && (now - new Date(iso)) / 60_000 < processingWindowMinutes,
  };
  c.txEv = log.add('FASTPAY_TRANSACTIONS', `FastPay transaction ${tx.reference}`, transactionEvidence(tx));
  c.recon = await reconcileWallets(c);

  const disputes = kind === 'PAYPAL_TRANSFER' || kind === 'PAYPAL_TOP_UP' ? (tx.disputes ?? []) : [];
  if (disputes.length) {
    const evId = log.add('FASTPAY_DISPUTES', 'PayPal disputes recorded by FastPay', disputes);
    log.check('Has a PayPal dispute been opened on this payment?', 'YES',
      disputes.map((d) => `${d.id}: ${d.status}${d.outcome ? ` (${d.outcome})` : ''}`).join('; '), [evId]);
  }

  let outcome;
  if (kind === 'INTERNAL_TRANSFER') outcome = decideInternal(c);
  else if (kind === 'PAYPAL_TRANSFER' || kind === 'PAYPAL_TOP_UP') outcome = await decidePayPalCheckout(c);
  else if (kind === 'PAYPAL_REQUEST') outcome = await decideInvoice(c);
  else if (kind === 'PAYPAL_CASH_OUT') outcome = await decideCashOut(c);
  else outcome = decideTestTopUp(c);

  outcome = await applyComplaint(c, outcome, complaint);
  outcome = applyWalletDiscrepancies(c, outcome);

  const usedPayPal = log.evidence.some((e) => e.source.startsWith('PAYPAL_') && !e.data?.error);
  const confidence =
    outcome.code === 'INVESTIGATION_INCONCLUSIVE' ? 'LOW'
      : log.discrepancies.length || kind === 'TEST_TOP_UP' ? 'MEDIUM'
        : kind === 'INTERNAL_TRANSFER' || usedPayPal || outcome.code === 'PAYMENT_FAILED' ? 'HIGH' : 'MEDIUM';

  const { P } = c;
  const perspective = kind === 'INTERNAL_TRANSFER' || kind === 'PAYPAL_TRANSFER' ? (P.payer.isYou ? 'PAYER' : 'PAYEE') : kind === 'PAYPAL_REQUEST' ? 'PAYEE' : 'PAYER';
  const counterparty =
    kind === 'PAYPAL_CASH_OUT' ? tx.external_account
      : kind === 'PAYPAL_REQUEST' ? tx.external_account
        : kind === 'PAYPAL_TOP_UP' ? 'PayPal'
          : kind === 'TEST_TOP_UP' ? 'Test bank'
            : perspective === 'PAYER' ? P.payee.name : P.payer.name;

  return {
    kind,
    kind_label: KINDS[kind],
    perspective,
    counterparty,
    destination: destinationOf(kind, counterparty),
    limits: limitsOf(kind, perspective, counterparty),
    facts: {
      created_at: tx.created_at,
      debited_at: tx.debited_at,
      credited_at: tx.credited_at,
      returned_at: tx.reversed_at,
      charged_at: c.facts.charged_at ?? null,
      paid_out_at: c.facts.paid_out_at ?? null,
      paypal_status: c.facts.paypal_status ?? null,
      paypal_transaction_id: c.facts.paypal_transaction_id ?? null,
      paypal_unreachable: Boolean(c.facts.paypal_unreachable),
      order_status: c.facts.order_status ?? null,
      paypal_state: c.facts.paypal_state ?? null,
      paypal_hold_reason: c.facts.paypal_hold_reason ?? null,
      fastpay_recorded_charge: c.facts.fastpay_recorded_charge ?? null,
      payout_failure: c.facts.payout_failure ?? null,
      pending_reason: c.facts.pending_reason ?? null,
    },
    intro: describe(c),
    finding: { code: outcome.code, title: FINDINGS[outcome.code].title, explanation: outcome.explanation },
    // Why it is pending, only from evidence (null unless PAYMENT_PENDING).
    pending: outcome.code === 'PAYMENT_PENDING' ? outcome.pending ?? null : null,
    amount_at_issue: outcome.amountAtIssue ?? 0,
    related_references: outcome.related ?? [],
    money_trail: log.trail,
    checks: log.checks,
    discrepancies: log.discrepancies,
    evidence: log.evidence,
    confidence,
  };
}
