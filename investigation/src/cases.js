// A case follows the module's four stages:
//   Understand -> Find -> Confirm -> Investigate -> Investigation Report
//
// Guardrails live here, in code:
//   - A customer only ever sees and investigates their own transactions.
//   - Only a transaction shown to them in this case can be confirmed.
//   - The investigation refuses to run until a confirmation is recorded.
//   - Every step is written to the append-only audit log.
import { understand } from './understand/index.js';
import { complaintLabel } from './understand/types.js';
import { canSearch, candidateDisplay, findCandidates, followUpQuestion } from './find/match.js';
import { investigateTransaction } from './investigate/engine.js';
import { whereItBroke } from './investigate/breakpoint.js';
import { assessIncident, worthChecking } from './investigate/incidents.js';
import { FINDINGS, RERUNNABLE } from './investigate/findings.js';
import { buildReport } from './report.js';
import { acknowledge, confirmed, firstNameOf, greeting, postResultIntent, postResultReply, resultMessage, smallTalk } from './conversation.js';
import { formatMoney, HttpError } from './util.js';

const MAX_MESSAGE = 1000;
const HISTORY_DAYS = 365;

function cleanMessage(message) {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new HttpError(400, 'Please describe the problem.');
  if (text.length > MAX_MESSAGE) throw new HttpError(400, `Please keep your message under ${MAX_MESSAGE} characters.`);
  return text;
}

// `user` is the signed-in customer from FastPay's investigation window: { id, name, account_id, wallet, api }.
// user.api can only read that customer's own records; it is the only way this service reaches FastPay.
// `resolution` (optional) is Module 3: it takes each report and decides what happens next.
export function createCaseService({ llm, store, config, resolution = null, now = () => new Date() }) {
  const inFlight = new Set();
  const actor = (user) => `customer:${user.id}`;

  function ownCase(user, caseId) {
    const c = store.getCase(caseId);
    // Same answer for "doesn't exist" and "not yours", so case IDs can't be probed.
    if (!c || c.user_id !== user.id) throw new HttpError(404, 'Case not found.');
    return c;
  }

  function walletOf(user) {
    if (!user.wallet) throw new HttpError(409, 'This FastPay account has no wallet.');
    return user.wallet;
  }

  function reply(caseId, text) {
    store.addMessage(caseId, 'support', text);
  }

  // ---- Stage 1 + 2 ----------------------------------------------------------------

  async function handleMessage(user, c, text) {
    store.addMessage(c.id, 'customer', text);
    store.audit(c.id, actor(user), 'CUSTOMER_MESSAGE', { text });

    // "hi" or "thanks" on its own: answer like a person, don't search for a payment.
    if (smallTalk(text) && !c.extraction) {
      reply(c.id, c.pinned
        ? `Hi ${firstNameOf(user.name)}. Tell me in your own words what went wrong with this ${c.pinned.display.amount_display} payment, and I'll look into it.`
        : greeting(user.name, store.messages(c.id).some((m) => m.role === 'support')));
      return view(user, c.id);
    }

    const u = await understand({ message: text, previous: c.extraction, llm, now: now(), timezone: config.timezone });
    store.audit(c.id, 'system', 'COMPLAINT_UNDERSTOOD', { method: u.method, warning: u.warning, extraction: u.extraction });
    return await search(user, { ...c, extraction: u.extraction });
  }

  async function search(user, c) {
    const ex = c.extraction;
    let candidates = [];
    const pinned = c.pinned && !c.excluded_refs.includes(c.pinned.reference) ? c.pinned : null;
    if (pinned) {
      // Opened from a payment in the FastPay app: that payment is the one to confirm (unless they say it isn't).
      candidates = [{ reference: pinned.reference, score: 100, reasons: ['The payment you opened from FastPay'], warnings: [], date_mismatch: false, display: { ...pinned.display, warnings: [], date_mismatch: false } }];
    } else if (canSearch(ex)) {
      const wallet = walletOf(user);
      const since = new Date(now().getTime() - HISTORY_DAYS * 86_400_000).toISOString();
      candidates = findCandidates({
        extraction: ex,
        walletId: wallet.id,
        transactions: await user.api.transactions({ since }),
        timezone: config.timezone,
        now: now(),
        exclude: c.excluded_refs,
      }).map((x) => ({ ...x, display: { ...x.display, warnings: x.warnings, date_mismatch: x.date_mismatch } }));
    }

    const status = candidates.length ? 'AWAITING_CONFIRMATION' : 'NEEDS_DETAILS';
    // Say "sorry, let's find out" once, on the first reply about the problem, not on every message.
    const firstReply = !store.auditFor(c.id).some((a) => a.event === 'TRANSACTIONS_SEARCHED');
    // For a payment opened from the app, the amount is known even if the customer didn't type it.
    const known = pinned && ex.amount_cents == null ? { ...ex, amount_cents: pinned.display.amount, currency: pinned.display.currency } : ex;
    const opener = firstReply ? `${acknowledge(known)} ` : '';
    store.transaction(() => {
      store.updateCase(c.id, { status, complaint_type: ex.complaint_type, extraction: ex, excluded_refs: c.excluded_refs });
      store.setCandidates(c.id, candidates);
    });
    store.audit(c.id, 'system', 'TRANSACTIONS_SEARCHED', { found: candidates.map((x) => ({ reference: x.reference, score: x.score })) });

    if (!candidates.length) {
      reply(c.id, `${opener}${followUpQuestion(ex, { searched: canSearch(ex) })}`);
    } else if (pinned) {
      reply(c.id, `${opener || 'Thanks. '}Before I check the records, please confirm this is the payment you mean.`);
    } else {
      const onOtherDay = candidates.every((x) => x.date_mismatch);
      const many = candidates.length > 1;
      // Never quietly treat a payment from another day as the one they meant: say so.
      const found = onOtherDay
        ? `I couldn't find a matching payment ${ex.date_range.label}, but I found ${many ? `${candidates.length} on a different day` : `this one from ${candidates[0].display.day_display}`}.`
        : many ? `I found ${candidates.length} payments that could match.` : 'I found this payment in your FastPay history.';
      const ask = onOtherDay
        ? `Please check the date carefully. ${many ? 'Is one of these the payment you mean?' : 'Is this the payment you mean?'}`
        : many ? 'Which one do you mean?' : 'Is this the one you mean?';
      reply(c.id, `${opener || 'Thanks, that helps. '}${found} ${ask}`);
    }
    return view(user, c.id);
  }

  async function openCase(user, message) {
    const text = cleanMessage(message);
    const c = store.createCase(user.id);
    store.audit(c.id, actor(user), 'CASE_OPENED', null);
    return handleMessage(user, c, text);
  }

  /**
   * Help opened from a payment in the FastPay app (FastPay links to /?ref=FP-…). The payment must be one
   * of this customer's own, and one they can see in FastPay: a receiver can't use a link to learn about
   * a transfer that never reached them, or a failed attempt.
   */
  async function openCaseForPayment(user, reference) {
    const ref = String(reference ?? '').trim().toUpperCase();
    const wallet = walletOf(user);
    const tx = /^[A-Z0-9-]{4,40}$/.test(ref) ? await user.api.transaction(ref) : null;
    const mine = tx && (tx.sender_wallet_id === wallet.id || tx.receiver_wallet_id === wallet.id);
    const hiddenFromReceiver = tx && tx.type === 'TRANSFER' && tx.sender_wallet_id !== wallet.id && !tx.credited_at;
    if (!mine || hiddenFromReceiver) throw new HttpError(404, 'That payment could not be found in your FastPay account.');

    const display = candidateDisplay(tx, wallet.id, config.timezone);
    const c = store.createCase(user.id, { reference: tx.reference, display });
    store.audit(c.id, actor(user), 'CASE_OPENED', { from: 'FASTPAY_APP', reference: tx.reference });
    const what = display.direction === 'OUT'
      ? `your ${display.amount_display} ${display.kind === 'Cash out to PayPal' ? 'cash out to PayPal' : `payment to ${display.counterparty}`}`
      : display.kind === 'Add money' ? `the ${display.amount_display} you added` : `the ${display.amount_display} from ${display.counterparty}`;
    reply(c.id, `Hi ${firstNameOf(user.name)}, I can see you need help with ${what} on ${display.day_display} (${tx.reference}). What went wrong with it?`);
    return view(user, c.id);
  }

  async function addMessage(user, caseId, message) {
    const text = cleanMessage(message);
    const c = ownCase(user, caseId);
    if (c.status === 'CONFIRMED' || c.status === 'INVESTIGATED') return converse(user, c, text);
    return handleMessage(user, c, text);
  }

  /** After the payment is confirmed the chat stays open: answer questions, or check again when asked. */
  async function converse(user, c, text) {
    store.addMessage(c.id, 'customer', text);
    store.audit(c.id, actor(user), 'CUSTOMER_MESSAGE', { text, after: c.status });
    const latest = store.latestReport(c.id);
    if (!latest) return investigate(user, c.id); // confirmed, but the check never finished: finish it now
    const intent = postResultIntent(text);
    store.audit(c.id, 'system', 'CHAT_INTENT', { intent });
    // Once Module 3 has a resolution for this case, its agent answers (except "check again" before anything ran).
    if (resolution?.handles(c.id)) {
      const done = Boolean(resolution.view(user, c.id)?.outcome);
      if (!(intent === 'CHECK' && RERUNNABLE.has(latest.finding.code) && !done)) {
        await resolution.handleMessage(user, c.id, text);
        return view(user, c.id);
      }
    }
    if (intent === 'CHECK' && RERUNNABLE.has(latest.finding.code)) return investigate(user, c.id, { again: true });
    reply(c.id, postResultReply(intent, latest.customer_view, { name: user.name, exceptionOpen: store.exception(c.id)?.status === 'OPEN' }));
    return view(user, c.id);
  }

  /** "None of these": hide the shown payments and ask for more detail. */
  function rejectCandidates(user, caseId) {
    const c = ownCase(user, caseId);
    if (c.status !== 'AWAITING_CONFIRMATION') throw new HttpError(409, 'There are no payments waiting for you to choose.');
    const shown = store.activeCandidates(c.id).map((x) => x.reference);
    const excluded = [...new Set([...c.excluded_refs, ...shown])];
    store.transaction(() => {
      store.updateCase(c.id, { status: 'NEEDS_DETAILS', complaint_type: c.complaint_type, extraction: c.extraction, excluded_refs: excluded });
      store.clearCandidates(c.id);
    });
    store.audit(c.id, actor(user), 'CANDIDATES_REJECTED', { references: shown });
    reply(c.id, "Okay, it's none of those. Tell me anything that could help me find it: the exact amount, the person's full name or email, or the day.");
    return view(user, c.id);
  }

  // ---- Stage 3 --------------------------------------------------------------------

  function confirm(user, caseId, reference) {
    const c = ownCase(user, caseId);
    const ref = String(reference ?? '').trim();
    const existing = store.confirmation(c.id);
    if (existing) {
      if (existing.reference === ref) return view(user, c.id); // double tap: same answer
      throw new HttpError(409, 'A different payment is already confirmed for this case.');
    }
    const shown = store.activeCandidates(c.id).some((x) => x.reference === ref);
    if (c.status !== 'AWAITING_CONFIRMATION' || !shown) {
      store.audit(c.id, actor(user), 'GUARD_BLOCKED', { action: 'confirm', reference: ref, reason: 'not one of the payments shown' });
      throw new HttpError(400, 'Please choose one of the payments shown to you.');
    }
    store.transaction(() => {
      store.confirm(c.id, ref, user.id);
      store.setStatus(c.id, 'CONFIRMED');
    });
    store.audit(c.id, actor(user), 'TRANSACTION_CONFIRMED', { reference: ref });
    const chosen = store.activeCandidates(c.id).find((x) => x.reference === ref);
    reply(c.id, confirmed(ref, chosen?.display?.channel === 'PayPal'));
    return view(user, c.id);
  }

  // ---- Stage 4 --------------------------------------------------------------------

  async function investigate(user, caseId, { again = false } = {}) {
    const c = ownCase(user, caseId);
    const confirmation = store.confirmation(c.id);
    if (!confirmation) {
      store.audit(c.id, actor(user), 'GUARD_BLOCKED', { action: 'investigate', reason: 'no confirmed transaction' });
      throw new HttpError(409, 'Please confirm which payment this is about before the investigation starts.');
    }
    const previous = store.latestReport(c.id);
    if (previous && !(again && RERUNNABLE.has(previous.finding.code))) return view(user, c.id);
    if (inFlight.has(c.id)) throw new HttpError(409, 'The investigation is already running.');

    inFlight.add(c.id);
    try {
      const wallet = walletOf(user);
      const tx = await user.api.transaction(confirmation.reference);
      const touchesWallet = tx && (tx.sender_wallet_id === wallet.id || tx.receiver_wallet_id === wallet.id);
      if (!touchesWallet) {
        store.audit(c.id, 'system', 'GUARD_BLOCKED', { action: 'investigate', reason: 'transaction not in customer wallet', reference: confirmation.reference });
        throw new HttpError(404, 'That payment could not be found in your FastPay account.');
      }

      store.audit(c.id, 'system', 'INVESTIGATION_STARTED', { reference: tx.reference, rerun: Boolean(previous) });
      const at = now();
      const result = await investigateTransaction({
        tx,
        viewerWalletId: wallet.id,
        viewerUserId: user.id,
        complaint: c.extraction,
        fastpay: user.api,
        paypal: user.api.paypal,
        now: at,
        timezone: config.timezone,
        processingWindowMinutes: config.processingWindowMinutes,
        onPayPalRead: (r) => store.audit(c.id, 'system', 'PAYPAL_RECORD_READ', r),
      });
      // Where it broke, and is it happening to others too? (counts only, from FastPay's window)
      const breakpoint = whereItBroke({ code: result.finding.code, kind: result.kind, facts: result.facts });
      let incident = assessIncident(undefined);
      if (worthChecking(result.finding.code, breakpoint)) {
        let signals = null;
        try {
          signals = await user.api.signals(tx.reference, { stuckAfter: config.processingWindowMinutes });
        } catch {
          signals = null; // can't tell: reported as UNAVAILABLE, never guessed
        }
        incident = assessIncident(signals, { kind: result.kind, breakpoint });
        if (incident.status === 'SUSPECTED') {
          const inc = store.linkIncident({
            caseId: c.id,
            signature: incident.signature,
            title: `${breakpoint.summary} (${incident.channel_label})`,
            likelyBug: breakpoint.likely_bug,
            signals,
          });
          incident = { ...incident, incident_id: inc.id, linked_cases: inc.case_count, title: inc.title };
          store.audit(c.id, 'system', 'INCIDENT_LINKED', { incident_id: inc.id, signature: incident.signature, reasons: incident.reasons });
        }
      }
      const statements = store.messages(c.id).filter((m) => m.role === 'customer').map((m) => m.body);
      const lastAudit = store.auditFor(c.id).filter((a) => a.event === 'COMPLAINT_UNDERSTOOD').at(-1);
      const report = buildReport({ caseRow: c, customer: user, statements, confirmation, tx, result, method: lastAudit?.detail?.method ?? 'rules', breakpoint, incident, timezone: config.timezone, now: at });

      store.transaction(() => {
        report.exception = recordException(c, tx, report, at);
        report.chat_position = store.messages(c.id).length; // the result card sits under the message that delivers it
        store.saveReport(report);
        store.setStatus(c.id, 'INVESTIGATED');
      });
      store.audit(c.id, 'system', 'REPORT_CREATED', {
        report_id: report.report_id, finding: report.finding.code, claim: report.claim_assessment.result, broke_at: breakpoint.party,
        incident: incident.status, exception: report.exception ? `${report.exception.id}:${report.exception.status}` : null,
      });
      reply(c.id, resultMessage(report.customer_view, { rerun: Boolean(previous), changed: previous?.finding.code !== report.finding.code }));
      // Module 3: decide what happens next. A failure there never loses the investigation result.
      if (resolution) {
        try {
          await resolution.afterReport(user, c.id, report);
        } catch (err) {
          console.error('[investigation] resolution failed', c.id, err);
          store.audit(c.id, 'system', 'RESOLUTION_FAILED', { error: String(err.message).slice(0, 300) });
        }
      }
      return view(user, c.id);
    } finally {
      inFlight.delete(c.id);
    }
  }

  /**
   * Exceptions: staff must act when money was not delivered, records disagree or evidence is missing,
   * or a payment stays pending past the expected time. One per case, with an owner and an escalation
   * time; a later check that settles it (completed, refunded, failed) closes it.
   */
  function recordException(c, tx, report, at) {
    const code = report.finding.code;
    const pendingFor = Math.round((at - new Date(report.facts.charged_at ?? report.facts.debited_at ?? tx.created_at)) / 60_000);
    const stuckPending = code === 'PAYMENT_PENDING' && pendingFor >= (config.pendingEscalationMinutes ?? 60);
    const existing = store.exception(c.id, at);
    if (FINDINGS[code].exception || stuckPending) {
      const reason = stuckPending
        ? `Still pending after ${pendingFor} minutes: ${report.pending?.says ?? 'no final status'}.`
        : `${report.finding.title}. ${report.broke_at?.summary ?? ''}`.trim();
      const exc = store.openException({
        caseId: c.id,
        reference: tx.reference,
        finding: code,
        reason,
        amount: report.amount_at_issue.amount,
        currency: tx.currency,
        owner: config.exceptionOwner ?? 'Payments operations',
        // Already late (stuck pending, or past the window): escalate now. Otherwise give the team its window.
        escalateAt: new Date(at.getTime() + (stuckPending ? 0 : (config.escalationMinutes ?? 60) * 60_000)).toISOString(),
        now: at,
      });
      store.audit(c.id, 'system', existing ? 'EXCEPTION_UPDATED' : 'EXCEPTION_OPENED', { exception_id: exc.id, finding: code, owner: exc.owner, escalate_at: exc.escalate_at });
      return exc;
    }
    if (existing?.status === 'OPEN') {
      const exc = store.closeException(c.id, `Re-investigated: ${code}`, at);
      store.audit(c.id, 'system', 'EXCEPTION_CLOSED', { exception_id: exc.id, finding: code });
      return exc;
    }
    return existing ?? null;
  }

  // ---- Reading ----------------------------------------------------------------------

  function resultFor(caseId) {
    const r = store.latestReport(caseId);
    return r ? { ...r.customer_view, after_message: r.chat_position ?? null } : null;
  }

  function view(user, caseId) {
    const c = ownCase(user, caseId);
    const ex = c.extraction;
    return {
      id: c.id,
      status: c.status,
      complaint_type: c.complaint_type,
      complaint_label: c.complaint_type ? complaintLabel(c.complaint_type) : null,
      // The payment this case was opened from in the FastPay app (null for a case started by typing).
      pinned: c.pinned ?? null,
      details: ex && {
        amount: ex.amount_cents != null ? formatMoney(ex.amount_cents, ex.currency ?? 'USD') : null,
        counterparty: ex.counterparty,
        when: ex.date_range?.label ?? null,
        date_range: ex.date_range,
      },
      messages: store.messages(c.id),
      candidates: c.status === 'AWAITING_CONFIRMATION' ? store.activeCandidates(c.id) : [],
      confirmation: store.confirmation(c.id),
      // The customer sees the plain explanation only. The full report is internal (see internalReport).
      result: resultFor(c.id),
      // Module 3: options, the confirmation card, or the outcome.
      resolution: resolution?.view(user, c.id) ?? null,
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
  }

  function listCases(user) {
    return store.casesForUser(user.id).map((c) => {
      const r = store.latestReport(c.id);
      return {
        id: c.id,
        status: c.status,
        complaint_label: c.complaint_type ? complaintLabel(c.complaint_type) : null,
        result: r?.customer_view.headline ?? null,
        reference: r?.transaction.reference ?? store.confirmation(c.id)?.reference ?? null,
        created_at: c.created_at,
      };
    });
  }

  // ---- Internal (staff / Module 3): the full report, evidence and audit trail -----------

  function internalReport(caseId) {
    const c = store.getCase(caseId);
    if (!c) throw new HttpError(404, 'Case not found.');
    const report = store.latestReport(c.id);
    if (!report) throw new HttpError(404, 'This case has no report yet.');
    return { report, audit: store.auditFor(c.id) };
  }

  function internalList(limit = 50) {
    return store.recentCases(limit).map((c) => {
      const r = store.latestReport(c.id);
      return { id: c.id, user_id: c.user_id, status: c.status, complaint_type: c.complaint_type, finding: r?.finding.code ?? null, reference: r?.transaction.reference ?? null, created_at: c.created_at };
    });
  }

  const internalExceptions = (status = 'OPEN') => store.exceptions(['OPEN', 'CLOSED', 'ALL'].includes(status) ? status : 'OPEN', 100, now());
  const internalIncidents = () => store.incidents();
  function internalIncident(id) {
    const inc = store.incident(id);
    if (!inc) throw new HttpError(404, 'Incident not found.');
    return inc;
  }

  return { openCase, openCaseForPayment, addMessage, rejectCandidates, confirm, investigate, getCase: view, listCases, internalReport, internalList, internalExceptions, internalIncidents, internalIncident };
}
