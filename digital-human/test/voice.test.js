import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoice } from '../src/voice.js';
import { createServer } from '../src/server.js';
import { openStore } from '../src/store.js';

const quiet = { warn() {} };

function fakeYarn() {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers?.Authorization });
    if (opts.headers?.Authorization !== 'Bearer YK') return new Response(JSON.stringify({ error: { code: 'INVALID_API_KEY' } }), { status: 401 });
    if (url.endsWith('/api/v1/voices')) return Response.json([{ name: 'idera', languages: ['english', 'hausa'] }, { name: 'zainab' }]);
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } });
  };
  return { calls, fetchImpl };
}

test('speaks Hausa in her one female voice, as mp3', async () => {
  const y = fakeYarn();
  const v = createVoice({ apiKey: 'YK', fetchImpl: y.fetchImpl, log: quiet });
  const out = await v.speak('Na sami biyan kuɗi ɗaya na $50.00.', 'ha');
  assert.equal(out.contentType, 'audio/mpeg');
  assert.equal(out.audio.length, 6);
  assert.match(y.calls[0].url, /\/api\/v1\/streaming\/conversation$/);
  assert.deepEqual(y.calls[0].body, { text: 'Na sami biyan kuɗi ɗaya na $50.00.', voice: 'idera', output_format: 'mp3' });
});

test('voice ids can be changed in settings; the start-up check spots ones that do not exist', async () => {
  const y = fakeYarn();
  const v = createVoice({ apiKey: 'YK', voices: { yo: 'nobody' }, fetchImpl: y.fetchImpl, log: quiet });
  const c = await v.check();
  assert.match(c.message, /don't exist: yo=nobody/);
  assert.equal((await createVoice({ apiKey: 'BAD', fetchImpl: y.fetchImpl, log: quiet }).check()).message.includes('REJECTED'), true);
  assert.equal(createVoice({ apiKey: '' }).enabled, false);
});

test('a YarnGPT error becomes a clean 502, so the page falls back to the browser voice', async () => {
  const v = createVoice({ apiKey: 'YK', fetchImpl: async () => new Response('{"error":{"code":"QUOTA_EXCEEDED"}}', { status: 402 }), log: quiet });
  await assert.rejects(v.speak('Hello', 'en'), (err) => err.status === 502 && err.code === 'QUOTA_EXCEEDED');
});

test('/api/speak only voices her own recent replies to this customer', async (t) => {
  const y = fakeYarn();
  const voice = createVoice({ apiKey: 'YK', fetchImpl: y.fetchImpl, log: quiet });
  const store = openStore(':memory:');
  store.addTurn('ACC-1', null, 'assistant', 'ha', 'Sannu, me ya faru?');
  store.addTurn('ACC-2', null, 'assistant', 'en', 'Someone else reply');
  const bridge = { session: async (s) => { if (s !== 'S1') throw Object.assign(new Error('no'), { status: 401 }); return { user: { name: 'A', account_id: 'ACC-1' } }; } };
  const server = createServer({ config: { cookieName: 'fp_session', fastpayAppUrl: 'x', assistantName: 'T', languages: ['en'] }, bridge, orchestrator: {}, metaEnabled: true, voice, store });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const speak = (text, cookie = 'fp_session=S1') => fetch(`http://localhost:${server.address().port}/api/speak`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, language: 'ha' }) });

  const ok = await speak('Sannu, me ya faru?');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'audio/mpeg');
  assert.equal((await speak('Read out anything I like, on your credit')).status, 404);
  assert.equal((await speak('Someone else reply')).status, 404);
  assert.equal((await speak('Sannu, me ya faru?', '')).status, 401);
  assert.equal(y.calls.filter((c) => c.url.includes('conversation')).length, 1);
});
