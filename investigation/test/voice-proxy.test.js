// The voice (Module 4) lives on this page: /voice/api/* is passed to the voice service with the customer's cookie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/server.js';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

test('voice requests reach the voice service with the cookie; cross-site posts and a missing service are handled', async (t) => {
  const seen = [];
  const voice = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, cookie: req.headers.cookie, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, reply: 'Ina kwana' }));
  });
  const voiceUrl = await listen(voice);
  const config = { voiceUrl, fastpay: { cookieName: 'fp_session', appUrl: 'x' }, internalToken: '' };
  const page = createServer({ service: {}, api: {}, config, llm: { enabled: false } });
  const base = await listen(page);
  const off = createServer({ service: {}, api: {}, config: { ...config, voiceUrl: 'http://127.0.0.1:1' }, llm: { enabled: false } });
  const offBase = await listen(off);
  t.after(() => { voice.close(); page.close(); off.close(); });

  const r = await fetch(`${base}/voice/api/turn`, { method: 'POST', headers: { Cookie: 'fp_session=S1', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hi', case_id: 'CASE-1' }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).reply, 'Ina kwana');
  assert.deepEqual(seen[0], { method: 'POST', url: '/api/turn', cookie: 'fp_session=S1', body: JSON.stringify({ text: 'hi', case_id: 'CASE-1' }) });

  const cross = await fetch(`${base}/voice/api/turn`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(cross.status, 403);
  assert.equal(seen.length, 1, 'never forwarded');

  const down = await fetch(`${offBase}/voice/api/session`);
  assert.equal(down.status, 503, 'no voice service: a clean answer, the page keeps working by typing');
});
