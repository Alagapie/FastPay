// The HTTP API, signed in with a real FastPay session cookie, which FastPay itself checks through its window.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, createService } from './helpers/fixture.js';
import { createFastPayApi } from '../src/fastpay/api.js';
import { createServer } from '../src/server.js';
let fx, me, musa, server, base;

before(async () => {
  fx = await createFixture();
  me = fx.addUser('Abdul Ishaq', 'abdul@test.dev');
  musa = fx.addUser('Musa Ibrahim', 'musa@test.dev');
  fx.fund(me, 50_000);
  const { service } = createService();
  const config = { internalToken: 'staff-token-123', fastpay: { cookieName: 'fp_session', appUrl: 'http://localhost:5173' } };
  server = createServer({ service, api: fx.api, config, llm: { enabled: false } });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => fx.close());
after(() => server.close());

const cookieFor = (user, opts) => `fp_session=${fx.sessionFor(user, opts)}`;

async function api(path, { method = 'GET', body, cookie = cookieFor(me), headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('FastPay decides who is signed in: forged, expired and tampered sessions are refused', async () => {
  assert.equal((await api('/api/session', { cookie: cookieFor(me, { secret: 'not-fastpays-secret' }) })).status, 401);
  assert.equal((await api('/api/session', { cookie: cookieFor(me, { expiresInSec: -60 }) })).status, 401);
  const [h, , sig] = fx.sessionFor(me).split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ sub: String(musa.id) })).toString('base64url')}.${sig}`;
  assert.equal((await api('/api/session', { cookie: `fp_session=${forged}` })).status, 401);
  assert.equal((await api('/api/session', { cookie: 'fp_session=not-a-token' })).status, 401);
});

test('the window refuses a wrong service key, and the module says so', async () => {
  const wrong = createFastPayApi({ baseUrl: fx.fastpayUrl, token: 'not-the-key' });
  assert.deepEqual(await wrong.check(), { ok: false, reason: 'FastPay did not accept the key (or INVESTIGATION_API_TOKEN is not set in server/.env).' });
  await assert.rejects(wrong.forCustomer(fx.sessionFor(me)), /did not accept the investigation key/);
  assert.deepEqual(await fx.api.check(), { ok: true });
});

test('not signed in to FastPay: 401 with a sign-in link', async () => {
  const r = await api('/api/session', { cookie: null });
  assert.equal(r.status, 401);
  assert.equal(r.body.signin_url, 'http://localhost:5173');
  assert.equal((await api('/api/cases', { cookie: cookieFor(me, { secret: 'wrong' }) })).status, 401);
});

test('signed in: the session shows the FastPay user', async () => {
  const r = await api('/api/session');
  assert.equal(r.status, 200);
  assert.equal(r.body.user.name, 'Abdul Ishaq');
  assert.equal(r.body.understanding, 'rules');
});

test('full flow over HTTP', async () => {
  const ref = fx.ledger.transfer({ senderUserId: me.id, recipientUserId: musa.id, amount: 5000, simulate: 'success' }).reference;
  let r = await api('/api/cases', { method: 'POST', body: { message: 'I sent Musa $50 today but he has not received it' } });
  assert.equal(r.status, 201);
  const id = r.body.case.id;
  assert.equal(r.body.case.candidates[0].reference, ref);

  r = await api(`/api/cases/${id}/investigate`, { method: 'POST', body: {} });
  assert.equal(r.status, 409);

  r = await api(`/api/cases/${id}/confirm`, { method: 'POST', body: { reference: ref } });
  assert.equal(r.status, 200);
  r = await api(`/api/cases/${id}/investigate`, { method: 'POST', body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.case.result.headline, 'Payment completed');
  assert.equal(r.body.case.report, undefined);

  r = await api(`/api/cases/${id}/result`);
  assert.equal(r.body.result.reference, ref);
  assert.equal(r.body.result.evidence, undefined);
  assert.equal((await api(`/api/cases/${id}/report`)).status, 404, 'customers have no route to the internal report');

  // Internal view: only with the staff token
  const internal = (token) => fetch(`${base}/internal/cases/${id}/report`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  assert.equal((await internal()).status, 404);
  assert.equal((await internal('wrong-token')).status, 404);
  const full = await (await internal('staff-token-123')).json();
  assert.equal(full.report.transaction.reference, ref);
  assert.ok(full.report.evidence.length > 0);
  assert.ok(full.audit.some((a) => a.event === 'REPORT_CREATED'));
  // A customer cookie does not open the internal API
  assert.equal((await fetch(`${base}/internal/cases`, { headers: { Cookie: cookieFor(me) } })).status, 404);

  r = await api('/api/cases');
  assert.equal(r.body.cases[0].id, id);

  // Musa can't read Abdul's case
  assert.equal((await api(`/api/cases/${id}`, { cookie: cookieFor(musa) })).status, 404);
});

test('rejects cross-site requests and non-JSON bodies', async () => {
  const cross = await api('/api/cases', { method: 'POST', body: { message: 'hi there $5' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  const form = await fetch(`${base}/api/cases`, { method: 'POST', headers: { Cookie: cookieFor(me), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'message=x' });
  assert.equal(form.status, 415);
  const empty = await api('/api/cases', { method: 'POST', body: { message: '   ' } });
  assert.equal(empty.status, 400);
});

test('serves the web page', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});
