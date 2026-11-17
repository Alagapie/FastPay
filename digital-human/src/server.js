// FastPay Voice: an API behind the payment-help page (Module 2 proxies /voice/* to it). No page of its own.
//   GET  /api/session   who is signed in (asked of Module 2, which asks FastPay)
//   GET  /api/resume    language, current case and recent turns
//   POST /api/turn      {text, language?}   the customer typed something (or the browser heard it)
//   POST /api/turn-audio {audio, language?} the customer's recording (16 kHz mono WAV, base64), heard by Meta
//   POST /api/speak     {text, language}    her voice for one of HER OWN recent replies (audio/mpeg)
//   POST /api/tap       {action, ...}       the customer tapped a card (confirm / none / choose / back / check_again / approve)
//   POST /api/narrate   {case_id, since, language, before_state?}  say what changed after a tap on the help page
//   POST /api/new                           start over with a new problem
import http from 'node:http';
import { BridgeError } from './bridge.js';

const MAX_BODY = 16 * 1024;
const MAX_AUDIO_BODY = 3 * 1024 * 1024; // ~45 s of 16 kHz mono WAV, base64

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    return body && typeof body === 'object' ? body : {};
  } catch {
    throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
  }
}

function sessionCookie(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Reject cross-site POSTs (the browser always sends Origin on them). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function createServer({ config, bridge, orchestrator, metaEnabled, voice = { enabled: false }, store = null }) {
  async function handle(req, res) {
    const route = new URL(req.url, 'http://localhost').pathname;
    // The voice lives in the payment-help page: opening this service directly goes there.
    if (req.method === 'GET' && route === '/') {
      res.writeHead(302, { Location: config.helpUrl ?? 'http://localhost:4100' });
      return res.end();
    }
    if (route === '/health') return send(res, 200, { ok: true });
    if (!route.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });

    const signIn = { error: 'Please sign in to FastPay first.', signin_url: config.fastpayAppUrl };
    const session = sessionCookie(req, config.cookieName);
    if (!session) return send(res, 401, signIn);
    let user;
    try {
      user = (await bridge.session(session)).user;
    } catch (err) {
      if (err.status === 401) return send(res, 401, signIn);
      throw err;
    }
    if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, { error: 'Requests from other sites are not allowed.' });

    if (route === '/api/session' && req.method === 'GET') {
      return send(res, 200, { user: { name: user.name }, languages: config.languages, voice_output: voice.enabled ? 'yarngpt' : 'browser', voice_input: metaEnabled ? 'meta' : 'browser', understanding: metaEnabled ? 'meta' : 'rules (English only)' });
    }
    if (route === '/api/resume' && req.method === 'GET') return send(res, 200, await orchestrator.resume(session, user));
    if (route === '/api/turn' && req.method === 'POST') return send(res, 200, await orchestrator.turn(session, user, await readJson(req)));
    if (route === '/api/turn-audio' && req.method === 'POST') {
      const body = await readJson(req, MAX_AUDIO_BODY);
      if (typeof body.audio !== 'string' || !body.audio) return send(res, 400, { error: 'No recording was sent.' });
      return send(res, 200, await orchestrator.turn(session, user, { audio: body.audio, language: body.language }));
    }
    if (route === '/api/speak' && req.method === 'POST') {
      const body = await readJson(req);
      const text = String(body.text ?? '');
      // Only what she just said to this customer, so the voice credit can't be used for anything else.
      if (!voice.enabled || !store?.recentReplies(user.account_id).includes(text)) return send(res, 404, { error: 'Nothing to say.' });
      const { audio, contentType } = await voice.speak(text, String(body.language ?? 'en'));
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'Content-Length': audio.length });
      return res.end(audio);
    }
    if (route === '/api/narrate' && req.method === 'POST') return send(res, 200, await orchestrator.narrateSince(session, user, await readJson(req)));
    if (route === '/api/tap' && req.method === 'POST') return send(res, 200, await orchestrator.tap(session, user, await readJson(req)));
    if (route === '/api/new' && req.method === 'POST') {
      orchestrator.startOver(user);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Not found.' });
  }

  return http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (err instanceof BridgeError || err.status) return send(res, err.status || 502, { error: err.message });
      console.error('[voice] request failed', req.method, req.url, err);
      send(res, 500, { error: 'Something went wrong on our side. Please try again.' });
    }
  });
}
