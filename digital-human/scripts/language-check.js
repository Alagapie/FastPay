// Step 0: the language test set, run against the REAL Meta model.
//   npm run languages
// Each phrase lists what the English must say. A native speaker should review and extend this list:
// it is the measure of whether Hausa, Yoruba, Igbo and Pidgin really work.
import { loadConfig } from '../src/config.js';
import { createMetaClient } from '../src/meta.js';
import { createLanguageManager, missingTokens } from '../src/language.js';

const CASES = [
  { text: 'Na saka dollar 50 jiya amma kudin bai shiga wallet dina ba.', language: 'ha', intent: 'complaint', english: [/50/, /yesterday/i, /wallet/i] },
  { text: 'Na tura wa Musa dala 20 amma bai samu ba.', language: 'ha', intent: 'complaint', english: [/20/, /Musa/, /\bI\b/] },
  { text: 'An cire min kudi sau biyu, dala 20 kowanne.', language: 'ha', intent: 'complaint', english: [/twice|two times/i, /20/] },
  { text: 'Na biyu', language: 'ha', intent: 'choose', choice: 2, list: true },
  { text: 'Mo fi dollar 50 ranṣẹ si Musa lana sugbon ko de odo e.', language: 'yo', intent: 'complaint', english: [/50/, /Musa/, /yesterday/i, /\bI\b/] },
  { text: 'Èkejì ni', language: 'yo', intent: 'choose', choice: 2, list: true },
  { text: 'Nnamdi zitere m 30 dollars mana ọ bịaghị.', language: 'ig', intent: 'complaint', english: [/Nnamdi/, /30/, /me\b/] },
  { text: 'Nke mbụ', language: 'ig', intent: 'choose', choice: 1, list: true },
  { text: 'I send 50 dollars give Musa yesterday but e never reach am o.', language: 'pcm', intent: 'complaint', english: [/50/, /Musa/, /yesterday/i] },
  { text: 'None of dem be am', language: 'pcm', intent: 'none_of_these', list: true },
  { text: 'My PayPal top-up of $25 from Monday is still not in my wallet', language: 'en', intent: 'complaint', english: [/25/, /Monday/] },
];
const LIST = '1. $50.00 PayPal top-up from PayPal, Tue 11 Nov, 3:10 PM.\n2. $50.00 transfer to Musa, Tue 11 Nov, 9:02 AM.';
const REPLY = 'I found 2 payments that could match.\n1. $50.00 transfer to Musa, Tue 11 Nov, 9:02 AM.\n2. $20.00 transfer to Ada, Mon 10 Nov, 4:15 PM.\nSay the number of the right payment.';

const config = loadConfig();
const meta = createMetaClient(config.meta);
if (!meta.enabled) {
  console.log('Meta is not configured: set META_API_KEY and META_BASE_URL in digital-human/.env');
  process.exit(1);
}
const lm = createLanguageManager({ meta, understandModel: config.meta.understandModel, replyModel: config.meta.replyModel });

let pass = 0;
console.log(`Understanding with ${config.meta.understandModel}\n`);
for (const c of CASES) {
  const t = Date.now();
  const u = await lm.understand(c.text, { listContext: c.list ? LIST : '' });
  const problems = [];
  if (u.language !== c.language) problems.push(`language ${u.language}`);
  if (u.intent !== c.intent) problems.push(`intent ${u.intent}`);
  if (c.choice && u.choice !== c.choice) problems.push(`choice ${u.choice}`);
  for (const re of c.english ?? []) if (!re.test(u.english)) problems.push(`english missing ${re}`);
  if (!problems.length) pass++;
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${String(Date.now() - t).padStart(5)}ms [${c.language}] ${c.text}\n       -> ${u.english}${problems.length ? `\n       !! ${problems.join('; ')}` : ''}`);
}
console.log(`\nUnderstanding: ${pass}/${CASES.length}\n\nReplies with ${config.meta.replyModel} (amounts and references must survive):`);
for (const lang of ['ha', 'yo', 'ig', 'pcm']) {
  const t = Date.now();
  const r = await lm.speak(REPLY, lang);
  const lost = missingTokens(REPLY, r.text);
  console.log(`${r.language === lang && !lost.length ? 'ok  ' : 'FELL BACK TO ENGLISH'} ${Date.now() - t}ms [${lang}]\n${r.text.replace(/^/gm, '       ')}`);
}
