import path from 'node:path';

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '..', '.env'));
} catch {
  // no .env file — rely on real environment variables
}

const env = process.env;

if (!env.JWT_SECRET) {
  console.warn('[fastpay] JWT_SECRET not set — using an insecure development secret.');
}

export const config = {
  port: Number(env.PORT) || 4000,
  jwtSecret: env.JWT_SECRET || 'dev-only-insecure-secret',
  isProduction: env.NODE_ENV === 'production',
  currency: 'USD',
  maxTransactionCents: 1_000_000, // $10,000.00
  simulationEnabled: env.ENABLE_SIMULATION !== 'false',
  pendingSeconds: Number(env.PENDING_SECONDS) || 20,
  paypal: {
    clientId: env.PAYPAL_CLIENT_ID || '',
    clientSecret: env.PAYPAL_CLIENT_SECRET || '',
    env: env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox',
    // From Developer Dashboard -> your app -> Webhooks. Required to accept webhook events.
    webhookId: env.PAYPAL_WEBHOOK_ID || '',
  },
};

export const paypalEnabled = Boolean(config.paypal.clientId && config.paypal.clientSecret);
