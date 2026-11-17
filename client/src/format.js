export function money(cents, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format((cents ?? 0) / 100);
}

export function signedMoney(tx) {
  const sign = tx.direction === 'DEBIT' ? '−' : '+';
  return `${sign}${money(tx.amount, tx.currency)}`;
}

export function dateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function shortDate(iso) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return `Today, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
}

export function txTitle(tx) {
  if (tx.provider === 'PAYPAL_INVOICE') {
    if (tx.status === 'SUCCESS') return `Paid by ${tx.counterparty.name}`;
    if (tx.status === 'FAILED') return `Request to ${tx.counterparty.name} closed`;
    return `Requested from ${tx.counterparty.name}`;
  }
  if (tx.type === 'DEPOSIT') return tx.provider === 'PAYPAL' ? 'Added money with PayPal' : 'Added money (test deposit)';
  if (tx.type === 'WITHDRAWAL') return 'Cashed out to PayPal';
  return tx.direction === 'DEBIT' ? `Sent to ${tx.counterparty.name}` : `Received from ${tx.counterparty.name}`;
}

export function txKind(tx) {
  if (tx.provider === 'PAYPAL_INVOICE') return 'PayPal payment request';
  if (tx.type === 'DEPOSIT') return 'Deposit';
  if (tx.type === 'WITHDRAWAL') return 'Withdrawal';
  const via = tx.provider === 'PAYPAL' ? ' via PayPal' : '';
  return (tx.direction === 'DEBIT' ? 'Payment sent' : 'Payment received') + via;
}

/** Validate a user-typed amount string; returns an error message or null. */
export function amountError(value, max) {
  if (!value) return 'Enter an amount.';
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return 'Use numbers only, with up to 2 decimals.';
  const cents = Math.round(Number(value) * 100);
  if (cents < 1) return 'Amount must be at least $0.01.';
  if (cents > 1_000_000) return 'The maximum per transaction is $10,000.00.';
  if (max != null && cents > max) return `That's more than your available balance (${money(max)}).`;
  return null;
}

export const toCents = (value) => Math.round(Number(value) * 100);
