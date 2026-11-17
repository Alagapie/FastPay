// FastPay Module 3: Decision and Resolution.
//
//   Case Evaluator      policy.evaluate   is this case eligible, and is the report still true?
//   Resolution Planner  policy.plan       the only options that exist, with exact terms
//   Approval Manager    authorizations    server-side, single-use, bound to case + payment + action + amount
//   Action Executor     executor.js       simulated in v1; idempotent; verified by reading the result back
//   Audit Recorder      store.audit       append-only, hash-chained
//
// It answers: "What should happen next, and are we authorized to do it?"
// The agent (agent.js) talks and orchestrates; it has no way to approve or execute.
import { describeOption, evaluate, MONEY_ACTIONS, plan as planFor } from './policy.js';
import { createAgent, intentFromText } from './agent.js';
import { createFastPayExecutor, createSimulatedExecutor } from './executor.js';
import { openStore } from './store.js';
import { canonical, formatMoney, HttpError, newId, sha256 } from './util.js';

export { openStore, createAgent, createFastPayExecutor, createSimulatedExecutor };

export const DEFAULT_SETTINGS = {
  approvalMinutes: 30, // how long a confirmation card can be approved
  reportMaxAgeMinutes: 30, // older than this: check again before resolving
  autoReturnHours: 24, // a stuck balance transfer is returned by policy after this long
  autoLimitCents: null, // above this, staff must approve as well (null = off: the policy decides alone)
  policyHoldDays: 7, // how long a policy authorization waits for staff
};

/**
 * @param store     openStore(...)
 * @param executor  createSimulatedExecutor(...) (later: the FastPay executor)
 * @param agent     createAgent(...) or { enabled: false }
 * @param cases     { latestReport(caseId), messages(caseId), say(caseId, text) } from the investigation module
 */
export function createResolutionService({ store, executor, agent = { enabled: false }, cases, settings: s = {}, now = () => new Date() }) {
  const settings = { ...DEFAULT_SETTINGS, ...s };
  const iso = () => now().toISOString();
  const customer = (user) => `customer:${user.id}`;
  const running = new Set();
  const suggested = new Map(); // caseId -> option id highlighted by the agent

  const termsOf = (a) => ({ authorization_id: a.id, case_id: a.case_id, user_id: a.user_id, reference: a.reference, action: a.action, amount: a.amount, currency: a.currency, target: a.target });
  const hashTerms = (a) => sha256(canonical(termsOf(a)));

  function ownPlan(user, caseId) {
    const p = store.plan(caseId);
    if (!p || p.user_id !== user.id) throw new HttpError(404, 'There is no resolution for this case.');
    return p;
  }

  async function liveTx(user, reference) {
    const tx = await user.api.transaction(reference);
    const mine = tx && (tx.sender_wallet_id === user.wallet?.id || tx.receiver_wallet_id === user.wallet?.id);
    return mine ? tx : null;
  }

  // ---- Evaluate + plan (runs after every investigation report) --------------------------------

  async function afterReport(user, caseId, report) {
    const at = now();
    const ref = report.transaction.reference;
    const live = await liveTx(user, ref);
    const prior = store.resolutionForRef(ref);
    let decision = evaluate({ report, live, viewer: { walletId: user.wallet?.id }, prior, settings, now: at });
    let plan = decision.code === 'ELIGIBLE' ? planFor({ report, live, settings, now: at }) : null;

    // Duplicates: the extra payment is the later one. Read both live, return that one.
    if (plan?.rule === 'duplicate:return-extra') {
      const other = await liveTx(user, plan.duplicate_of);
      const [, extra] = [live, other].filter(Boolean).sort((a, b) => a.created_at.localeCompare(b.created_at));
      if (!other || !extra || store.resolutionForRef(extra.reference) || extra.reversed_at || extra.amount !== live.amount) {
        decision = { code: 'NEEDS_STAFF', label: 'A person must review this case', reason: 'The duplicate could not be confirmed from the live records.' };
        plan = null;
      } else {
        // A balance transfer goes back as a correcting transfer. A PayPal duplicate also needs the
        // recipient's wallet debited, so a person handles it.
        if (extra.provider !== 'FASTPAY' || extra.type !== 'TRANSFER') {
          plan = { type: 'STAFF', rule: 'duplicate:paypal-review', options: [{ action: 'ESCALATE', rule: 'duplicate:paypal-review' }], why: 'The duplicate was paid with PayPal. Our payments team will refund it.' };
        } else {
          plan.options = [{
            action: 'RETURN_TO_WALLET', rule: 'duplicate:return-extra', amount: extra.amount, currency: extra.currency, reference: extra.reference,
            target: { type: 'FASTPAY_WALLET', wallet_id: extra.sender_wallet_id, name: 'your FastPay balance' },
          }];
        }
      }
    }

    store.transaction(() => {
      // A new report replaces whatever was on offer from the previous one.
      const cancelled = store.cancelOpen(caseId, `Superseded by report ${report.report_id}`, iso());
      if (cancelled) store.audit(caseId, 'system', 'OFFERS_SUPERSEDED', { count: cancelled, report_id: report.report_id });
      store.savePlan({ caseId, reportId: report.report_id, reference: ref, userId: user.id, decision, plan }, iso());
      store.audit(caseId, 'system', 'CASE_EVALUATED', { report_id: report.report_id, finding: report.finding.code, decision: decision.code, reason: decision.reason });
      if (!plan) return;
      store.audit(caseId, 'system', 'RESOLUTION_PLANNED', { type: plan.type, rule: plan.rule, options: plan.options.map((o) => ({ action: o.action, amount: o.amount, target: o.target })) });
      for (const o of plan.options.filter((x) => MONEY_ACTIONS.has(x.action))) {
        const a = {
          id: newId('AUTH', at), case_id: caseId, report_id: report.report_id, user_id: user.id, reference: o.reference ?? ref,
          action: o.action, amount: o.amount, currency: o.currency, target: o.target, kind: plan.type, rule: o.rule,
          needs_customer: plan.type === 'CUSTOMER_CHOICE', needs_staff: settings.autoLimitCents != null && o.amount > settings.autoLimitCents,
          // Policy authorizations are approved by the rule itself; customer ones start as offers.
          status: plan.type === 'POLICY' ? 'APPROVED' : 'OFFERED',
          expires_at: new Date(at.getTime() + (plan.type === 'POLICY' ? settings.policyHoldDays * 86_400_000 : settings.approvalMinutes * 60_000)).toISOString(),
          created_at: iso(),
        };
        a.terms_hash = hashTerms(a);
        store.insertAuthorization(a);
        store.audit(caseId, plan.type === 'POLICY' ? `policy:${o.rule}` : 'system', plan.type === 'POLICY' ? 'POLICY_AUTHORIZED' : 'OPTION_OFFERED',
          { authorization_id: a.id, action: a.action, amount: a.amount, currency: a.currency, needs_staff: a.needs_staff, terms_hash: a.terms_hash });
      }
    });

    cases.say(caseId, introMessage(decision, plan, report));
    if (plan?.type === 'POLICY') await settle(user, caseId);
    else if (plan?.type === 'STAFF') store.audit(caseId, 'system', 'ESCALATED', { reason: plan.why, by: 'policy' });
  }

  function introMessage(decision, plan, report) {
    const amt = report.amount_at_issue?.display ?? report.transaction.amount_display;
    if (decision.code === 'ALREADY_RESOLVED') return 'This payment has already been resolved. You can see the outcome below.';
    if (decision.code === 'NEEDS_RECHECK') return 'Before anything is done about this payment, I need to check it again. Tap "Check again".';
    if (decision.code === 'NEEDS_STAFF') return "I've passed this to our payments team, because it needs a person to review it. Nothing will change until they do, and you don't need to send the money again.";
    if (!plan) return null;
    if (plan.type === 'STAFF') return `${plan.why} You don't need to do anything.`;
    if (plan.type === 'POLICY') {
      const needsStaff = settings.autoLimitCents != null && plan.options[0]?.amount > settings.autoLimitCents;
      return `${plan.why}${needsStaff ? ' Because of the amount, a member of our team approves it first.' : ''}`;
    }
    return `Here's what we can do about the ${amt}. Choose one option below. Nothing happens until you approve it.`;
  }

  // ---- Approval Manager ---------------------------------------------------------------------

  function openAuth(user, caseId, authId) {
    ownPlan(user, caseId);
    const a = store.authorization(authId);
    if (!a || a.case_id !== caseId || a.user_id !== user.id) throw new HttpError(404, 'That option is not available.');
    return a;
  }

  function expireIfDue(a) {
    if (['OFFERED', 'CONFIRMING', 'APPROVED'].includes(a.status) && now() >= new Date(a.expires_at)) {
      if (store.moveAuthorization(a.id, a.status, 'EXPIRED', 'Expired before it was used', iso())) {
        store.audit(a.case_id, 'system', 'AUTHORIZATION_EXPIRED', { authorization_id: a.id });
      }
      return true;
    }
    return false;
  }

  /** The customer picks an option: show the exact terms they are about to approve. */
  function choose(user, caseId, optionId, { by = customer(user) } = {}) {
    if (optionId === 'WAIT') {
      store.transaction(() => {
        for (const x of store.authorizationsFor(caseId)) if (x.status === 'CONFIRMING') store.moveAuthorization(x.id, 'CONFIRMING', 'OFFERED', 'Customer chose to wait', iso());
      });
      store.audit(caseId, by, 'CUSTOMER_CHOSE_WAIT', null);
      return view(user, caseId);
    }
    const a = openAuth(user, caseId, optionId);
    if (a.kind !== 'CUSTOMER_CHOICE') throw new HttpError(409, 'This one is not a choice.');
    if (expireIfDue(a)) throw new HttpError(409, 'That option has expired. Please check again.');
    if (a.status === 'CONFIRMING') return view(user, caseId);
    if (a.status !== 'OFFERED') throw new HttpError(409, 'That option is no longer available.');
    store.transaction(() => {
      for (const x of store.authorizationsFor(caseId)) if (x.status === 'CONFIRMING') store.moveAuthorization(x.id, 'CONFIRMING', 'OFFERED', 'Customer picked another option', iso());
      store.moveAuthorization(a.id, 'OFFERED', 'CONFIRMING', null, iso());
    });
    store.audit(caseId, by, 'OPTION_SELECTED', { authorization_id: a.id, action: a.action, amount: a.amount, terms_hash: a.terms_hash });
    return view(user, caseId);
  }

  /** Back out of the confirmation card. */
  function back(user, caseId) {
    ownPlan(user, caseId);
    for (const x of store.authorizationsFor(caseId)) if (x.status === 'CONFIRMING') store.moveAuthorization(x.id, 'CONFIRMING', 'OFFERED', 'Customer went back', iso());
    store.audit(caseId, customer(user), 'CONFIRMATION_DISMISSED', null);
    return view(user, caseId);
  }

  /**
   * The customer taps Approve. `termsHash` is the hash of the terms shown on the card: if anything
   * about the action differs from what they saw, nothing runs.
   */
  async function approve(user, caseId, authId, termsHash) {
    const a = openAuth(user, caseId, authId);
    const block = (reason) => {
      store.audit(caseId, customer(user), 'APPROVAL_REJECTED', { authorization_id: authId, reason });
      throw new HttpError(409, reason);
    };
    if (a.kind !== 'CUSTOMER_CHOICE') block('This action is not waiting for your approval.');
    if (expireIfDue(a)) block('This confirmation has expired. Please choose again.');
    if (a.status !== 'CONFIRMING') block(a.status === 'CONSUMED' ? 'This approval has already been used.' : 'Please choose this option first.');
    if (typeof termsHash !== 'string' || termsHash !== a.terms_hash || hashTerms(a) !== a.terms_hash) block('The details you approved do not match this action.');
    if (!store.customerApprove(a.id, iso())) block('This approval has already been used.');
    store.audit(caseId, customer(user), 'CUSTOMER_APPROVED', { authorization_id: a.id, action: a.action, amount: a.amount, currency: a.currency, terms_hash: a.terms_hash });
    await settle(user, caseId);
    return view(user, caseId);
  }

  /** Staff approval for amounts above the limit. Execution happens with the customer's next visit. */
  function staffApprove(authId, staff) {
    const name = String(staff ?? '').trim().slice(0, 80);
    if (!name) throw new HttpError(400, 'Say who is approving (staff).');
    const a = store.authorization(authId);
    if (!a || !a.needs_staff) throw new HttpError(404, 'No staff approval is waiting with that id.');
    if (expireIfDue(a) || !['OFFERED', 'CONFIRMING', 'APPROVED'].includes(a.status)) throw new HttpError(409, 'That authorization is no longer open.');
    if (!store.staffApprove(a.id, name, iso())) throw new HttpError(409, 'Already approved by staff.');
    store.audit(a.case_id, `staff:${name}`, 'STAFF_APPROVED', { authorization_id: a.id, action: a.action, amount: a.amount });
    return store.authorization(a.id);
  }

  // ---- Action Executor ------------------------------------------------------------------------

  /** Run every authorization on this case that has all the approvals it needs. Safe to call any time. */
  async function settle(user, caseId) {
    if (running.has(caseId)) return;
    running.add(caseId);
    try {
      for (const a of store.authorizationsFor(caseId)) {
        if (a.user_id !== user.id || a.status !== 'APPROVED' || expireIfDue(a)) continue;
        if (a.needs_staff && !a.staff_approved_at) continue;
        await execute(user, a);
      }
    } finally {
      running.delete(caseId);
    }
  }

  async function execute(user, a) {
    const caseId = a.case_id;
    const authorizedBy = [a.kind === 'POLICY' ? `policy:${a.rule}` : customer(user), a.staff_approved_by ? `staff:${a.staff_approved_by}` : null].filter(Boolean).join(' + ');
    const cancel = (reason) => {
      store.moveAuthorization(a.id, 'APPROVED', 'CANCELLED', reason, iso());
      store.audit(caseId, 'system', 'EXECUTION_CANCELLED', { authorization_id: a.id, reason });
      cases.say(caseId, `I didn't go ahead: ${reason} Nothing was charged, credited or refunded.`);
    };

    // 1. Check again, live, right before acting: the world may have changed since the report.
    if (hashTerms(a) !== a.terms_hash) return cancel('the action no longer matches what was approved.');
    let live;
    try {
      live = await liveTx(user, a.reference);
    } catch {
      store.audit(caseId, 'system', 'PREFLIGHT_UNAVAILABLE', { authorization_id: a.id });
      return cases.say(caseId, "I couldn't reach FastPay to double-check the payment, so nothing was done yet. I'll try again next time you open this case.");
    }
    if (!live) return cancel('the payment is no longer in your account.');
    if (live.currency !== a.currency || live.amount < a.amount) return cancel('the payment no longer matches the approved amount.');
    if (live.reversed_at) return cancel('FastPay has since returned this money.');
    const duplicate = a.rule === 'duplicate:return-extra';
    if (!duplicate && live.credited_at) return cancel('the credit has since been recorded, so the money already arrived.');
    if (a.action === 'REFUND_PAYPAL') {
      const cap = await user.api.paypal.getCapture(a.target.capture_id);
      if (!cap.ok) {
        store.audit(caseId, 'system', 'PREFLIGHT_UNAVAILABLE', { authorization_id: a.id, paypal: cap.error });
        return cases.say(caseId, "I couldn't confirm the PayPal payment's status just now, so nothing was refunded yet. I'll try again next time you open this case.");
      }
      if (cap.status !== 200 || cap.data?.status !== 'COMPLETED') return cancel(`PayPal shows this payment as ${cap.data?.status ?? 'unavailable'}, so it can't be refunded.`);
    }
    store.audit(caseId, 'system', 'PREFLIGHT_PASSED', { authorization_id: a.id, credited_at: live.credited_at, reversed_at: live.reversed_at });

    // 2. Consume the approval and claim the payment, atomically. One resolution per payment, ever.
    const key = `resolve:${a.reference}`;
    const resolutionId = newId('RES');
    try {
      store.transaction(() => {
        if (store.resolutionForRef(a.reference)) throw new Error('ALREADY');
        if (!store.moveAuthorization(a.id, 'APPROVED', 'CONSUMED', null, iso())) throw new Error('USED');
        store.insertResolution({ id: resolutionId, idempotency_key: key, reference: a.reference, case_id: caseId, authorization_id: a.id, action: a.action, amount: a.amount, currency: a.currency, target: a.target, authorized_by: authorizedBy, executor: executor.name, created_at: iso() });
        const others = store.cancelOpen(caseId, `Another option was carried out (${resolutionId})`, iso());
        store.audit(caseId, 'system', 'EXECUTION_STARTED', { resolution_id: resolutionId, authorization_id: a.id, idempotency_key: key, authorized_by: authorizedBy, other_options_cancelled: others });
      });
    } catch (err) {
      if (err.message === 'ALREADY' || err.message === 'USED' || /UNIQUE/.test(err.message)) {
        store.moveAuthorization(a.id, 'APPROVED', 'CANCELLED', 'This payment was already resolved', iso());
        store.audit(caseId, 'system', 'DUPLICATE_EXECUTION_BLOCKED', { authorization_id: a.id, reason: err.message });
        return;
      }
      throw err;
    }

    // 3. Execute, then verify by reading the result back.
    const terms = { key, action: a.action, amount: a.amount, currency: a.currency, target: a.target, reference: a.reference, rule: a.rule, authorization_id: a.id, authorized_by: authorizedBy };
    let exec;
    try {
      exec = await executor.execute(terms, user);
    } catch (err) {
      exec = { ok: false, unknown: true, error: err.message };
    }
    // Read it back. If the call's answer was lost, the read-back decides whether it ran.
    const verification = exec.ok || exec.unknown ? await executor.verify(terms, user).catch((err) => ({ ok: false, mismatch: err.message })) : null;
    const status = verification?.ok ? 'VERIFIED' : exec.ok ? 'UNVERIFIED' : 'FAILED';
    store.finishResolution(resolutionId, status, exec, verification, iso());
    store.audit(caseId, 'system', `EXECUTION_${status}`, { resolution_id: resolutionId, executor: executor.name, entry: exec.id ?? null, replayed: exec.replayed ?? false, error: exec.error ?? null, verification });
    cases.say(caseId, outcomeMessage(status, a, exec));
  }

  function outcomeMessage(status, a, exec = {}) {
    const amt = formatMoney(a.amount, a.currency);
    const what = {
      CREDIT_WALLET: a.target.name === 'your FastPay wallet' ? `${amt} has been credited to your FastPay wallet` : `${a.target.name}'s FastPay wallet has been credited with ${amt}`,
      REFUND_PAYPAL: `${amt} has been refunded to your PayPal`,
      RETURN_TO_WALLET: `${amt} has been returned to your FastPay balance`,
    }[a.action];
    if (status === 'VERIFIED') {
      const when = a.action === 'REFUND_PAYPAL' ? ' PayPal usually shows a refund within a few days.' : '';
      return `Done. ${what}, and I've confirmed it in FastPay's records.${when}${executor.name === 'simulated' ? ' (Test mode: simulated.)' : ''}`;
    }
    if (status === 'UNVERIFIED') return "The action was sent, but I couldn't confirm it in the records yet. Our payments team has been alerted. Please don't send the money again.";
    if (exec.status === 409 || exec.status === 403) return `FastPay refused to carry this out: ${exec.error} No money was moved. Our payments team has been alerted.`;
    return "Something went wrong carrying this out, and no money was moved. Our payments team has been alerted.";
  }

  // ---- Customer view --------------------------------------------------------------------------

  function view(user, caseId) {
    const p = store.plan(caseId);
    if (!p || p.user_id !== user.id) return null;
    const report = cases.latestReport(caseId);
    const amountDisplay = report?.amount_at_issue?.display ?? report?.transaction?.amount_display;
    const recipient = report?.perspective === 'PAYER' ? report?.transaction?.payee?.name : null;
    const auths = store.authorizationsFor(caseId);
    for (const a of auths) expireIfDue(a);
    const fresh = store.authorizationsFor(caseId);
    const res = store.resolutionForCase(caseId);
    const describe = (a) => ({ id: a.id, action: a.action, ...describeOption(a, { amountDisplay: formatMoney(a.amount, a.currency), recipient }) });

    const base = { decision: p.decision.code, reason: p.decision.reason, type: p.plan?.type ?? null, simulated: executor.name === 'simulated', suggested: suggested.get(caseId) ?? null };
    if (res) {
      const a = store.authorization(res.authorization_id);
      return { ...base, state: res.status === 'VERIFIED' ? 'DONE' : 'PROBLEM', outcome: { ...describe(a), status: res.status, resolution_id: res.id, at: res.updated_at, authorized_by: res.authorized_by.startsWith('customer') ? 'you' : 'FastPay policy' } };
    }
    if (!p.plan) return { ...base, state: p.decision.code === 'NEEDS_STAFF' ? 'WITH_STAFF' : p.decision.code };
    if (p.plan.type === 'STAFF') return { ...base, state: 'WITH_STAFF' };

    const open = fresh.filter((a) => ['OFFERED', 'CONFIRMING', 'APPROVED'].includes(a.status));
    if (p.plan.type === 'POLICY') {
      const a = open[0];
      if (!a) return { ...base, state: 'CLOSED' };
      return { ...base, state: a.needs_staff && !a.staff_approved_at ? 'AWAITING_STAFF' : 'IN_PROGRESS', action: describe(a), why: p.plan.why };
    }
    const confirming = open.find((a) => a.status === 'CONFIRMING');
    const approved = open.find((a) => a.status === 'APPROVED');
    if (approved) return { ...base, state: approved.needs_staff && !approved.staff_approved_at ? 'AWAITING_STAFF' : 'IN_PROGRESS', action: describe(approved) };
    if (!open.length) return { ...base, state: 'EXPIRED' };
    return {
      ...base,
      state: confirming ? 'CONFIRM' : 'CHOOSE',
      amount_display: amountDisplay,
      reference: p.reference,
      options: [...open.map(describe), { id: 'WAIT', action: 'WAIT', ...describeOption({ action: 'WAIT' }, {}) }],
      confirm: confirming && {
        ...describe(confirming),
        amount_display: formatMoney(confirming.amount, confirming.currency),
        reference: confirming.reference,
        expires_at: confirming.expires_at,
        terms_hash: confirming.terms_hash,
        needs_staff: confirming.needs_staff,
      },
    };
  }

  // ---- Conversation (the agent) ------------------------------------------------------------

  /** Does this case have a resolution the customer can talk about? */
  const handles = (caseId) => Boolean(store.plan(caseId));

  function situation(user, caseId) {
    const report = cases.latestReport(caseId);
    const v = view(user, caseId);
    return {
      payment: report && {
        reference: report.transaction.reference, amount: report.transaction.amount_display, kind: report.kind_label ?? report.transaction.kind_label,
        you_are: report.perspective === 'PAYER' ? 'the sender' : 'the receiver', other_party: report.counterparty,
      },
      investigation: report && { finding: report.finding.title, explanation: report.finding.explanation, limits: report.limits },
      resolution: v,
      ready_to_carry_out: store.authorizationsFor(caseId)
        .filter((a) => a.status === 'APPROVED' && !(a.needs_staff && !a.staff_approved_at))
        .map((a) => ({ authorization_id: a.id, action: a.action, amount: formatMoney(a.amount, a.currency), authorized_by: a.kind === 'POLICY' ? 'policy' : 'customer' })),
    };
  }

  async function handleMessage(user, caseId, text) {
    ownPlan(user, caseId);
    await settle(user, caseId); // anything approved by staff since the last visit runs first
    const v = view(user, caseId);
    const options = (v.options ?? []).filter((o) => o.id);
    const tools = {
      get_case: () => situation(user, caseId),
      recheck_payment: async () => {
        const live = await liveTx(user, store.plan(caseId).reference);
        store.audit(caseId, 'agent', 'AGENT_RECHECKED', { found: Boolean(live) });
        return live ? { credit_recorded: Boolean(live.credited_at), money_returned: Boolean(live.reversed_at), status_note: live.credited_at ? 'The credit is now recorded.' : live.reversed_at ? 'The money has been returned.' : 'Still not delivered or returned.' } : { error: 'Payment not found' };
      },
      suggest_option: ({ option_id }) => {
        if (!options.some((o) => o.id === option_id)) throw new Error('No such option.');
        suggested.set(caseId, option_id);
        store.audit(caseId, 'agent', 'AGENT_SUGGESTED', { option_id });
        return { ok: true };
      },
      prepare_confirmation: ({ option_id }) => {
        const after = choose(user, caseId, option_id, { by: 'agent' });
        return { ok: true, confirmation: after.confirm ?? null, note: 'The customer must tap Approve on the card. You cannot approve it.' };
      },
      carry_out_authorized_action: async ({ authorization_id }) => {
        const a = store.authorization(String(authorization_id));
        if (!a || a.case_id !== caseId || a.user_id !== user.id) throw new Error('No such authorization on this case.');
        if (a.status !== 'APPROVED') throw new Error(a.status === 'CONFIRMING' || a.status === 'OFFERED' ? 'Not approved: the customer must tap Approve first.' : `Not runnable (${a.status}).`);
        if (a.needs_staff && !a.staff_approved_at) throw new Error('Waiting for staff approval.');
        store.audit(caseId, 'agent', 'AGENT_REQUESTED_EXECUTION', { authorization_id: a.id });
        await settle(user, caseId);
        const after = view(user, caseId);
        return { state: after.state, outcome: after.outcome ?? null };
      },
      escalate_to_staff: ({ reason }) => {
        store.audit(caseId, 'agent', 'ESCALATED', { reason: String(reason).slice(0, 500) });
        return { ok: true, note: 'Staff will review it. Nothing changes until they do.' };
      },
    };

    let reply = null;
    if (agent.enabled) {
      try {
        const out = await agent.respond({
          history: cases.messages(caseId),
          tools,
          onToolCall: (c) => store.audit(caseId, 'agent', 'AGENT_TOOL_CALL', { tool: c.name, input: c.input, error: c.error }),
        });
        reply = out.text;
        store.audit(caseId, 'agent', 'AGENT_REPLIED', { model: agent.model, steps: out.steps });
        // The agent may not claim money moved unless the records say so.
        if (view(user, caseId).state !== 'DONE' && /\b(has been|have been|was|were|i(?:'ve| have)?)\s+(refunded|credited|returned|sent|paid)\b|\bdone\b/i.test(reply)) {
          store.audit(caseId, 'system', 'AGENT_REPLY_BLOCKED', { reason: 'claimed a money movement that did not happen', reply: reply.slice(0, 300) });
          reply = null;
        }
      } catch (err) {
        store.audit(caseId, 'system', 'AGENT_FAILED', { error: String(err.message).slice(0, 300) });
      }
    }
    if (!reply) reply = rulesReply(user, caseId, text, v, options, tools);
    cases.say(caseId, reply);
    return view(user, caseId);
  }

  function rulesReply(user, caseId, text, v, options, tools) {
    if (v.state === 'DONE') return `This is resolved: ${v.outcome.title.toLowerCase()}. ${v.simulated ? '(Test mode: simulated.) ' : ''}Is there anything else?`;
    if (v.state === 'AWAITING_STAFF') return 'A member of our payments team needs to approve this because of the amount. It will be carried out as soon as they do.';
    if (v.state === 'WITH_STAFF') return 'Our payments team is reviewing this case. Nothing will change until they do, and you do not need to send the money again.';
    if (!options.length) return 'There is nothing to choose on this case right now.';
    const hit = intentFromText(text, options);
    if (hit?.action === 'WAIT') {
      choose(user, caseId, 'WAIT');
      return 'Okay, nothing will change for now. You can come back and choose later.';
    }
    if (hit) {
      tools.prepare_confirmation({ option_id: hit.id });
      return `Okay: ${hit.title.toLowerCase()}. Please check the details on the card and tap Approve to go ahead.`;
    }
    return `You can choose: ${options.map((o, i) => `${i + 1}) ${o.title}`).join('; ')}. Nothing happens until you approve it.`;
  }

  // ---- Internal (staff) -------------------------------------------------------------------------

  const internalCase = (caseId) => ({ plan: store.plan(caseId), authorizations: store.authorizationsFor(caseId), resolution: store.resolutionForCase(caseId), audit: store.auditFor(caseId) });

  return {
    settings, afterReport, view, choose, back, approve, settle, staffApprove, handles, handleMessage,
    internal: { resolutions: () => store.resolutions(), pendingStaff: () => store.pendingStaff(), case: internalCase, verifyAudit: () => store.verifyAuditChain() },
    agentEnabled: agent.enabled,
  };
}
