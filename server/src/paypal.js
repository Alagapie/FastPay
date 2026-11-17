// Minimal PayPal REST client: Orders v2, Payouts, Invoicing v2, Disputes, Webhook verification.
import { config } from './config.js';
import { HttpError, formatCents } from './util.js';

const BASE = process.env.PAYPAL_API_BASE || (config.paypal.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');

let cachedToken = null; // { value, expiresAt }

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const auth = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    console.error('[paypal] auth failed', res.status, await res.text());
    throw new HttpError(502, 'Could not connect to PayPal. Check the API credentials.');
  }
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000, scope: data.scope ?? '' };
  return cachedToken.value;
}

async function call(method, path, { body, rawBody, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: rawBody ?? (body ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  // A permission error may mean the app's features changed: get a fresh token (with new scopes) next time.
  if (res.status === 401 || res.status === 403) resetToken();
  // debugId: PayPal's reference for this call, kept as evidence by investigations.
  return { ok: res.ok, status: res.status, data, debugId: res.headers.get('paypal-debug-id') };
}

/** Throws if the client id / secret are wrong. Used by `npm run check-paypal`. */
export async function checkCredentials() {
  await accessToken();
  return { base: BASE, scopes: cachedToken.scope.split(' ').filter(Boolean) };
}

/** Clear the cached token, e.g. after a permission error, so new app permissions are picked up. */
export function resetToken() {
  cachedToken = null;
}

export const getWebhook = (id) => call('GET', `/v1/notifications/webhooks/${encodeURIComponent(id)}`);
export const listWebhooks = () => call('GET', '/v1/notifications/webhooks');
export const updateWebhookUrl = (id, url) =>
  call('PATCH', `/v1/notifications/webhooks/${encodeURIComponent(id)}`, { body: [{ op: 'replace', path: '/url', value: url }] });

export const getOrder =(orderId) => call('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
export const getCapture = (captureId) => call('GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`);

// ---- Webhooks ---------------------------------------------------------------

/**
 * Ask PayPal whether a webhook really came from PayPal.
 * The original body is spliced in byte-for-byte: re-serialising the JSON could change it and break the signature.
 * Docs: https://developer.paypal.com/api/rest/webhooks/rest/#link-verifysignature
 */
export async function verifyWebhookSignature(headers, rawEventBody) {
  const field = (name) => JSON.stringify(String(headers[name] ?? ''));
  const rawBody =
    `{"auth_algo":${field('paypal-auth-algo')},"cert_url":${field('paypal-cert-url')},` +
    `"transmission_id":${field('paypal-transmission-id')},"transmission_sig":${field('paypal-transmission-sig')},` +
    `"transmission_time":${field('paypal-transmission-time')},"webhook_id":${JSON.stringify(config.paypal.webhookId)},` +
    `"webhook_event":${rawEventBody}}`;
  const { ok, data } = await call('POST', '/v1/notifications/verify-webhook-signature', { rawBody });
  return ok && data.verification_status === 'SUCCESS';
}

// ---- Invoicing (payment requests) --------------------------------------------
// Docs: https://developer.paypal.com/docs/api/invoicing/v2/

export async function createInvoice({ reference, amountCents, currency, payerEmail, requesterName, note }) {
  return call('POST', '/v2/invoicing/invoices', {
    headers: { Prefer: 'return=representation', 'PayPal-Request-Id': `inv-${reference}` },
    body: {
      detail: {
        invoice_number: reference,
        currency_code: currency,
        note: note || `${requesterName} requested a payment through FastPay.`,
        payment_term: { term_type: 'DUE_ON_RECEIPT' },
      },
      invoicer: { business_name: 'FastPay' },
      primary_recipients: [{ billing_info: { email_address: payerEmail } }],
      items: [
        {
          name: `Payment to ${requesterName} on FastPay`.slice(0, 200),
          description: (note || 'FastPay payment request').slice(0, 1000),
          quantity: '1',
          unit_amount: { currency_code: currency, value: formatCents(amountCents) },
        },
      ],
      configuration: { allow_tip: false },
    },
  });
}

export async function sendInvoice(invoiceId, requesterName) {
  return call('POST', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`, {
    body: {
      send_to_invoicer: false,
      send_to_recipient: true,
      subject: `${requesterName} sent you a payment request`.slice(0, 4000),
    },
  });
}

export const getInvoice = (invoiceId) => call('GET', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);

export const cancelInvoice = (invoiceId) =>
  call('POST', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/cancel`, {
    body: { send_to_invoicer: false, send_to_recipient: true, subject: 'Payment request cancelled' },
  });

// ---- Disputes -----------------------------------------------------------------
// Docs: https://developer.paypal.com/docs/api/customer-disputes/v1/

export const getDispute = (disputeId) => call('GET', `/v1/customer/disputes/${encodeURIComponent(disputeId)}`);

export async function createOrder({ amountCents, currency, requestId, description = 'FastPay payment' }) {
  const { ok, status, data } = await call('POST', '/v2/checkout/orders', {
    headers: { 'PayPal-Request-Id': requestId },
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          description: description.slice(0, 127),
          amount: { currency_code: currency, value: formatCents(amountCents) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'FastPay',
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
          },
        },
      },
    },
  });
  if (!ok) {
    console.error('[paypal] create order failed', status, JSON.stringify(data));
    throw new HttpError(502, 'PayPal could not create the order.');
  }
  return data;
}

/**
 * Send money to a PayPal account (Payouts API). Docs: https://developer.paypal.com/docs/api/payments.payouts-batch/v1/
 * Returns { ok, status, data } — data.batch_header.payout_batch_id on success.
 */
export async function createPayout({ amountCents, currency, email, reference }) {
  return call('POST', '/v1/payments/payouts', {
    headers: { 'PayPal-Request-Id': `payout-${reference}` },
    body: {
      sender_batch_header: {
        sender_batch_id: reference,
        email_subject: 'You have a payout from FastPay',
        email_message: 'Your FastPay withdrawal has been sent to your PayPal account.',
      },
      items: [
        {
          recipient_type: 'EMAIL',
          receiver: email,
          amount: { value: formatCents(amountCents), currency },
          note: `FastPay withdrawal ${reference}`,
          sender_item_id: reference,
        },
      ],
    },
  });
}

export async function getPayout(batchId) {
  return call('GET', `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
}

/**
 * Capture an approved order. In sandbox, `mockDecline` uses PayPal's negative-testing
 * header to make PayPal itself return INSTRUMENT_DECLINED.
 */
export async function captureOrder(orderId, { mockDecline = false } = {}) {
  const headers = {};
  if (mockDecline && config.paypal.env === 'sandbox') {
    headers['PayPal-Mock-Response'] = JSON.stringify({ mock_application_codes: 'INSTRUMENT_DECLINED' });
  }
  return call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { headers });
}

/**
 * Refund a capture (Payments v2). PayPal-Request-Id makes it idempotent: the same id never refunds twice.
 * Used only by the resolution window after Module 3's checks.
 */
export const refundCapture = (captureId, { amountCents, currency, requestId, note }) =>
  call('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    body: { amount: { value: formatCents(amountCents), currency_code: currency }, note_to_payer: note },
    headers: { 'PayPal-Request-Id': requestId, Prefer: 'return=representation' },
  });
