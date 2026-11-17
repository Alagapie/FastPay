import crypto from 'node:crypto';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** "12.5" -> 1250. Throws HttpError on anything that isn't a valid positive amount. */
export function parseAmount(input) {
  const str = String(input ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(str)) {
    throw new HttpError(400, 'Enter a valid amount (up to 2 decimal places).');
  }
  const [whole, frac = ''] = str.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < 1) {
    throw new HttpError(400, 'Amount must be at least 0.01.');
  }
  if (cents > config.maxTransactionCents) {
    throw new HttpError(400, `Amount cannot exceed ${formatCents(config.maxTransactionCents)} per transaction.`);
  }
  return cents;
}

export const formatCents = (cents) => (cents / 100).toFixed(2);

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode(length) {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** Transaction reference, e.g. FP-261112-7KQ2M9XA */
export function newReference() {
  const d = new Date();
  const ymd = d.toISOString().slice(2, 10).replaceAll('-', '');
  return `FP-${ymd}-${randomCode(8)}`;
}

/** Public account id, e.g. FP4821930571 */
export function newAccountId() {
  const n = crypto.randomInt(0, 10_000_000_000);
  return `FP${String(n).padStart(10, '0')}`;
}

/** Simulated outcomes the client may request (only when simulation is enabled). */
// credit_fail = payer is debited but the credit to the recipient never lands (the payment stays stuck).
export const SIMULATIONS = ['success', 'pending', 'pending_fail', 'fail', 'credit_fail'];

export function parseSimulation(value) {
  if (!config.simulationEnabled || value == null || value === '') return 'success';
  if (!SIMULATIONS.includes(value)) throw new HttpError(400, 'Unknown simulation mode.');
  return value;
}
