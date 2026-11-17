import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function formatMoney(cents, currency = 'USD') {
  if (cents == null) return null;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

/** 5000 -> "50.00", the way PayPal writes amounts. */
export const centsToValue = (cents) => (cents / 100).toFixed(2);

/** "50.00" -> 5000. Returns null for anything that is not a number. */
export function valueToCents(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** e.g. CASE-261112-7KQ2M9XA */
export function newId(prefix, now = new Date()) {
  const ymd = now.toISOString().slice(2, 10).replaceAll('-', '');
  let code = '';
  for (const b of crypto.randomBytes(8)) code += ALPHABET[b % ALPHABET.length];
  return `${prefix}-${ymd}-${code}`;
}

export function maskEmail(email) {
  if (!email || !email.includes('@')) return email ?? null;
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
}

export const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
