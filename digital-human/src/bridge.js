// The bridge to Module 2 (which also runs Module 3).
// It calls the SAME customer endpoints Module 2's own chat page calls, on behalf of the signed-in customer
// (their FastPay session cookie is passed through). Module 2 checks the login and owns every decision.
// No other module is changed, and there is no money endpoint here other than forwarding the customer's
// own Approve tap, which Module 3 checks against the exact terms on the card.

export class BridgeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createBridge({ baseUrl, cookieName, fetchImpl = globalThis.fetch, timeoutMs = 90_000 }) {
  async function call(session, method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Cookie: `${cookieName}=${session}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new BridgeError(503, 'The payment-help service is not reachable right now.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new BridgeError(res.status, data.error || `Payment help returned ${res.status}.`);
    return data;
  }

  return {
    session: (s) => call(s, 'GET', '/api/session'),
    getCase: async (s, id) => (await call(s, 'GET', `/api/cases/${encodeURIComponent(id)}`)).case,
    openCase: async (s, message) => (await call(s, 'POST', '/api/cases', { message })).case,
    addMessage: async (s, id, message) => (await call(s, 'POST', `/api/cases/${encodeURIComponent(id)}/messages`, { message })).case,
    noneOfThese: async (s, id) => (await call(s, 'POST', `/api/cases/${encodeURIComponent(id)}/none`, {})).case,
    confirm: async (s, id, reference) => (await call(s, 'POST', `/api/cases/${encodeURIComponent(id)}/confirm`, { reference })).case,
    investigate: async (s, id, again = false) => (await call(s, 'POST', `/api/cases/${encodeURIComponent(id)}/investigate`, { again })).case,
    choose: async (s, id, optionId) => (await call(s, 'POST', `/api/cases/${encodeURIComponent(id)}/resolution/choose`, { option_id: optionId })).case,
    back: async (s, id) => (await call(s, 'POST', `/api/cases/${encodeURIComponent(id)}/resolution/back`, {})).case,
    approve: async (s, id, authorizationId, termsHash) =>
      (await call(s, 'POST', `/api/cases/${encodeURIComponent(id)}/resolution/approve`, { authorization_id: authorizationId, terms_hash: termsHash })).case,
  };
}
