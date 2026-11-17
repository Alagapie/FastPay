// What the CUSTOMER sees: a plain explanation, the payment status, and what to do next.
// The full technical report (checks, raw evidence, PayPal IDs, reconciliation) stays internal.
//
// Wording rules:
//   - Say only what FastPay's own records and PayPal's responses show. Never claim to have looked
//     at the other person's bank, PayPal account or balance.
//   - "FastPay has not recorded the recipient's wallet credit", never "the credit did not happen"
//     or "the payment failed": a missing record is not proof of failure.
//   - Never tell the customer their complaint is wrong. This module never moves money.
import { formatLocal } from './understand/dates.js';
import { FINDINGS } from './investigate/findings.js';

const NO_MONEY_MOVED = 'No refund or new payment has been made as part of this investigation.';
const DONT_RESEND = 'Do not send the money again.';
const PASSED_ON = 'Your case and its evidence have been recorded and assigned to our payments team for review.';
const ASSIGNED_NO_CREDIT = 'Your case and its evidence have been recorded and assigned to our payments team for review because the recipient wallet credit has not yet been recorded.';
const CHECK_SOON = 'Check the payment status again shortly.';
const ESCALATE_IF_STUCK = 'If it remains pending beyond the expected processing time, the case will be escalated.';

const firstName = (name) => (name && !name.includes('@') ? name.split(' ')[0] : name);

/** Findings after which nothing more will happen: a missing step there is "Not recorded", not "Not yet recorded". */
const CLOSED = new Set(['PAYMENT_FAILED', 'PAYMENT_REFUNDED']);

function stateText(state, code) {
  if (state === 'missing') return CLOSED.has(code) ? 'Not recorded' : 'Not yet recorded';
  if (state === 'pending') return 'In progress';
  if (state === 'unknown') return 'Could not be confirmed';
  return '';
}

export function buildCustomerView(r, timezone) {
  const t = (iso) => (iso ? formatLocal(iso, timezone) : null);
  const f = r.facts;
  const amt = r.transaction.amount_display;
  const ref = r.transaction.reference;
  const who = r.counterparty;
  const first = firstName(who);
  const kind = r.kind;
  const code = r.finding.code;
  const payer = r.perspective === 'PAYER';
  const transfer = kind === 'INTERNAL_TRANSFER' || kind === 'PAYPAL_TRANSFER';
  const paypalFunded = kind === 'PAYPAL_TRANSFER' || kind === 'PAYPAL_TOP_UP';
  // Whose wallet credit this is about, as the customer reads it.
  const creditTarget = transfer && payer ? "the recipient's wallet credit" : 'the credit to your wallet';
  const creditTo = transfer && payer ? `${who}'s wallet` : 'your wallet';
  const escalate = `If ${transfer && payer ? `${first} still can't` : "you still can't"} see the money, reply here and we'll escalate it for further review.`;

  let v;
  switch (code) {
    case 'PAYMENT_COMPLETED':
      if (transfer && payer) {
        v = {
          tone: 'good',
          headline: 'Payment completed',
          status: `The payment is complete, and ${who}'s FastPay wallet has been credited.`,
          details: [
            paypalFunded
              ? `PayPal completed your ${amt} payment at ${t(f.charged_at)}, and FastPay recorded the credit to ${who}'s wallet at ${t(f.credited_at)}.`
              : `Your ${amt} left your balance at ${t(f.debited_at)}, and FastPay recorded the credit to ${who}'s wallet at ${t(f.credited_at)}.`,
          ],
          next_steps: [
            `Ask ${first} to refresh the FastPay app and check the wallet balance.`,
            `Ask ${first} to look for the payment in their transaction history.`,
            escalate,
          ],
        };
      } else if (transfer) {
        v = {
          tone: 'good',
          headline: 'Payment received',
          status: `${amt} from ${who} was credited to your FastPay wallet.`,
          details: [`FastPay recorded the credit to your wallet at ${t(f.credited_at)}.`],
          next_steps: ['Refresh the FastPay app and check your balance.', `Look for ${ref} in your transaction history.`, escalate],
        };
      } else if (kind === 'PAYPAL_CASH_OUT') {
        v = {
          tone: 'good',
          headline: 'Cash out delivered',
          status: `PayPal reports that ${amt} was paid out to your PayPal account ${who}.`,
          details: [`PayPal confirmed the payout at ${t(f.paid_out_at) ?? 'the time it was processed'}${f.paypal_transaction_id ? ` (PayPal transaction ID ${f.paypal_transaction_id})` : ''}.`],
          next_steps: [
            `Log in to PayPal as ${who} and check your activity${f.paypal_transaction_id ? ` for transaction ${f.paypal_transaction_id}` : ''}.`,
            "If PayPal doesn't show it, reply here and we'll escalate it for further review.",
          ],
        };
      } else if (kind === 'PAYPAL_REQUEST') {
        v = {
          tone: 'good',
          headline: 'Request paid',
          status: `${who} paid your request, and the ${amt} credit to your FastPay wallet is recorded.`,
          details: [`PayPal shows the invoice as paid, and FastPay recorded the credit to your wallet at ${t(f.credited_at)}.`],
          next_steps: ['Refresh the FastPay app and check your balance.', escalate],
        };
      } else {
        v = {
          tone: 'good',
          headline: 'Money added',
          status: `${amt} was added to your FastPay wallet.`,
          details: [
            kind === 'PAYPAL_TOP_UP'
              ? `PayPal completed the payment at ${t(f.charged_at)}, and FastPay recorded the credit to your wallet at ${t(f.credited_at)}.`
              : `FastPay recorded the credit to your wallet at ${t(f.credited_at)}.`,
          ],
          next_steps: ['Refresh the FastPay app to see your updated balance.', `Look for ${ref} in your transaction history.`, escalate],
        };
      }
      break;

    case 'PAYMENT_PENDING': {
      const reason = r.pending?.reason;
      const says = r.pending?.says ?? 'The payment provider has not returned a final status';
      const creditMatters = kind !== 'PAYPAL_CASH_OUT';
      if (reason === 'AWAITING_PAYER') {
        v = {
          tone: 'warn',
          headline: 'Waiting for payment',
          status: `${who} has not paid your ${amt} request yet.`,
          details: [`${says}. Nothing has been paid or credited yet.`],
          next_steps: [`Ask ${first} to pay the PayPal invoice that was emailed to them.`, CHECK_SOON],
        };
      } else if (reason === 'PAYOUT_UNCLAIMED') {
        v = {
          tone: 'warn',
          headline: 'Pending',
          status: `PayPal sent your ${amt}, but it hasn't been claimed yet.`,
          details: [`${who} doesn't have a PayPal account yet. The money is paid once that email signs up for PayPal. Otherwise PayPal returns it after 30 days.`],
          next_steps: [DONT_RESEND, `Make sure ${who} is the right email, and ask its owner to sign up for PayPal.`, CHECK_SOON],
        };
      } else {
        v = {
          tone: 'warn',
          headline: 'Pending',
          status: `Your ${kind === 'PAYPAL_CASH_OUT' ? 'cash out' : 'payment'} is still being processed.`,
          details: [creditMatters ? `${says}, and FastPay has not recorded ${creditTarget}.` : `${says}.`],
          next_steps: [DONT_RESEND, CHECK_SOON, ESCALATE_IF_STUCK],
        };
      }
      break;
    }

    case 'PAYMENT_CAPTURED_WALLET_NOT_CREDITED':
      v = {
        tone: 'bad',
        headline: transfer && payer ? 'Recipient wallet credit not yet recorded' : 'Wallet credit not yet recorded',
        status: kind === 'PAYPAL_REQUEST'
          ? `${who} paid your request through PayPal, but FastPay has not yet recorded the credit to your wallet.`
          : transfer && !payer
            ? `${who}'s PayPal payment was completed, but FastPay has not yet recorded the credit to your wallet.`
            : `PayPal completed the payment, but FastPay has not yet recorded ${creditTarget}.`,
        details: [
          kind === 'PAYPAL_REQUEST'
            ? `PayPal shows the invoice as paid${f.charged_at ? ` on ${f.charged_at}` : ''}.`
            : `PayPal confirmed that the ${amt} payment was completed${f.charged_at ? ` at ${t(f.charged_at)}` : ''}.`,
          f.fastpay_recorded_charge === false ? "FastPay has not yet recorded PayPal's confirmation of this payment." : null,
          `FastPay's wallet records do not yet show the credit to ${creditTo}${transfer && payer ? ', and no refund has been issued to you' : ''}.`,
        ].filter(Boolean),
        next_steps: [DONT_RESEND, transfer && payer ? ASSIGNED_NO_CREDIT : PASSED_ON, 'Tap "Check again" to see whether the credit has been recorded.', `Keep your reference: ${ref}.`],
      };
      break;

    case 'DEBITED_NOT_CREDITED':
      v = {
        tone: 'bad',
        headline: transfer && payer ? 'Recipient wallet credit not yet recorded' : 'Wallet credit not yet recorded',
        status: payer
          ? `Your ${amt} left your FastPay balance, but FastPay has not recorded ${creditTarget}.`
          : `A payment of ${amt} from ${who} was started, but FastPay has not recorded the credit to your wallet.`,
        details: [
          payer
            ? `The money left your balance at ${t(f.debited_at)}. FastPay's wallet records do not show the credit to ${who}'s wallet, and no refund has been issued to you.`
            : `FastPay's records show the payment was started at ${t(f.created_at)}, but no credit to your wallet is recorded.`,
        ],
        next_steps: payer
          ? [DONT_RESEND, ASSIGNED_NO_CREDIT, `Keep your reference: ${ref}.`]
          : ["There's nothing you need to do right now.", PASSED_ON, `Keep the reference: ${ref}.`],
      };
      break;

    case 'PAYOUT_FAILED':
      if (kind === 'PAYPAL_CASH_OUT') {
        const neverSent = f.payout_failure === 'NEVER_SENT';
        v = {
          tone: 'bad',
          headline: neverSent ? 'Cash out not sent' : 'Cash out failed',
          status: neverSent
            ? `${amt} left your FastPay balance, but the payout was never sent to PayPal.`
            : `PayPal could not pay out your ${amt}, and the money has not been returned to your balance yet.`,
          details: [`Your balance was debited at ${t(f.debited_at)}.${neverSent ? '' : ` PayPal reports the payout as ${f.paypal_status ?? 'not completed'}.`}`],
          next_steps: [PASSED_ON, `Keep your reference: ${ref}.`],
        };
      } else {
        v = {
          tone: 'bad',
          headline: 'Wallet credit failed',
          status: paypalFunded
            ? `PayPal completed the payment, but the credit to ${creditTo} failed.`
            : `Your ${amt} left your balance, but the credit to ${creditTo} failed.`,
          details: [
            paypalFunded ? `PayPal confirmed the payment was completed${f.charged_at ? ` at ${t(f.charged_at)}` : ''}.` : `The money left your balance at ${t(f.debited_at)}.`,
            "FastPay's records show the wallet credit failed, and the money has not been returned yet.",
          ],
          next_steps: [DONT_RESEND, PASSED_ON, `Keep your reference: ${ref}.`],
        };
      }
      break;

    case 'DUPLICATE_PAYMENT':
      v = {
        tone: 'bad',
        headline: 'Duplicate payment found',
        status: `This payment went through more than once, so ${r.amount_at_issue.display} more was taken than expected.`,
        details: [`The matching payments are ${[ref, ...r.related_references].join(', ')}.`],
        next_steps: ["Please don't make the payment again.", PASSED_ON],
      };
      break;

    case 'PAYMENT_FAILED':
      v = {
        tone: 'info',
        headline: 'Payment not completed',
        status: payer || !transfer ? 'The payment was not completed, and no money was taken.' : `The payment from ${who} was not completed, so nothing was sent.`,
        details: [
          paypalFunded
            ? 'PayPal did not complete the payment, so nothing was charged.'
            : kind === 'PAYPAL_REQUEST'
              ? 'The PayPal invoice was cancelled or could not be found, so it could not be paid.'
              : kind === 'PAYPAL_CASH_OUT'
                ? 'The cash out was stopped before any money left your balance.'
                : 'The payment was stopped before any money left your balance.',
        ],
        next_steps: kind === 'PAYPAL_REQUEST' ? ['If you still need the money, send a new request.'] : ['If you still want to make this payment, you can try again.'],
      };
      break;

    case 'PAYMENT_REFUNDED':
      v = {
        tone: 'info',
        headline: 'Payment refunded',
        status: paypalFunded ? `PayPal refunded your ${amt}.` : `${amt} was returned to ${payer ? 'your' : `${who}'s`} FastPay balance.`,
        details: [
          paypalFunded
            ? 'PayPal refunded the payment to your PayPal account or card. Refunds can take a few days to appear on a card statement.'
            : `The payment could not be completed, so the money was returned at ${t(f.returned_at)}.`,
        ],
        next_steps: payer
          ? [paypalFunded ? 'Check your PayPal account or card statement.' : 'Check your FastPay balance.', 'If you still want to make this payment, you can try again.']
          : [`Ask ${first} to send it again if it's still due.`],
      };
      break;

    default: // INVESTIGATION_INCONCLUSIVE
      v = {
        tone: 'warn',
        headline: 'Status not yet confirmed',
        status: 'We cannot yet confirm the final payment status.',
        details: [f.paypal_unreachable ? "We couldn't get a status from PayPal for this payment." : "Some of the records don't line up and need a closer look by our team."],
        next_steps: [DONT_RESEND, 'Your case and its evidence have been recorded for review by our team.', 'You can tap "Check again" later.'],
      };
  }

  const checked = [
    "We examined FastPay's own records of this payment.",
    r.sources_checked.some((s) => s.startsWith('PAYPAL_')) ? 'We checked the status PayPal returned for this payment.' : null,
    r.sources_checked.includes('FASTPAY_WALLETS') ? 'We checked your FastPay balance against your transaction history.' : null,
    transfer ? `We did not look inside ${first}'s account or bank. Only FastPay's own record of this payment was used.` : null,
  ].filter(Boolean);

  // Honest, calm and non-technical: never "FastPay has a bug", never a promise we can't keep.
  const incidentNote = r.incident?.status === 'SUSPECTED' && ['bad', 'warn'].includes(v.tone)
    ? "We're seeing a similar problem with some other payments right now. Your case has been linked to it, so it is looked at together, and your money is being tracked."
    : null;

  // The same result, said the way a person would in the chat.
  const lead = { good: "Good news, I've finished checking.", bad: 'I found the issue.', warn: "I've finished checking.", info: "I've finished checking." }[v.tone];
  const close = ['bad', 'warn'].includes(v.tone)
    ? 'Please do not send the money again. The timeline and next steps are below.'
    : 'You can see the full details below.';

  return {
    case_id: r.case_id,
    report_id: r.report_id,
    finding_code: code,
    reference: ref,
    amount_display: amt,
    kind_label: r.transaction.kind_label,
    created_at: r.transaction.created_at,
    tone: v.tone,
    headline: v.headline,
    status: v.status,
    details: v.details,
    checked,
    next_steps: v.next_steps,
    incident_note: incidentNote,
    timeline: (r.money_trail ?? []).map((s) => ({ label: s.step, at: s.at, at_display: t(s.at), state: s.state, state_text: stateText(s.state, code) })),
    money_note: NO_MONEY_MOVED,
    can_check_again: !FINDINGS[code]?.final,
    chat_lead: lead,
    chat_body: [v.status, v.details[0], close].filter(Boolean).join(' ').replace(/\s+/g, ' '),
    chat_reply: [lead, v.status, v.details[0], close].filter(Boolean).join(' ').replace(/\s+/g, ' '),
    generated_at: r.generated_at,
  };
}
