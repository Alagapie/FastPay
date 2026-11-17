// Settings come from this module's own .env only. It holds no FastPay database path, no FastPay
// session secret and no PayPal keys: everything goes through FastPay's read-only investigation window.
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
    port: Number(own.PORT) || 4100,
    // FastPay Voice (Module 4, in ../digital-human): speak instead of typing, in English, Pidgin, Hausa, Yoruba or Igbo.
    voiceUrl: (own.VOICE_URL ?? 'http://localhost:4200').replace(/\/+$/, ''),
    // Token for this module's internal report API (staff / Module 3). Internal routes are off when empty.
    internalToken: own.INTERNAL_API_TOKEN || '',
    dbPath: path.resolve(ROOT, own.INVESTIGATION_DB_PATH || 'data/investigation.db'),
    timezone: own.INVESTIGATION_TIMEZONE || 'Africa/Lagos',
    processingWindowMinutes: Number(own.INVESTIGATION_PROCESSING_WINDOW_MINUTES) || 10,
    // Exceptions: who owns them, how long staff have before one is overdue, and when a pending payment
    // has been pending too long and becomes an exception itself.
    exceptionOwner: own.INVESTIGATION_EXCEPTION_OWNER || 'Payments operations',
    escalationMinutes: Number(own.INVESTIGATION_ESCALATION_MINUTES) || 60,
    pendingEscalationMinutes: Number(own.INVESTIGATION_PENDING_ESCALATION_MINUTES) || 60,
    fastpay: {
      apiUrl: own.FASTPAY_API_URL || 'http://localhost:4000',
      token: own.FASTPAY_INVESTIGATION_TOKEN || '',
      // Module 3: FastPay's resolution window key (= RESOLUTION_API_TOKEN in server/.env).
      resolutionToken: own.FASTPAY_RESOLUTION_TOKEN || '',
      cookieName: 'fp_session',
      appUrl: own.FASTPAY_APP_URL || 'http://localhost:5173',
    },
    // Module 3 (decision and resolution). Its own database; actions are simulated in v1.
    resolution: {
      dbPath: path.resolve(ROOT, '..', 'resolution', own.RESOLUTION_DB_PATH || 'data/resolution.db'),
      approvalMinutes: Number(own.RESOLUTION_APPROVAL_MINUTES) || 30,
      reportMaxAgeMinutes: Number(own.RESOLUTION_REPORT_MAX_AGE_MINUTES) || 30,
      autoReturnHours: Number(own.RESOLUTION_AUTO_RETURN_HOURS) || 24,
      // Optional: above this many dollars, staff must also approve. Empty = the policy decides alone.
      autoLimitCents: own.RESOLUTION_STAFF_LIMIT ? Math.round(Number(own.RESOLUTION_STAFF_LIMIT) * 100) : null,
      // The agent uses the Meta keys above, with this model (tested best for tool calling: muse-spark-1.3).
      model: own.RESOLUTION_MODEL || 'muse-spark-1.3',
    },
    meta: {
      apiKey: own.META_API_KEY || '',
      baseUrl: (own.META_BASE_URL || '').replace(/\/+$/, ''),
      model: own.META_MODEL || '',
    },
  };
}
