// Action Executor. Contract for every executor:
//   execute(terms, user) -> { ok, id, replayed, raw, error? }
//   verify(terms, user)  -> { ok, observed, mismatch? }
// terms = { key, action, amount, currency, target, reference, rule }. `key` is the idempotency key:
// the same key twice never moves money twice.
//
// createFastPayExecutor: REAL. Calls FastPay's resolution window (server/src/routes/resolution.js),
//   which posts the ledger legs itself (or refunds through PayPal) after its own checks.
// createSimulatedExecutor: test double, records in this module's sim_ledger only.
import { newId } from './util.js';

/** Which window action carries out this term. A duplicate goes back as a correcting transfer. */
const windowAction = (t) => (t.rule === 'duplicate:return-extra' && t.action === 'RETURN_TO_WALLET' ? 'RETURN_DUPLICATE' : t.action);

export function createFastPayExecutor({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const enabled = Boolean(base && token);

  async function call(user, method, path, body) {
    const res = await fetchImpl(`${base}/api/resolution${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'X-Customer-Session': user.session ?? '', 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  }

  return {
    name: 'fastpay',
    enabled,
    async execute(t, user) {
      if (!enabled) return { ok: false, error: 'The FastPay resolution window is not configured (FASTPAY_RESOLUTION_TOKEN).' };
      let r;
      try {
        r = await call(user, 'POST', '/actions', {
          idempotency_key: t.key, reference: t.reference, action: windowAction(t), amount: t.amount, currency: t.currency,
          authorization_id: t.authorization_id, authorized_by: t.authorized_by,
        });
      } catch (err) {
        // Unknown whether it ran: verify() reads it back by the same key.
        return { ok: false, unknown: true, error: `FastPay did not answer: ${err.message}` };
      }
      if (r.status === 200) return { ok: true, id: r.data.action.provider_ref ?? r.data.action.idempotency_key, replayed: Boolean(r.data.replayed), raw: r.data };
      return { ok: false, status: r.status, error: r.data?.error ?? `FastPay returned HTTP ${r.status}`, raw: r.data };
    },
    /** Read it back from FastPay's own ledger: the payment's legs must show the money moved. */
    async verify(t, user) {
      const r = await call(user, 'GET', `/actions/${encodeURIComponent(t.key)}`);
      if (r.status !== 200) return { ok: false, observed: null, mismatch: `FastPay has no record of it (HTTP ${r.status})` };
      const { action: a, transaction: tx } = r.data;
      const termsMatch = a.status === 'DONE' && a.action === windowAction(t) && a.amount === t.amount && a.currency === t.currency;
      const legsMatch = {
        CREDIT_WALLET: Boolean(tx?.credited_at),
        RETURN_TO_WALLET: Boolean(tx?.reversed_at),
        REFUND_PAYPAL: Boolean(tx?.reversed_at && a.provider_ref),
        RETURN_DUPLICATE: Boolean(a.provider_ref),
      }[a.action];
      const observed = { status: a.status, provider_ref: a.provider_ref, transaction: tx };
      return termsMatch && legsMatch ? { ok: true, observed } : { ok: false, observed, mismatch: 'FastPay\'s ledger does not show the money moved as approved' };
    },
  };
}

export function createSimulatedExecutor({ store, fail = null }) {
  return {
    name: 'simulated',
    enabled: true,
    async execute({ key, action, amount, currency, target, reference }) {
      if (fail?.(action)) return { ok: false, error: 'Simulated failure', raw: null };
      const entry = store.simPost({
        id: newId(action === 'REFUND_PAYPAL' ? 'SRF' : 'SCR'),
        idempotency_key: key, action, amount, currency, target, reference, created_at: new Date().toISOString(),
      });
      return { ok: true, id: entry.id, replayed: entry.replayed, raw: entry };
    },
    async verify({ key, action, amount, currency, target }) {
      const e = store.simGet(key);
      if (!e) return { ok: false, observed: null, mismatch: 'No ledger entry found' };
      const same = e.action === action && e.amount === amount && e.currency === currency && JSON.stringify(e.target) === JSON.stringify(target);
      return same ? { ok: true, observed: { entry_id: e.id, at: e.created_at } } : { ok: false, observed: e, mismatch: 'The ledger entry does not match the approved terms' };
    },
  };
}
