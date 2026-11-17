// Checks the PayPal settings in server/.env and explains anything that's missing.
// Run from the project folder:  npm run check-paypal
import { config, paypalEnabled } from '../src/config.js';
import * as paypal from '../src/paypal.js';

// Events FastPay acts on. In the PayPal dashboard you can tick these, or simply choose "All events".
export const WEBHOOK_EVENTS = [
  'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', 'PAYMENT.PAYOUTS-ITEM.FAILED', 'PAYMENT.PAYOUTS-ITEM.RETURNED',
  'PAYMENT.PAYOUTS-ITEM.BLOCKED', 'PAYMENT.PAYOUTS-ITEM.DENIED', 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
  'INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.CANCELLED', 'INVOICING.INVOICE.REFUNDED',
  'CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED',
];

const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => console.log(`  ✖ ${m}`);
const info = (m) => console.log(`    ${m}`);
let problems = 0;

console.log('\nFastPay · PayPal check\n');

// 1. Keys
console.log('1. PayPal keys');
if (!paypalEnabled) {
  bad('PAYPAL_CLIENT_ID and/or PAYPAL_CLIENT_SECRET are empty in server/.env');
  info('Get them at developer.paypal.com -> Apps & Credentials -> Sandbox -> your app.');
  process.exit(1);
}
let scopes = [];
try {
  const result = await paypal.checkCredentials();
  scopes = result.scopes;
  ok(`Keys accepted by PayPal (${config.paypal.env}: ${result.base})`);
} catch {
  bad('PayPal rejected the keys.');
  info('Check you copied the Client ID and Secret from the same app, and that PAYPAL_ENV matches (sandbox/live).');
  process.exit(1);
}

// 2. Which PayPal features this app is allowed to use (read from the token's scopes, no money moves)
console.log('\n2. App features');
// Each feature lists the scope names PayPal may use for it (PayPal isn't consistent about the prefix).
const FEATURES = [
  ['Checkout (Add money, Send with PayPal, Pay Later)', ['https://uri.paypal.com/services/payments/payment']],
  ['Payouts (Cash out)', ['https://uri.paypal.com/payments/payouts', 'https://uri.paypal.com/services/payments/payouts']],
  ['Invoicing (Request money)', ['https://uri.paypal.com/services/invoicing']],
  ['Disputes', ['https://uri.paypal.com/services/disputes/read-seller']],
];
for (const [label, names] of FEATURES) {
  if (scopes.some((s) => names.some((n) => s === n || s.startsWith(`${n}/`)))) ok(label);
  else {
    bad(`${label}: not enabled for this app`);
    problems++;
  }
}
if (problems) {
  info('Fix: developer.paypal.com -> Apps & Credentials -> your app -> Features (or "Other features"):');
  info('tick the missing feature(s), Save, then restart `npm run dev`.');
}

// 3. Webhook
console.log('\n3. Webhook');
const { ok: listed, data: list } = await paypal.listWebhooks();
const hooks = listed ? list.webhooks ?? [] : [];

if (!config.paypal.webhookId) {
  bad('PAYPAL_WEBHOOK_ID is empty (optional; FastPay will poll PayPal instead).');
  if (hooks.length) {
    info('Webhooks already registered on this app:');
    for (const h of hooks) info(`  ${h.id}  ->  ${h.url}`);
    info('If one of these points at /api/paypal/webhook, copy its ID into PAYPAL_WEBHOOK_ID.');
  }
  problems++;
} else {
  const { ok: found, data: hook } = await paypal.getWebhook(config.paypal.webhookId);
  if (!found) {
    bad(`No webhook with ID ${config.paypal.webhookId} on this PayPal app.`);
    info('Copy the Webhook ID (not the URL) from the app’s Webhooks section, from the same app as your keys.');
    problems++;
  } else {
    ok(`Webhook found: ${hook.url}`);
    if (!hook.url.endsWith('/api/paypal/webhook')) {
      bad('The URL should end with /api/paypal/webhook');
      problems++;
    }

    const names = (hook.event_types ?? []).map((e) => e.name);
    const all = names.includes('*');
    const missing = all ? [] : WEBHOOK_EVENTS.filter((e) => !names.includes(e));
    if (!missing.length) ok(all ? 'Subscribed to all events' : 'Subscribed to every event FastPay uses');
    else {
      bad(`Missing ${missing.length} event(s). Edit the webhook and tick these (or choose "All events"):`);
      for (const e of missing) info(`  - ${e}`);
      problems++;
    }

    // Can PayPal actually reach us? Send a deliberately invalid body; FastPay answers "Invalid JSON".
    try {
      const res = await fetch(hook.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'ping' });
      const body = await res.text();
      if (body.includes('Invalid JSON')) ok('Webhook URL reaches this FastPay server');
      else if ([502, 530, 1033].includes(res.status)) {
        bad(`The tunnel isn't running (HTTP ${res.status}). Start \`npm run tunnel\` and, if the address changed, update the webhook URL in the PayPal dashboard.`);
        problems++;
      }
      else if (body.includes('not configured')) {
        bad('The URL reaches FastPay, but the running server has no PAYPAL_WEBHOOK_ID. Restart `npm run dev`.');
        problems++;
      } else {
        bad(`The URL answered, but not like FastPay does (HTTP ${res.status}). Is the tunnel pointing at port ${config.port}?`);
        problems++;
      }
    } catch {
      bad('Could not reach the webhook URL. Is `npm run tunnel` still running? Quick-tunnel URLs change every restart.');
      problems++;
    }
  }
}

console.log(problems ? `\n${problems} thing(s) to fix above.\n` : '\nAll good. PayPal is fully connected.\n');
