import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** e.g. AUTH-261112-7KQ2M9XA */
export function newId(prefix, now = new Date()) {
  const ymd = now.toISOString().slice(2, 10).replaceAll('-', '');
  let code = '';
  for (const b of crypto.randomBytes(8)) code += ALPHABET[b % ALPHABET.length];
  return `${prefix}-${ymd}-${code}`;
}

export function formatMoney(cents, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

/** Stable JSON (sorted keys) so the same terms always hash the same. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
