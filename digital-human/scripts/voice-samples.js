// Lists the YarnGPT voices your key can use and saves one sample per language in data/samples/.
//   npm run voices
// Listen, then set DH_VOICE_EN / _PCM / _HA / _YO / _IG in .env to the voices you like.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { createVoice } from '../src/voice.js';

const SAMPLES = {
  en: "Hello, I'm the FastPay assistant. I found one payment of $50.00 to Musa yesterday. Is this the one?",
  pcm: 'Hello, na me be FastPay assistant. I don see one payment of $50.00 wey you send give Musa yesterday. Na this one?',
  ha: 'Sannu, ni ce mataimakiyar FastPay. Na sami biyan kuɗi ɗaya na $50.00 zuwa Musa jiya. Shin wannan ne?',
  yo: 'Ẹ kú àbọ̀, èmi ni olùrànlọ́wọ́ FastPay. Mo rí ìsanwó kan ti $50.00 sí Musa lánàá. Ṣé èyí ni?',
  ig: 'Ndewo, abụ m onye inyeaka FastPay. Ahụrụ m otu ịkwụ ụgwọ $50.00 nye Musa ụnyaahụ. Ọ bụ nke a?',
};

const voice = createVoice(loadConfig().voice);
const c = await voice.check();
console.log(`YarnGPT: ${c.message}`);
if (!c.ok) process.exit(1);
console.log(`\nVoices on your key: ${c.voices.join(', ') || '(none listed)'}\n`);
const dir = path.join(ROOT, 'data', 'samples');
fs.mkdirSync(dir, { recursive: true });
for (const [lang, text] of Object.entries(SAMPLES)) {
  const t = Date.now();
  try {
    const { audio } = await voice.speak(text, lang);
    const file = path.join(dir, `${lang}-${voice.voices[lang]}.mp3`);
    fs.writeFileSync(file, audio);
    console.log(`ok   ${lang} (${voice.voices[lang]}) ${Date.now() - t}ms -> ${file}`);
  } catch (err) {
    console.log(`FAIL ${lang} (${voice.voices[lang]}): ${err.code ?? err.message}`);
  }
}
