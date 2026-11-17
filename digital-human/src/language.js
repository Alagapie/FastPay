// Language Manager + Intent Recognition.
//
// In:  whatever the customer said, in Hausa, Yoruba, Igbo, Pidgin or English
//      -> { language, english, intent, choice }. Module 2 then receives the English, exactly as if typed.
// Out: the English that Module 2/3 replied -> the customer's language.
//      Every amount and reference in the English must survive the translation, or the reply is not used.

export const LANGUAGES = {
  en: { name: 'English', speech: 'en-NG' },
  ha: { name: 'Hausa', speech: 'ha-NG' },
  yo: { name: 'Yoruba', speech: 'yo-NG' },
  ig: { name: 'Igbo', speech: 'ig-NG' },
  pcm: { name: 'Nigerian Pidgin', speech: 'en-NG' },
};

export const INTENTS = [
  'complaint', // describing a payment problem, or adding details to one
  'choose', // picking a numbered item that was read out ("the second one")
  'none_of_these', // none of the payments read out is the right one
  'new_problem', // wants to start over with a different payment
  'greeting',
  'question', // anything else they ask
  'other',
];

const UNDERSTAND_SYSTEM = `You are the ears of a FastPay payment-help assistant in Nigeria.
The customer speaks Hausa (ha), Yoruba (yo), Igbo (ig), Nigerian Pidgin (pcm) or English (en), often mixed with English words.
Return ONLY a JSON object:
{"language":"ha|yo|ig|pcm|en","english":"...","intent":"...","choice":null}
- english: a faithful English translation of what they said. Keep every number and amount exactly as said.
  Keep exactly who paid whom (if the speaker paid, say "I sent"; if someone paid the speaker, say "X sent me").
  Do not add details that were not said. If it is already English, copy it.
- intent: one of ${INTENTS.join(', ')}.
- choice: when the intent is "choose", the 1-based number of the item they picked from the list they were just read; otherwise null.
- language: the main language they spoke. Pidgin is "pcm", not "en".`;

const SPEAK_SYSTEM = (lang) => `Translate the FastPay assistant's message into ${LANGUAGES[lang].name}, for a customer who will HEAR it spoken.
Rules:
- Natural, warm, simple everyday ${LANGUAGES[lang].name}, the way a helpful Nigerian customer-care agent speaks.
- Copy every amount (like $50.00), payment reference (like FP-…) and case ID EXACTLY as written. Never change, round or drop them.
- Keep list numbers ("1.", "2.") so the customer can say a number.
- Do not add or remove information. Output only the translation.`;

const MONEY = /\$\s?\d[\d,]*(?:\.\d+)?/g;
const REFERENCE = /\b[A-Z]{2,}-[A-Z0-9][A-Z0-9-]*\b/g;

/** The amounts and references in a message: these must appear unchanged in any translation. */
export function protectedTokens(text) {
  const s = String(text ?? '');
  return [...new Set([...(s.match(MONEY) ?? []), ...(s.match(REFERENCE) ?? [])])];
}

const squash = (s) => String(s).replace(/[\s,]/g, '');

/** Tokens from the English that the translation lost or altered. */
export function missingTokens(english, translated) {
  const t = squash(translated);
  return protectedTokens(english).filter((tok) => !t.includes(squash(tok)));
}

function cleanUnderstanding(raw, text, hint) {
  const language = LANGUAGES[raw?.language] ? raw.language : (LANGUAGES[hint] ? hint : 'en');
  const english = typeof raw?.english === 'string' && raw.english.trim() ? raw.english.trim().slice(0, 1000) : text;
  const intent = INTENTS.includes(raw?.intent) ? raw.intent : 'other';
  const n = Number(raw?.choice);
  const choice = intent === 'choose' && Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;
  return { language, english, intent: intent === 'choose' && !choice ? 'other' : intent, choice };
}

/** Simple English fallback when Meta is off or fails. */
function ruleUnderstanding(text, hint) {
  const s = text.toLowerCase();
  const words = { first: 1, one: 1, second: 2, two: 2, third: 3, three: 3, fourth: 4, four: 4, fifth: 5, five: 5 };
  const m = s.match(/^\s*(?:the\s+|number\s+|no\.?\s*)?(\d|first|second|third|fourth|fifth|one|two|three|four|five)\b(?:\s+one)?\s*\.?$/);
  if (m) return { language: LANGUAGES[hint] ? hint : 'en', english: text, intent: 'choose', choice: Number(m[1]) || words[m[1]] };
  if (/\bnone of (these|them|those)\b|\bnot (any|one) of\b/.test(s)) return { language: hint || 'en', english: text, intent: 'none_of_these', choice: null };
  if (/^\s*(hi|hello|hey|good (morning|afternoon|evening))\b[\s!.]*$/.test(s)) return { language: hint || 'en', english: text, intent: 'greeting', choice: null };
  return { language: LANGUAGES[hint] ? hint : 'en', english: text, intent: 'complaint', choice: null };
}

export function createLanguageManager({ meta, understandModel, replyModel, log = console }) {
  async function understand(text, { hint = null, listContext = '' } = {}) {
    if (!meta.enabled) return { ...ruleUnderstanding(text, hint), by: 'rules' };
    try {
      const user = listContext
        ? `The customer was just read this list:\n${listContext}\n\nThe customer said:\n${text}`
        : `The customer said:\n${text}`;
      const raw = await meta.completeJson({ model: understandModel, system: UNDERSTAND_SYSTEM, user });
      return { ...cleanUnderstanding(raw, text, hint), by: 'meta' };
    } catch (err) {
      log.warn?.('[voice] understanding failed, using rules:', err.message);
      return { ...ruleUnderstanding(text, hint), by: 'rules' };
    }
  }

  /**
   * The customer's own recording (16 kHz mono WAV, base64) -> { heard, language, english, intent, choice }.
   * Meta hears and understands it in one call. Returns null when nothing usable was heard.
   */
  async function understandAudio(wavBase64, { hint = null, listContext = '' } = {}) {
    if (!meta.enabled) throw Object.assign(new Error('Voice needs the Meta model. Please type instead.'), { status: 503 });
    const system = `${UNDERSTAND_SYSTEM.replace('Return ONLY a JSON object:\n{"language"', 'Return ONLY a JSON object:\n{"heard":"exact transcript of what they said, in their own words","language"')}
If the audio has no clear speech, return {"heard":""}.`;
    const raw = await meta.completeJson({
      model: understandModel,
      system,
      user: [
        { type: 'text', text: listContext ? `The customer was just read this list:\n${listContext}\n\nThe customer's reply is in the audio.` : "The customer's message is in the audio." },
        { type: 'input_audio', input_audio: { data: wavBase64, format: 'wav' } },
      ],
    });
    const heard = typeof raw?.heard === 'string' ? raw.heard.trim().slice(0, 1000) : '';
    if (!heard) return null;
    return { heard, ...cleanUnderstanding(raw, heard, hint), by: 'meta-audio' };
  }

  /**
   * English -> the customer's language. Returns { text, language } where language is what was actually
   * produced: if the translation drops or changes an amount or reference (twice), the English is used.
   */
  async function speak(english, language) {
    if (!english || language === 'en' || !LANGUAGES[language] || !meta.enabled) return { text: english, language: 'en' };
    for (const model of [replyModel, understandModel]) {
      try {
        const text = await meta.complete({ model, system: SPEAK_SYSTEM(language), user: english });
        const lost = missingTokens(english, text);
        if (!lost.length) return { text, language };
        log.warn?.(`[voice] ${model} translation changed ${lost.join(', ')}; not used`);
      } catch (err) {
        log.warn?.(`[voice] ${model} translation failed:`, err.message);
      }
    }
    return { text: english, language: 'en' };
  }

  return { understand, understandAudio, speak };
}
