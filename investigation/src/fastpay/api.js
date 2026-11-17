// The investigation module's ONLY way into FastPay: its read-only investigation window
// (server/src/routes/investigation.js). This module has no database access and no PayPal keys.
//
// Every call carries two things:
//   - this module's service key (FASTPAY_INVESTIGATION_TOKEN), and
//   - the signed-in customer's own FastPay session, so FastPay only ever answers about that customer.
import { HttpError } from '../util.js';

const enc = encodeURIComponent;

export function createFastPayApi({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const enabled = Boolean(base && token);

  async function call(session, path) {
    const res = await fetchImpl(`${base}/api/investigation${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Customer-Session': session, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  }

  const unreachable = () => new HttpError(503, 'FastPay is not reachable right now. Please try again shortly.');

  /** The signed-in customer, with an API limited to them, or null if the session isn't valid. */
  async function forCustomer(session) {
    if (!enabled) throw new HttpError(503, 'The investigation service is not connected to FastPay (set FASTPAY_INVESTIGATION_TOKEN).');
    if (!session) return null;

    let me;
    try {
      me = await call(session, '/me');
    } catch {
      throw unreachable();
    }
    if (me.status === 401) return null;
    if (me.status === 404) throw new HttpError(503, 'FastPay did not accept the investigation key. Check FASTPAY_INVESTIGATION_TOKEN.');
    if (me.status !== 200) throw unreachable();

    async function get(path) {
      let r;
      try {
        r = await call(session, path);
      } catch {
        throw unreachable();
      }
      if (r.status === 200) return r.data;
      if (r.status === 404) return null;
      if (r.status === 401) throw new HttpError(401, 'Your FastPay session has expired. Please sign in again.');
      throw unreachable();
    }

    // PayPal is read by FastPay (which keeps the keys), only for this customer's own payments.
    // Never throws: a failure comes back as { ok: false } so the investigation says INCONCLUSIVE.
    async function paypalRecord(kind, id) {
      const retrieved_at = new Date().toISOString();
      try {
        const r = await call(session, `/paypal/${kind}/${enc(id)}`);
        if (r.status !== 200) return { ok: false, status: 0, error: r.data?.error ?? `FastPay returned HTTP ${r.status}`, retrieved_at };
        const p = r.data;
        return {
          ok: p.ok,
          status: p.status,
          data: p.data,
          debug_id: p.debug_id ?? null,
          error: p.ok ? undefined : p.error || p.data?.message || p.data?.name || `HTTP ${p.status}`,
          retrieved_at: p.retrieved_at ?? retrieved_at,
        };
      } catch {
        return { ok: false, status: 0, error: 'FastPay could not be reached', retrieved_at };
      }
    }

    const api = {
      transactions: async ({ since = '1970-01-01T00:00:00.000Z', limit = 500 } = {}) =>
        (await get(`/transactions?since=${enc(since)}&limit=${limit}`))?.transactions ?? [],
      transaction: async (reference) => (await get(`/transactions/${enc(reference)}`))?.transaction ?? null,
      similarTransactions: async (tx, minutes = 60) => (await get(`/transactions/${enc(tx.reference)}/similar?minutes=${minutes}`))?.transactions ?? [],
      /** Counts only: how many payments on this payment's channel got stuck around the same time. */
      signals: async (reference, { minutes = 60, stuckAfter = 10 } = {}) =>
        (await get(`/transactions/${enc(reference)}/signals?minutes=${minutes}&stuck_after=${stuckAfter}`))?.signals ?? null,
      /** Always the customer's own wallet. FastPay won't answer for anyone else's. */
      reconcileWallet: async () => (await get('/reconciliation'))?.reconciliation ?? null,
      paypal: {
        enabled: true,
        getOrder: (id) => paypalRecord('orders', id),
        getCapture: (id) => paypalRecord('captures', id),
        getPayout: (id) => paypalRecord('payouts', id),
        getInvoice: (id) => paypalRecord('invoices', id),
      },
    };
    // `session` is passed on only to FastPay's resolution window (Module 3), for the same customer.
    return { ...me.data.user, wallet: me.data.wallet, api, session };
  }

  /** Startup check: is the window open, and does it accept our key? */
  async function check() {
    if (!enabled) return { ok: false, reason: 'FASTPAY_INVESTIGATION_TOKEN is not set.' };
    try {
      const r = await call('', '/me');
      if (r.status === 401) return { ok: true }; // key accepted; no customer in a startup check
      if (r.status === 404) return { ok: false, reason: 'FastPay did not accept the key (or INVESTIGATION_API_TOKEN is not set in server/.env).' };
      return { ok: false, reason: `Unexpected answer from FastPay (HTTP ${r.status}).` };
    } catch {
      return { ok: false, reason: `FastPay is not reachable at ${base}.` };
    }
  }

  return { enabled, forCustomer, check };
}
