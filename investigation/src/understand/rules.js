// Built-in English extractor. Used when the Meta model is not configured or not reachable,
// and by the tests. It handles the common ways customers describe a payment problem; the Meta
// model handles everything else (other phrasings, lowercase names, other languages later).
import { resolveDatePhrase } from './dates.js';

const NAME = "(\\p{Lu}[\\p{L}'’-]+(?:\\s+\\p{Lu}[\\p{L}'’-]+)?)";
const MONEY_GAP = "(?:(?:the\\s+)?money\\s+|(?:\\$|₦|usd\\s?|ngn\\s?)?\\d[\\d,]*(?:\\.\\d{1,2})?\\s*(?:dollars?|usd|bucks|naira)?\\s+)?";
const SEND_VERB = '(?:[Ss]ent|[Ss]end|[Pp]aid|[Pp]ay|[Tt]ransferred|[Tt]ransfer|[Gg]ave|[Ff]orwarded)';

const NOT_NAMES = new Set([
  'i', "i'm", 'im', 'paypal', 'fastpay', 'usd', 'ngn', 'the', 'my', 'he', 'she', 'they', 'we', 'it', 'him', 'her',
  'them', 'me', 'you', 'but', 'and', 'so', 'please', 'hello', 'hi', 'hey', 'today', 'yesterday', 'tomorrow', 'last',
  'this', 'card', 'visa', 'mastercard', 'bank', 'wallet', 'balance', 'money', 'dollars', 'naira',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

const NAME_PATTERNS = [
  new RegExp(`${NAME}\\s+(?:has\\s+|had\\s+)?(?:sent|paid|transferred)\\s+me\\b`, 'u'),
  new RegExp(`${NAME}\\s+(?:said|says|claims|claimed|told me)\\b`, 'u'),
  new RegExp(`\\b${SEND_VERB}\\s+${MONEY_GAP}(?:to\\s+)?${NAME}`, 'u'),
  new RegExp(`\\bto\\s+${NAME}`, 'u'),
  new RegExp(`\\bfrom\\s+${NAME}`, 'u'),
];

function cleanName(raw) {
  const words = raw.split(/\s+/).filter((w) => !NOT_NAMES.has(w.toLowerCase().replace(/['’]s$/, '')));
  const name = words.join(' ').replace(/['’]s$/, '').trim();
  return name.length >= 2 ? name : null;
}

export function extractCounterparty(message) {
  const email = message.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  if (email) return email[0];
  const account = message.match(/\bFP\d{10}\b/i);
  if (account) return account[0].toUpperCase();
  for (const re of NAME_PATTERNS) {
    for (const m of message.matchAll(new RegExp(re.source, 'gu'))) {
      const name = cleanName(m[1]);
      if (name) return name;
    }
  }
  // People often type names in lowercase ("i sent 25$ to musty"): take the one word after "sent … to".
  const lower = message.match(/\b(?:sent|send|paid|pay|transferred|transfer|gave)\b[^.?!]*?\bto\s+([a-z][a-z'’-]{1,30})\b/i);
  if (lower && !NOT_NAMES.has(lower[1].toLowerCase()) && !LOWER_NOT_NAMES.has(lower[1].toLowerCase())) {
    return lower[1][0].toUpperCase() + lower[1].slice(1);
  }
  return null;
}

const LOWER_NOT_NAMES = new Set(['a', 'an', 'his', 'our', 'your', 'their', 'someone', 'somebody', 'buy', 'get', 'pay', 'send', 'see', 'be', 'do', 'make', 'him', 'us']);

export function extractAmount(message) {
  const num = '(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?';
  const patterns = [
    [new RegExp(`(?:\\$|usd\\s?)\\s?${num}`, 'i'), 'USD'],
    [new RegExp(`${num}\\s?(?:dollars?|usd|bucks)\\b`, 'i'), 'USD'],
    [new RegExp(`${num}\\s?\\$`, 'i'), 'USD'], // "25$"
    [new RegExp(`(?:₦|ngn\\s?)\\s?${num}`, 'i'), 'NGN'],
    [new RegExp(`${num}\\s?(?:naira|ngn)\\b`, 'i'), 'NGN'],
  ];
  for (const [re, currency] of patterns) {
    const m = message.match(re);
    if (m) return { amount: Number(`${m[1].replaceAll(',', '')}.${m[2] ?? '0'}`), currency };
  }
  return { amount: null, currency: null };
}

export function classifyComplaint(message) {
  const t = message.toLowerCase().replaceAll('’', "'");
  if (/\b(twice|double|two times|duplicate|charged (me )?(again|two)|deducted (twice|two times))\b/.test(t)) return 'DUPLICATE_PAYMENT';
  if (/\b(don'?t|do not|didn'?t|did not)\s+(recogni[sz]e|make|authori[sz]e|initiate)\b|\bunauthori[sz]ed\b|\bnot me\b|\bfraud|\b(strange|unknown) (transaction|debit|payment)/.test(t)) {
    return 'UNRECOGNIZED_TRANSACTION';
  }
  if (/\b(wrong amount|incorrect amount|more than i|less than i|extra (charge|money)|overcharg\w*|undercharg\w*|(deducted|charged|took) more)\b/.test(t)) return 'WRONG_AMOUNT';
  if (/\b(refund\w*|reversal|reversed|money back|return(ed)? (my|the) money|not (been )?returned|never (got|came) back)\b/.test(t)) return 'REFUND_NOT_RECEIVED';
  if (/\b(cash(ed)?[\s-]?out|withdr[ae]w\w*|payout)\b/.test(t)) return 'CASH_OUT_NOT_RECEIVED';
  if (/\badd(ed|ing)?\s+(money|funds|\$?\d+)|\btop(ped)?[\s-]?up|\bdeposit\w*|\bfund(ed)?\s+my\b|\bload(ed)?\s+my\b/.test(t)) return 'TOP_UP_NOT_REFLECTED';
  if (/\b(sent|send|paid|pay|transferred)\s+me\b|\b(waiting for|expecting) (the |my )?(money|payment)\b|\b(i|i've|i have)\s+(not|never|n't)\s*(yet\s+)?(receiv|got|get)\w*.*\bfrom\b|\bpaid my (request|invoice)\b/.test(t)) {
    return 'EXPECTED_MONEY_NOT_RECEIVED';
  }
  if (/\b(sent|send|paid|pay|transfer\w*|gave)\b/.test(t)) return 'RECIPIENT_NOT_CREDITED';
  return 'OTHER';
}

function channelHint(message) {
  const t = message.toLowerCase();
  if (/\bpaypal\b|\b(debit|credit|bank)?\s?card\b/.test(t)) return 'PAYPAL';
  if (/\b(from|using|with)\s+my\s+(fastpay\s+)?(balance|wallet)\b/.test(t)) return 'FASTPAY_BALANCE';
  return null;
}

/** Same shape the Meta model returns, plus a resolved date range. */
export function extractWithRules(message, { now, timezone }) {
  const { amount, currency } = extractAmount(message);
  const date_range = resolveDatePhrase(message, now, timezone);
  return {
    amount,
    currency,
    counterparty: extractCounterparty(message),
    date_phrase: date_range?.label ?? null,
    date_range,
    complaint_type: classifyComplaint(message),
    channel: channelHint(message),
    summary: null,
  };
}
