// How the support chat talks. Plain rules, no AI: it only chooses words. It never decides what
// happened to the money (the investigation does that) and never promises a refund.
import { formatMoney } from './util.js';

const PAYMENT_WORDS = /\b(sent|send|paid|pay|payment|transfer\w*|money|dollars?|naira|charged?|refund\w*|cash\w*|deposit\w*|added|top.?up|receiv\w*|wallet|balance|paypal|invoice|request\w*)\b|\$|₦|\d/i;
const GREETING = /^\s*(hi+|hello|hey|hiya|howdy|good\s+(morning|afternoon|evening|day)|greetings|salam|salaam|as+alam\w*\s*(alaikum)?|how\s+are\s+you)\b/i;
const THANKS = /\b(thanks|thank\s*(you|u)|thx|ty|appreciate|alright|ok(ay)?|cool|great|noted)\b/i;

/** A message that is only a greeting or a thank-you, with nothing about a payment in it. */
export function smallTalk(text) {
  const t = String(text ?? '').trim();
  if (t.length > 80 || PAYMENT_WORDS.test(t)) return null;
  if (GREETING.test(t)) return 'GREETING';
  if (THANKS.test(t)) return 'THANKS';
  return null;
}

export const firstNameOf = (name) => String(name ?? '').trim().split(/\s+/)[0] || 'there';

export function greeting(name, again = false) {
  return again
    ? `Hi again, ${firstNameOf(name)}. Tell me what happened with the payment, for example who it was to, how much and roughly when, and I'll look into it.`
    : `Hi ${firstNameOf(name)}, I'm here to help with any problem with a FastPay payment. Tell me what happened, for example who you paid, how much and roughly when, and I'll look into it.`;
}

/** A short, human first line that shows we understood the problem. */
export function acknowledge(ex) {
  const amt = ex?.amount_cents != null ? formatMoney(ex.amount_cents, ex.currency ?? 'USD') : null;
  const cp = ex?.counterparty;
  switch (ex?.complaint_type) {
    case 'RECIPIENT_NOT_CREDITED':
      return `I'm sorry ${cp ?? 'the person you paid'} hasn't received ${amt ? `the ${amt}` : 'the money'} yet. Let's find out what happened.`;
    case 'TOP_UP_NOT_REFLECTED':
      return `I'm sorry the ${amt ? `${amt} you added` : 'money you added'} isn't showing in your balance. Let's find out what happened.`;
    case 'CASH_OUT_NOT_RECEIVED':
      return `I'm sorry your ${amt ? `${amt} ` : ''}cash out hasn't arrived yet. Let's find out what happened.`;
    case 'EXPECTED_MONEY_NOT_RECEIVED':
      return `I'm sorry you haven't received ${amt ? `the ${amt}` : 'the money'}${cp ? ` from ${cp}` : ''} yet. Let's find out what happened.`;
    case 'DUPLICATE_PAYMENT':
      return "Being charged more than once is worrying. Let's check exactly what went through.";
    case 'WRONG_AMOUNT':
      return "Let's check the amount on that payment.";
    case 'REFUND_NOT_RECEIVED':
      return "I'm sorry your money hasn't come back yet. Let's check what happened.";
    case 'UNRECOGNIZED_TRANSACTION':
      return "Let's look at that payment together.";
    default:
      return "Let's take a look at that payment.";
  }
}

export function confirmed(reference, viaPayPal) {
  return `Thanks for confirming ${reference}. I'm checking FastPay's own records of this payment${viaPayPal ? ' and the status PayPal returned for it' : ''} now. This only takes a moment.`;
}

/** The result message. On a re-check, say whether anything changed. */
export function resultMessage(view, { rerun = false, changed = false } = {}) {
  if (!rerun) return view.chat_reply;
  const lead = changed ? "I've checked again, and there's an update." : "I've checked again, and nothing has changed yet.";
  return `${lead} ${view.chat_body}`;
}

// ---- After the result: the customer can keep talking --------------------------------------

const ASK_CHECK = /\b(check|update|status|any\s+news|news|again|refresh|still|yet|now)\b/i;
const ASK_WHY = /\b(why|how\s+come|what\s+happened|explain|what\s+does\s+(that|this|it)\s+mean|meaning|don'?t\s+understand|confus\w*)\b/i;
const ASK_MONEY = /\b(refund\w*|money\s+back|return\w*|revers\w*|get\s+(my|the)\s+money|when\s+will|compensat\w*|lost)\b/i;
const ASK_OTHER = /\b(another|different|other|new|second)\b.*\b(payment|transfer|transaction|problem|complaint|issue)\b|\d/i;
const ASK_HUMAN = /\b(human|agent|person|someone|staff|team|escalat\w*|complain\w*|manager)\b/i;

/** What does the customer want, now that they have a result? */
export function postResultIntent(text) {
  const t = String(text ?? '');
  // Requests win over politeness: "ok, check again" is a request to check again.
  if (ASK_MONEY.test(t)) return 'MONEY';
  if (ASK_WHY.test(t)) return 'WHY';
  if (ASK_HUMAN.test(t)) return 'HUMAN';
  if (ASK_CHECK.test(t)) return 'CHECK';
  if (ASK_OTHER.test(t)) return 'OTHER_PAYMENT';
  return smallTalk(t) ?? 'UNKNOWN';
}

const troubled = (v) => ['bad', 'warn'].includes(v.tone);

export function postResultReply(intent, v, { name, exceptionOpen = false } = {}) {
  switch (intent) {
    case 'THANKS':
      return troubled(v)
        ? `You're welcome, ${firstNameOf(name)}. ${exceptionOpen ? 'Your case has been assigned to our payments team for review. ' : ''}Tap "Check again" any time to see the latest status, and please don't send the money again in the meantime.`
        : `You're welcome, ${firstNameOf(name)}. Is there anything else I can help you with?`;
    case 'GREETING':
      return `Hi ${firstNameOf(name)}. I'm still here. You can ask me why this happened, ask me to check again, or start a new complaint for a different payment.`;
    case 'WHY':
      return `Here's what the records show. ${v.details.join(' ')} ${v.checked.at(-1) ?? ''}`.trim();
    case 'MONEY':
      if (v.finding_code === 'PAYMENT_COMPLETED') return `The records show this payment completed, so there's nothing to refund. ${v.next_steps[0]}`;
      if (v.finding_code === 'PAYMENT_FAILED') return "No money was taken for this payment, so there's nothing to return.";
      if (v.finding_code === 'PAYMENT_REFUNDED') return `${v.status} ${v.details[0]}`;
      return "I can only look at the records. I can't move money, so no refund or payment has been made yet. Your case and all its evidence have been assigned to our payments team for review. Please don't send the money again while it is being reviewed.";
    case 'HUMAN':
      return exceptionOpen
        ? 'Your case has already been assigned to our payments team for review, with all the evidence, so you won\'t need to explain it again. If you have anything to add, write it here and it will be kept with the case.'
        : "If you'd still like a person to look at this, write what's wrong here and it will be kept with the case for our team.";
    case 'OTHER_PAYMENT':
      return 'That sounds like a different payment. Tap "New complaint" and tell me about it there, so it gets its own case.';
    case 'CHECK':
      return `This result is final: ${v.headline.toLowerCase()}. ${v.status}`;
    default:
      return "I'm here to help with this payment. You can ask me why this happened, ask me to check again, or tap \"New complaint\" for a different payment.";
  }
}
