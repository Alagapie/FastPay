import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLanguageManager, missingTokens } from '../src/language.js';
import { createOrchestrator } from '../src/orchestrator.js';
import { createBridge } from '../src/bridge.js';
import { openStore } from '../src/store.js';
import { createServer } from '../src/server.js';

const quiet = { warn() {} };
const user = { name: 'Aisha Bello', account_id: 'FP-ACC-1' };

// ---- A mock Module 2, speaking its real HTTP API -------------------------------------------------

function mockModule2() {
  const calls = [];
  let c = null;
  const say = (body) => c.messages.push({ role: 'support', body });
  const candidates = [
    { reference: 'FP-TX-AAA', display: { amount_display: '$50.00', kind: 'PayPal top-up', direction: 'IN', counterparty: 'PayPal', when_display: 'Tue 11 Nov, 3:10 PM', channel: 'PayPal' } },
    { reference: 'FP-TX-BBB', display: { amount_display: '$50.00', kind: 'Transfer', direction: 'OUT', counterparty: 'Musa', when_display: 'Tue 11 Nov, 9:02 AM', channel: 'FastPay' } },
  ];
  const routes = {
    'GET /api/session': () => ({ user }),
    'POST /api/cases': (b) => {
      c = { id: 'CASE-1', status: 'AWAITING_CONFIRMATION', messages: [{ role: 'customer', body: b.message }], candidates, resolution: null, result: null };
      say('I found 2 payments that could match.');
      return { case: c };
    },
    'GET /api/cases/CASE-1': () => ({ case: c }),
    'POST /api/cases/CASE-1/messages': (b) => { c.messages.push({ role: 'customer', body: b.message }); say('Thanks.'); return { case: c }; },
    'POST /api/cases/CASE-1/none': () => { c.status = 'NEEDS_DETAILS'; c.candidates = []; say("Okay, it's none of those."); return { case: c }; },
    'POST /api/cases/CASE-1/confirm': (b) => {
      if (!c.candidates.some((x) => x.reference === b.reference)) return [409, { error: 'Not shown.' }];
      c.status = 'CONFIRMED'; c.candidates = []; c.confirmed = b.reference; say(`Thanks, I'm checking ${b.reference} now.`);
      return { case: c };
    },
    'POST /api/cases/CASE-1/investigate': () => {
      c.status = 'INVESTIGATED';
      c.result = { tone: 'bad', headline: 'Paid but not credited', status: 'PayPal took $50.00 but your wallet was not credited.', reference: c.confirmed, amount_display: '$50.00' };
      say('I found the issue. PayPal took $50.00 but your wallet was not credited.');
      c.resolution = { state: 'CHOOSE', simulated: true, options: [{ id: 'AUTH-1', title: 'Credit $50.00 to your FastPay wallet', detail: 'FastPay posts the missing credit.' }, { id: 'WAIT', title: 'Wait and check again later', detail: '' }] };
      return { case: c };
    },
    'POST /api/cases/CASE-1/resolution/choose': (b) => {
      c.resolution = { state: 'CONFIRM', simulated: true, confirm: { id: b.option_id, title: 'Credit $50.00 to your FastPay wallet', detail: 'x', amount_display: '$50.00', reference: c.confirmed, terms_hash: 'H1' } };
      return { case: c };
    },
    'POST /api/cases/CASE-1/resolution/approve': (b) => {
      if (b.terms_hash !== 'H1') return [409, { error: 'Terms changed.' }];
      c.resolution = { state: 'DONE', outcome: { title: 'Credited', status: 'VERIFIED' } };
      say("Done. $50.00 has been credited to your FastPay wallet, and I've confirmed it in FastPay's records.");
      return { case: c };
    },
  };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const ch of req) body += ch;
    const key = `${req.method} ${req.url}`;
    calls.push({ key, body: body ? JSON.parse(body) : null, cookie: req.headers.cookie });
    const fn = routes[key];
    let out = fn ? fn(body ? JSON.parse(body) : {}) : [404, { error: 'Not found.' }];
    if (!req.headers.cookie?.includes('fp_session=S1')) out = [401, { error: 'Please sign in.' }];
    const [status, data] = Array.isArray(out) ? out : [200, out];
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  });
  return { server, calls };
}

// ---- A mock Meta: Hausa in, Hausa out -------------------------------------------------------------

function mockMeta({ breakNumbers = false } = {}) {
  const understood = {
    'Na saka dollar 50 jiya amma kudin bai shiga wallet dina ba.': { language: 'ha', english: 'I deposited 50 dollars yesterday but the money did not enter my wallet.', intent: 'complaint', choice: null },
    'Na farko': { language: 'ha', english: 'The first one', intent: 'choose', choice: 1 },
    'Na daya, a saka min a wallet': { language: 'ha', english: 'Number one, put it in my wallet', intent: 'choose', choice: 1 },
    'Eh, na amince': { language: 'ha', english: 'Yes, I approve', intent: 'other', choice: null },
    'Babu ko daya': { language: 'ha', english: 'None of these', intent: 'none_of_these', choice: null },
  };
  return {
    enabled: true,
    async completeJson({ user: u }) {
      if (Array.isArray(u)) {
        const audio = u.find((p) => p.type === 'input_audio').input_audio.data;
        if (audio === 'SILENCE') return { heard: '' };
        return { heard: 'I send 50 dollars yesterday but e never enter my wallet', language: 'pcm', english: 'I sent 50 dollars yesterday but it never entered my wallet.', intent: 'complaint', choice: null };
      }
      const said = u.split('The customer said:\n')[1];
      return understood[said] ?? { language: 'ha', english: said, intent: 'other', choice: null };
    },
    async complete({ user: english }) {
      return breakNumbers ? `[ha] ${english.replace(/\$50\.00/g, '$5.00')}` : `[ha] ${english}`;
    },
  };
}

async function setup(metaOpts, languages) {
  const m2 = mockModule2();
  await new Promise((r) => m2.server.listen(0, r));
  const bridge = createBridge({ baseUrl: `http://localhost:${m2.server.address().port}`, cookieName: 'fp_session' });
  const language = createLanguageManager({ meta: mockMeta(metaOpts), understandModel: 'u', replyModel: 'r', log: quiet });
  const store = openStore(':memory:');
  const o = createOrchestrator({ bridge, language, store, languages });
  return { o, m2, bridge, store, close: () => m2.server.close() };
}

test('Hausa complaint -> Module 2 gets the English, customer hears Hausa with the payments read out', async (t) => {
  const { o, m2, close } = await setup();
  t.after(close);
  const r = await o.turn('S1', user, { text: 'Na saka dollar 50 jiya amma kudin bai shiga wallet dina ba.' });
  assert.equal(r.heard.language, 'ha');
  assert.equal(r.heard.intent, 'complaint');
  const open = m2.calls.find((c) => c.key === 'POST /api/cases');
  assert.equal(open.body.message, 'I deposited 50 dollars yesterday but the money did not enter my wallet.');
  assert.match(open.cookie, /fp_session=S1/);
  assert.equal(r.reply_language, 'ha');
  assert.match(r.reply, /^\[ha\] I found 2 payments/);
  assert.match(r.reply, /1\. \$50\.00 paypal top-up from PayPal/);
  assert.equal(r.case.candidates.length, 2);
});

test('"Na farko" confirms the first payment read out and runs the investigation', async (t) => {
  const { o, m2, close } = await setup();
  t.after(close);
  await o.turn('S1', user, { text: 'Na saka dollar 50 jiya amma kudin bai shiga wallet dina ba.' });
  const r = await o.turn('S1', user, { text: 'Na farko' });
  assert.deepEqual(m2.calls.find((c) => c.key.endsWith('/confirm')).body, { reference: 'FP-TX-AAA' });
  assert.ok(m2.calls.some((c) => c.key.endsWith('/investigate')));
  assert.match(r.reply, /I found the issue/);
  assert.match(r.reply, /Here are your options/);
  assert.equal(r.case.resolution.options.length, 2);
});

test('"None of these" goes to Module 2 as none-of-these', async (t) => {
  const { o, m2, close } = await setup();
  t.after(close);
  await o.turn('S1', user, { text: 'Na saka dollar 50 jiya amma kudin bai shiga wallet dina ba.' });
  await o.turn('S1', user, { text: 'Babu ko daya' });
  assert.ok(m2.calls.some((c) => c.key === 'POST /api/cases/CASE-1/none'));
});

test('voice can choose an option, but can NEVER approve: only the tap with the exact terms does', async (t) => {
  const { o, m2, close } = await setup();
  t.after(close);
  await o.turn('S1', user, { text: 'Na saka dollar 50 jiya amma kudin bai shiga wallet dina ba.' });
  await o.turn('S1', user, { text: 'Na farko' });
  const chose = await o.turn('S1', user, { text: 'Na daya, a saka min a wallet' });
  assert.equal(chose.case.resolution.state, 'CONFIRM');
  assert.match(chose.english, /tap the green Approve button/);

  // Saying "yes, I approve" only becomes a message. Nothing is approved.
  await o.turn('S1', user, { text: 'Eh, na amince' });
  assert.ok(!m2.calls.some((c) => c.key.endsWith('/approve')));

  const done = await o.tap('S1', user, { action: 'approve', authorization_id: 'AUTH-1', terms_hash: 'H1' });
  assert.deepEqual(m2.calls.find((c) => c.key.endsWith('/approve')).body, { authorization_id: 'AUTH-1', terms_hash: 'H1' });
  assert.match(done.reply, /\$50\.00 has been credited/);
});

test('a tampered approval is refused by Module 3 and the error comes back', async (t) => {
  const { o, close } = await setup();
  t.after(close);
  await o.turn('S1', user, { text: 'Na saka dollar 50 jiya amma kudin bai shiga wallet dina ba.' });
  await o.turn('S1', user, { text: 'Na farko' });
  await o.turn('S1', user, { text: 'Na daya, a saka min a wallet' });
  await assert.rejects(o.tap('S1', user, { action: 'approve', authorization_id: 'AUTH-1', terms_hash: 'FORGED' }), /Terms changed/);
});

test('a translation that changes an amount is never spoken: the English is used instead', async (t) => {
  const { o, close } = await setup({ breakNumbers: true });
  t.after(close);
  const r = await o.turn('S1', user, { text: 'Na saka dollar 50 jiya amma kudin bai shiga wallet dina ba.' });
  assert.equal(r.reply_language, 'en');
  assert.doesNotMatch(r.reply, /\$5\.00/);
  assert.match(r.reply, /\$50\.00/);
});

test('protected tokens: amounts and references must survive', () => {
  assert.deepEqual(missingTokens('Pay $1,250.00 for FP-TX-9Z', 'Biya $1250.00 don FP-TX-9Z'), []);
  assert.deepEqual(missingTokens('Pay $50.00 for FP-TX-9Z', 'Biya $5.00 don FP-TX-9'), ['$50.00', 'FP-TX-9Z']);
});

test('the conversation remembers language and case across turns', async (t) => {
  const { o, store, close } = await setup();
  t.after(close);
  await o.turn('S1', user, { text: 'Na saka dollar 50 jiya amma kudin bai shiga wallet dina ba.' });
  const conv = store.conversation(user.account_id);
  assert.equal(conv.language, 'ha');
  assert.equal(conv.case_id, 'CASE-1');
  const r = await o.resume('S1', user);
  assert.equal(r.case.id, 'CASE-1');
  assert.equal(r.turns.length, 2);
});

test('HTTP: without a FastPay session the page asks the customer to sign in; cross-site POSTs are refused', async (t) => {
  const { o, bridge, close } = await setup();
  const server = createServer({ config: { cookieName: 'fp_session', fastpayAppUrl: 'http://x', assistantName: 'Test' }, bridge, orchestrator: o, metaEnabled: true });
  await new Promise((r) => server.listen(0, r));
  t.after(() => { server.close(); close(); });
  const base = `http://localhost:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/session`)).status, 401);
  assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: 'fp_session=WRONG' } })).status, 401);
  assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: 'fp_session=S1' } })).status, 200);
  const cross = await fetch(`${base}/api/turn`, { method: 'POST', headers: { Cookie: 'fp_session=S1', Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{"text":"hi"}' });
  assert.equal(cross.status, 403);
});

test('with only English and Pidgin on, a Hausa speaker is understood but answered in English', async (t) => {
  const { o, m2, close } = await setup({}, ['en', 'pcm']);
  t.after(close);
  const r = await o.turn('S1', user, { text: 'Na saka dollar 50 jiya amma kudin bai shiga wallet dina ba.', language: 'en' });
  assert.equal(r.heard.spoken, 'ha');
  assert.equal(r.reply_language, 'en');
  assert.doesNotMatch(r.reply, /\[ha\]/);
  assert.equal(m2.calls.find((c) => c.key === 'POST /api/cases').body.message, 'I deposited 50 dollars yesterday but the money did not enter my wallet.');
});

test('a voice recording is heard by Meta, sent to Module 2 in English, and answered in Pidgin', async (t) => {
  const { o, m2, close } = await setup({}, ['en', 'pcm']);
  t.after(close);
  const r = await o.turn('S1', user, { audio: 'UklGRg==' });
  assert.equal(r.heard.heard, 'I send 50 dollars yesterday but e never enter my wallet');
  assert.equal(r.reply_language, 'pcm');
  assert.equal(m2.calls.find((c) => c.key === 'POST /api/cases').body.message, 'I sent 50 dollars yesterday but it never entered my wallet.');
  await assert.rejects(o.turn('S1', user, { audio: 'SILENCE' }), /didn't catch that/);
});

// ---- Voice inside the payment-help page --------------------------------------------------------

test('a spoken turn works on the case open on the page (Module 2 checks it is theirs)', async (t) => {
  const { o, m2, store, close } = await setup();
  t.after(close);
  await o.turn('S1', user, { text: 'Na saka dollar 50 jiya amma kudin bai shiga wallet dina ba.' });
  store.save(user.account_id, { language: 'ha', case_id: null }); // the voice service forgot it: the page still knows
  const r = await o.turn('S1', user, { text: 'Na farko', case_id: 'CASE-1' });
  assert.ok(m2.calls.some((c) => c.key === 'POST /api/cases/CASE-1/confirm'));
  assert.equal(r.case.id, 'CASE-1');
  // case_id: null means "no case on the page yet": a new one is opened, never an old one reused.
  await o.turn('S1', user, { text: 'Na saka dollar 50 jiya amma kudin bai shiga wallet dina ba.', case_id: null });
  assert.equal(m2.calls.filter((c) => c.key === 'POST /api/cases').length, 2);
});

test('after a tap on the page, the voice says what changed, in the customer\'s language', async (t) => {
  const { o, bridge, close } = await setup();
  t.after(close);
  await o.turn('S1', user, { text: 'Na saka dollar 50 jiya amma kudin bai shiga wallet dina ba.' });
  // The page itself confirmed + investigated (taps), then asks the voice to narrate.
  const before = await bridge.getCase('S1', 'CASE-1');
  const since = before.messages.length;
  await bridge.confirm('S1', 'CASE-1', 'FP-TX-AAA');
  await bridge.investigate('S1', 'CASE-1');
  const r = await o.narrateSince('S1', user, { case_id: 'CASE-1', since, language: 'ha', before_state: { status: 'AWAITING_CONFIRMATION', resolution: null } });
  assert.equal(r.reply_language, 'ha');
  assert.match(r.reply, /I'm checking FP-TX-AAA/);
  assert.match(r.reply, /I found the issue/);
  assert.match(r.reply, /Here are your options/);
  assert.doesNotMatch(r.reply, /I found 2 payments/, 'only what is new');
  await assert.rejects(o.narrateSince('S1', user, { case_id: 'CASE-NOPE', since: 0 }), /Case not found/);
});
