// Recognises a customer who is signed in to FastPay. Browsers send localhost cookies to every port,
// so FastPay's `fp_session` cookie arrives here too. This module does NOT check it: it passes it to
// FastPay's investigation window, and FastPay (which owns the secret) says who the customer is.

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[key] = part.slice(i + 1).trim();
    }
  }
  return out;
}

/** The signed-in customer (with an API limited to them), or null. */
export async function customerFromRequest(req, { api, cookieName }) {
  const session = parseCookies(req.headers.cookie)[cookieName];
  return session ? api.forCustomer(session) : null;
}
