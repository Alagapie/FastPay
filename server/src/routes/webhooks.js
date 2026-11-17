// PayPal webhook receiver: POST /api/paypal/webhook
// Every event is signature-checked with PayPal before anything happens, and processed at most once.
import express, { Router } from 'express';
import { config, paypalEnabled } from '../config.js';
import { db, nowIso } from '../db.js';
import * as paypal from '../paypal.js';
import { handleWebhookEvent } from '../paypalSync.js';

const router = Router();

const q = {
  seen: db.prepare('SELECT status FROM webhook_events WHERE id = ?'),
  insert: db.prepare(`INSERT INTO webhook_events (id, event_type, status, received_at) VALUES (?, ?, 'RECEIVED', ?)
                      ON CONFLICT(id) DO UPDATE SET status = 'RECEIVED', error = NULL`),
  done: db.prepare(`UPDATE webhook_events SET status = 'PROCESSED', resource_id = ? WHERE id = ?`),
  failed: db.prepare(`UPDATE webhook_events SET status = 'ERROR', error = ? WHERE id = ?`),
};

router.post('/paypal/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!paypalEnabled || !config.paypal.webhookId) {
    return res.status(503).json({ error: 'PayPal webhooks are not configured.' });
  }
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON.' });
  }

  let verified = false;
  try {
    verified = await paypal.verifyWebhookSignature(req.headers, raw);
  } catch (err) {
    console.error('[webhook] verification error', err.message);
    return res.status(502).json({ error: 'Could not verify with PayPal.' }); // PayPal will retry
  }
  if (!verified) {
    console.warn('[webhook] rejected event with invalid signature', event?.id);
    return res.status(400).json({ error: 'Invalid signature.' });
  }

  if (q.seen.get(event.id)?.status === 'PROCESSED') return res.json({ ok: true, duplicate: true });
  q.insert.run(event.id, event.event_type ?? 'UNKNOWN', nowIso());

  try {
    const resourceId = await handleWebhookEvent(event);
    q.done.run(resourceId ?? null, event.id);
    console.log(`[webhook] ${event.event_type} ${resourceId ?? ''}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[webhook] processing failed', event.event_type, err);
    q.failed.run(String(err.message).slice(0, 500), event.id);
    res.status(500).json({ error: 'Processing failed.' }); // non-2xx makes PayPal retry later
  }
});

export default router;
