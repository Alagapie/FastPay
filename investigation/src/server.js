// HTTP API and the payment-help page. Built on node:http only; nothing to install.
//
//   GET  /api/session                       who is signed in (via FastPay's session cookie)
//   GET  /api/cases                         the customer's cases
//   POST /api/cases            {message}    Stage 1+2: open a case with the complaint
//   POST /api/cases/from-payment {reference} open a case from a payment in the FastPay app (/?ref=FP-…)
//   GET  /api/cases/:id
//   POST /api/cases/:id/messages {message}  add details / corrections
//   POST /api/cases/:id/none                "none of these"
//   POST /api/cases/:id/confirm {reference} Stage 3
//   POST /api/cases/:id/investigate {again} Stage 4 -> report
//   GET  /api/cases/:id/result              the customer's view of the result
//
// Module 3 (resolution). Money moves ONLY through /approve, with the terms hash from the card:
//   POST /api/cases/:id/resolution/choose  {option_id}                 show the confirmation card ('WAIT' = wait)
//   POST /api/cases/:id/resolution/back                                close the card
//   POST /api/cases/:id/resolution/approve {authorization_id, terms_hash} approve exactly what the card showed
//
// Internal (staff / Module 3), needs "Authorization: Bearer <INTERNAL_API_TOKEN>":
//   GET  /internal/cases                    recent cases
//   GET  /internal/cases/:id/report         the full report: evidence, checks, audit trail
//   GET  /internal/exceptions?status=OPEN   cases staff must act on: owner, age, escalation time, overdue
//   GET  /internal/incidents                suspected incidents (same broken step hitting many customers)
//   GET  /internal/incidents/:id            one incident and its linked cases
//   GET  /internal/resolutions              actions carried out (simulated in v1)
//   GET  /internal/resolutions/pending-staff  authorizations above the limit, waiting for staff
//   GET  /internal/cases/:id/resolution     decision, options, authorizations, outcome, audit
//   POST /internal/authorizations/:id/staff-approve {staff}
//   GET  /internal/resolution-audit/verify  recompute the audit hash chain
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { customerFromRequest } from './fastpay/session.js';
import { HttpError } from './util.js';

const PUBLIC_DIR = path.resolve(import.meta.dirname, '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/voice.js': ['voice.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};
const MAX_BODY = 20 * 1024;

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

async function readJson(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Send JSON (Content-Type: application/json).');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' ? body : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

/** Reject cross-site POSTs: the browser always sends Origin on them. */
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'Bad origin.');
  }
  if (host !== req.headers.host) throw new HttpError(403, 'Requests from other sites are not allowed.');
}

/** Constant-time check of the internal API token. Internal routes are off when no token is set. */
function internalAllowed(req, token) {
  if (!token) return false;
  const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(token);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

const MAX_VOICE_BODY = 4 * 1024 * 1024; // a ~45 s recording, base64

/**
 * FastPay Voice (Module 4) lives on this page: /voice/api/* is passed to the voice service, with the
 * customer's own cookie. Same origin for the browser, so sign-in and this page's security policy stay as they are.
 * The voice service only calls this module's own customer API back; it never touches money itself.
 */
async function proxyVoice(req, res, route, search, voiceUrl) {
  if (!voiceUrl) throw new HttpError(404, 'Not found.');
  if (req.method === 'POST') checkOrigin(req);
  let body;
  if (req.method === 'POST') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_VOICE_BODY) throw new HttpError(413, 'The recording is too long. Please keep it under 30 seconds.');
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }
  let r;
  try {
    r = await fetch(`${voiceUrl}${route.slice('/voice'.length)}${search}`, {
      method: req.method,
      headers: { Cookie: String(req.headers.cookie ?? ''), 'Content-Type': String(req.headers['content-type'] ?? 'application/json') },
      body,
      signal: AbortSignal.timeout(150_000),
    });
  } catch {
    return send(res, 503, { error: 'Voice is not available right now. You can still type.' });
  }
  const data = Buffer.from(await r.arrayBuffer());
  res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

export function createServer({ service, api, config, llm, resolution = null }) {
  const session = { api, cookieName: config.fastpay.cookieName };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;

    if (req.method === 'GET' && STATIC[route]) {
      const [file, type] = STATIC[route];
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; media-src 'self' blob:; frame-ancestors 'none'",
      });
      return res.end(fs.readFileSync(path.join(PUBLIC_DIR, file)));
    }
    if (route === '/health') return send(res, 200, { ok: true });
    if (route.startsWith('/voice/api/')) return proxyVoice(req, res, route, url.search, config.voiceUrl);

    if (route.startsWith('/internal/')) {
      // Same 404 as an unknown route, so the internal API isn't advertised to customers.
      if (!internalAllowed(req, config.internalToken)) throw new HttpError(404, 'Not found.');
      if (req.method === 'GET' && route === '/internal/cases') return send(res, 200, { cases: service.internalList() });
      if (req.method === 'GET' && route === '/internal/incidents') return send(res, 200, { incidents: service.internalIncidents() });
      if (req.method === 'GET' && route === '/internal/exceptions') {
        return send(res, 200, { exceptions: service.internalExceptions(String(url.searchParams.get('status') ?? 'OPEN').toUpperCase()) });
      }
      if (resolution) {
        if (req.method === 'GET' && route === '/internal/resolutions') return send(res, 200, { resolutions: resolution.internal.resolutions() });
        if (req.method === 'GET' && route === '/internal/resolutions/pending-staff') return send(res, 200, { authorizations: resolution.internal.pendingStaff() });
        if (req.method === 'GET' && route === '/internal/resolution-audit/verify') return send(res, 200, resolution.internal.verifyAudit());
        const rc = route.match(/^\/internal\/cases\/([A-Z0-9-]{1,40})\/resolution$/);
        if (req.method === 'GET' && rc) return send(res, 200, resolution.internal.case(rc[1]));
        const sa = route.match(/^\/internal\/authorizations\/([A-Z0-9-]{1,40})\/staff-approve$/);
        if (req.method === 'POST' && sa) {
          const body = await readJson(req);
          return send(res, 200, { authorization: resolution.staffApprove(sa[1], body.staff) });
        }
      }
      const ii = route.match(/^\/internal\/incidents\/([A-Z0-9-]{1,40})$/);
      if (req.method === 'GET' && ii) return send(res, 200, { incident: service.internalIncident(ii[1]) });
      const im = route.match(/^\/internal\/cases\/([A-Z0-9-]{1,40})\/report$/);
      if (req.method === 'GET' && im) return send(res, 200, service.internalReport(im[1]));
      throw new HttpError(404, 'Not found.');
    }
    if (!route.startsWith('/api/')) throw new HttpError(404, 'Not found.');

    const user = await customerFromRequest(req, session);
    if (route === '/api/session' && req.method === 'GET') {
      if (!user) return send(res, 401, { error: 'Please sign in to FastPay first.', signin_url: config.fastpay.appUrl });
      return send(res, 200, {
        user: { name: user.name, account_id: user.account_id },
        fastpay_url: config.fastpay.appUrl,
        understanding: llm.enabled ? 'meta' : 'rules',
        paypal: 'checked by FastPay',
      });
    }
    if (!user) throw new HttpError(401, 'Please sign in to FastPay first.');
    if (req.method === 'POST') checkOrigin(req);

    if (route === '/api/cases') {
      if (req.method === 'GET') return send(res, 200, { cases: service.listCases(user) });
      if (req.method === 'POST') {
        const body = await readJson(req);
        return send(res, 201, { case: await service.openCase(user, body.message) });
      }
    }

    // Opened from a payment in the FastPay app.
    if (route === '/api/cases/from-payment' && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 201, { case: await service.openCaseForPayment(user, body.reference) });
    }

    const rm = route.match(/^\/api\/cases\/([A-Z0-9-]{1,40})\/resolution\/(choose|back|approve)$/);
    if (rm && resolution && req.method === 'POST') {
      const [, id, step] = rm;
      service.getCase(user, id); // 404 unless it's this customer's case
      const body = await readJson(req);
      if (step === 'choose') resolution.choose(user, id, String(body.option_id ?? ''));
      if (step === 'back') resolution.back(user, id);
      if (step === 'approve') await resolution.approve(user, id, String(body.authorization_id ?? ''), body.terms_hash);
      return send(res, 200, { case: service.getCase(user, id) });
    }

    const m = route.match(/^\/api\/cases\/([A-Z0-9-]{1,40})(?:\/(messages|none|confirm|investigate|result))?$/);
    if (m) {
      const [, id, action] = m;
      if (!action && req.method === 'GET') {
        const own = service.getCase(user, id); // 404 unless it's this customer's case
        // Anything staff approved since the last visit is carried out now (with live checks).
        if (resolution?.handles(own.id)) await resolution.settle(user, own.id);
        return send(res, 200, { case: service.getCase(user, id) });
      }
      if (action === 'result' && req.method === 'GET') {
        const { result } = service.getCase(user, id);
        if (!result) throw new HttpError(404, 'This case has no result yet.');
        return send(res, 200, { result });
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (action === 'messages') return send(res, 200, { case: await service.addMessage(user, id, body.message) });
        if (action === 'none') return send(res, 200, { case: service.rejectCandidates(user, id) });
        if (action === 'confirm') return send(res, 200, { case: service.confirm(user, id, body.reference) });
        if (action === 'investigate') return send(res, 200, { case: await service.investigate(user, id, { again: body.again === true }) });
      }
    }
    throw new HttpError(404, 'Not found.');
  }

  return http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error('[investigation] request failed', req.method, req.url, err);
      send(res, 500, { error: 'Something went wrong on our side. Please try again.' });
    }
  });
}
