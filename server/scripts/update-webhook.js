// Points the PayPal webhook (PAYPAL_WEBHOOK_ID) at a new tunnel address.
// Usage (from the project folder):  npm run update-webhook -- https://something.trycloudflare.com
import { config, paypalEnabled } from '../src/config.js';
import * as paypal from '../src/paypal.js';

const arg = process.argv[2];
if (!arg || !/^https:\/\/[^\s/]+/.test(arg)) {
  console.error('Usage: npm run update-webhook -- https://<your-tunnel-address>');
  process.exit(1);
}
if (!paypalEnabled || !config.paypal.webhookId) {
  console.error('PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_WEBHOOK_ID must be set in server/.env first.');
  process.exit(1);
}

const url = `${new URL(arg).origin}/api/paypal/webhook`;
const { ok, status, data } = await paypal.updateWebhookUrl(config.paypal.webhookId, url);
if (ok) {
  console.log(`✔ PayPal webhook now points to ${data.url}`);
} else {
  console.error(`✖ PayPal refused the update (HTTP ${status}): ${data?.message ?? JSON.stringify(data)}`);
  process.exit(1);
}
