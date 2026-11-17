// Sends a WAV recording to the REAL Meta model, exactly as the page does.
//   node scripts/voice-check.js path/to/recording.wav   (16 kHz mono 16-bit)
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createMetaClient } from '../src/meta.js';
import { createLanguageManager } from '../src/language.js';

const file = process.argv[2];
if (!file) { console.log('Usage: node scripts/voice-check.js recording.wav'); process.exit(1); }
const config = loadConfig();
const lm = createLanguageManager({ meta: createMetaClient(config.meta), understandModel: config.meta.understandModel, replyModel: config.meta.replyModel });
const t = Date.now();
console.log(await lm.understandAudio(fs.readFileSync(file).toString('base64')), `${Date.now() - t}ms`);
