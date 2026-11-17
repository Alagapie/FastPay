// Settings come from this module's own .env only. It holds no FastPay secrets, no PayPal keys and no
// database path of any other module: it reaches the system only through Module 2's customer endpoints.
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

export const ROOT = path.resolve(import.meta.dirname, '..');

function readEnvFile(file) {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function loadConfig(overrides = {}) {
  const own = { ...readEnvFile(path.join(ROOT, '.env')), ...process.env, ...overrides };
  return {
    port: Number(own.PORT) || 4200,
    investigationUrl: (own.INVESTIGATION_URL || 'http://localhost:4100').replace(/\/+$/, ''),
    // The payment-help page this voice belongs to (opening this service directly sends you there).
    helpUrl: (own.INVESTIGATION_PUBLIC_URL || own.INVESTIGATION_URL || 'http://localhost:4100').replace(/\/+$/, ''),
    cookieName: 'fp_session',
    fastpayAppUrl: own.FASTPAY_APP_URL || 'http://localhost:5173',
    // Languages she replies in. Default: all five with a YarnGPT key (it can say them), English + Pidgin without.
    languages: (own.DH_LANGUAGES || (own.YARNGPT_API_KEY ? 'en,pcm,ha,yo,ig' : 'en,pcm')).split(',').map((s) => s.trim()).filter(Boolean),
    dbPath: own.DH_DB_PATH === ':memory:' ? ':memory:' : path.resolve(ROOT, own.DH_DB_PATH || 'data/digital-human.db'),
    // Her speaking voice (YarnGPT). Without a key the browser's female voice is used (English/Pidgin only).
    voice: {
      apiKey: own.YARNGPT_API_KEY || '',
      baseUrl: (own.YARNGPT_BASE_URL || 'https://api.yarngpt.ai').replace(/\/+$/, ''),
      voices: Object.fromEntries(['en', 'pcm', 'ha', 'yo', 'ig'].map((l) => [l, own[`DH_VOICE_${l.toUpperCase()}`] || own.DH_VOICE])),
    },
    meta: {
      apiKey: own.META_API_KEY || '',
      baseUrl: (own.META_BASE_URL || '').replace(/\/+$/, ''),
      understandModel: own.DH_UNDERSTAND_MODEL || 'muse-spark-1.1',
      replyModel: own.DH_REPLY_MODEL || 'muse-ember-1.0',
    },
  };
}
