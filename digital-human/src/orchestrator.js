// FastPay Voice: Conversation Manager + Orchestrator.
// The voice of the payment-help page: the customer speaks (English, Pidgin, Hausa, Yoruba, Igbo) instead of
// typing, and hears the answers in their language.
//
// Each turn: understand the customer (any language) -> pick the ONE Module 2/3 call that fits the case's
// current stage -> read back what Module 2/3 replied (new messages + the lists/cards on screen) -> say it
// in the customer's language.
//
// Code, not the model, decides which call is made. The model only supplies the English meaning, the intent
// and which numbered item was picked. Approving money is never done by voice: only the customer's tap on
// the Approve card, forwarded unchanged to Module 3, which checks the exact terms.

import { LANGUAGES } from './language.js';

const direction = (d) => (d.direction === 'OUT' ? 'to' : 'from');

export function candidateLines(candidates) {
  return candidates.map((c, i) => {
    const d = c.display ?? {};
    return `${i + 1}. ${d.amount_display} ${String(d.kind ?? 'payment').toLowerCase()} ${direction(d)} ${d.counterparty}, ${d.when_display}.`;
  });
}

export function optionLines(options) {
  return options.map((o, i) => `${i + 1}. ${o.title}. ${o.detail}`.trim());
}

/** What is on the customer's screen that they might pick by number. */
function currentList(c) {
  if (!c) return null;
  if (c.status === 'AWAITING_CONFIRMATION' && c.candidates?.length) return { kind: 'payments', items: c.candidates, lines: candidateLines(c.candidates) };
  if (c.resolution?.state === 'CHOOSE' && c.resolution.options?.length) return { kind: 'options', items: c.resolution.options, lines: optionLines(c.resolution.options) };
  return null;
}

/** The English to say after a step: Module 2/3's new messages, then whatever list or card appeared. */
export function narrate(before, after) {
  const parts = [];
  const same = before && before.id === after.id;
  const seen = same ? before.messages.length : 0;
  parts.push(...after.messages.slice(seen).filter((m) => m.role === 'support').map((m) => m.body));

  const refs = (c) => (c?.status === 'AWAITING_CONFIRMATION' ? (c.candidates ?? []).map((x) => x.reference).join() : '');
  if (after.status === 'AWAITING_CONFIRMATION' && after.candidates?.length && (!same || refs(before) !== refs(after))) {
    parts.push(...candidateLines(after.candidates));
    parts.push(after.candidates.length > 1
      ? 'Say the number of the right payment, or tap it. If it is not here, say "none of these".'
      : 'Is this the payment? Say yes or tap it. If not, say "none of these".');
  }

  const r = after.resolution;
  const ids = (x) => (x?.state === 'CHOOSE' ? (x.options ?? []).map((o) => o.id).join() : '');
  if (r?.state === 'CHOOSE' && r.options?.length && (!same || ids(before.resolution) !== ids(r))) {
    parts.push('Here are your options:', ...optionLines(r.options), 'Say the number of the option you want, or tap it.');
  }
  if (r?.state === 'CONFIRM' && r.confirm && (!same || before.resolution?.confirm?.id !== r.confirm.id)) {
    parts.push(`Please check this carefully: ${r.confirm.title}, ${r.confirm.amount_display}, for payment ${r.confirm.reference}.`,
      'If it is right, tap the green Approve button on your screen. To keep your money safe, I cannot approve by voice.');
  }
  // Module 3's other states, said plainly (its own messages already say the outcome; these cover the screen).
  const changed = !same || before.resolution?.state !== r?.state;
  if (changed && r?.state === 'AWAITING_STAFF') parts.push('A member of our payments team approves this first. It is carried out as soon as they do.');
  if (changed && r?.state === 'WITH_STAFF') parts.push('Our payments team is reviewing this case. Nothing changes until they do. Please do not send the money again.');

  if (!parts.length) {
    const last = [...after.messages].reverse().find((m) => m.role === 'support');
    parts.push(last ? last.body : "I'm still working on it.");
  }
  return parts.join('\n');
}

/** A compact view of the case for the screen (cards and buttons). Everything comes from Module 2/3. */
export function screenView(c) {
  if (!c) return null;
  const r = c.resolution;
  return {
    id: c.id,
    status: c.status,
    candidates: c.status === 'AWAITING_CONFIRMATION' ? (c.candidates ?? []).map((x) => ({ reference: x.reference, ...x.display })) : [],
    result: c.result ? { tone: c.result.tone, headline: c.result.headline, status: c.result.status, reference: c.result.reference, amount_display: c.result.amount_display, next_steps: c.result.next_steps } : null,
    resolution: r ? {
      state: r.state,
      options: r.state === 'CHOOSE' ? r.options.map((o) => ({ id: o.id, title: o.title, detail: o.detail })) : [],
      confirm: r.state === 'CONFIRM' && r.confirm ? {
        authorization_id: r.confirm.id, title: r.confirm.title, detail: r.confirm.detail, amount_display: r.confirm.amount_display,
        reference: r.confirm.reference, terms_hash: r.confirm.terms_hash, expires_at: r.confirm.expires_at, needs_staff: r.confirm.needs_staff,
      } : null,
      outcome: r.outcome ? { title: r.outcome.title, status: r.outcome.status } : null,
      simulated: r.simulated,
    } : null,
  };
}

export function createOrchestrator({ bridge, language, store, languages = Object.keys(LANGUAGES) }) {
  const enabled = languages.filter((l) => LANGUAGES[l]);
  if (!enabled.includes('en')) enabled.unshift('en');
  /** She replies in the language they spoke if it's switched on; otherwise the one they picked, else English. */
  const replyLanguage = (spoken, chosen) => (enabled.includes(spoken) ? spoken : enabled.includes(chosen) ? chosen : 'en');

  async function loadCase(session, caseId) {
    if (!caseId) return null;
    try {
      return await bridge.getCase(session, caseId);
    } catch (err) {
      if (err.status === 404) return null; // gone, or not this customer's: start fresh
      throw err;
    }
  }

  async function confirmAndCheck(session, c, reference) {
    const confirmed = await bridge.confirm(session, c.id, reference);
    // Module 2's own page starts the check straight after the confirmation; so do we.
    return bridge.investigate(session, confirmed.id);
  }

  /** Decide and run the one Module 2/3 call that fits what was said. Returns the case after it. */
  async function step(session, c, u) {
    const list = currentList(c);
    const picked = u.intent === 'choose' && list ? list.items[u.choice - 1] : null;

    if (!c || u.intent === 'new_problem') return bridge.openCase(session, u.english);
    if (list?.kind === 'payments') {
      if (picked) return confirmAndCheck(session, c, picked.reference);
      if (u.intent === 'none_of_these') return bridge.noneOfThese(session, c.id);
      // "Yes" to a single payment that was read out.
      if (list.items.length === 1 && /^\s*(yes|yeah|correct|that'?s (it|right|the one)|it is)\b/i.test(u.english)) {
        return confirmAndCheck(session, c, list.items[0].reference);
      }
    }
    if (list?.kind === 'options' && picked) return bridge.choose(session, c.id, picked.id);
    return bridge.addMessage(session, c.id, u.english);
  }

  async function finish(session, user, conv, before, after, lang, detail) {
    const english = narrate(before, after);
    const said = await language.speak(english, lang);
    store.save(user.account_id, { language: lang, case_id: after?.id ?? conv.case_id });
    store.addTurn(user.account_id, after?.id, 'assistant', said.language, said.text, english, detail);
    return { reply: said.text, reply_language: said.language, english, speech_lang: LANGUAGES[said.language].speech, case: screenView(after) };
  }

  /** The customer said (or typed) something. `case_id`: the case open on their screen (Module 2 checks it is theirs). */
  async function turn(session, user, { text, audio, language: chosen, case_id: openCase }) {
    const conv = store.conversation(user.account_id);
    const before = await loadCase(session, openCase === undefined ? conv.case_id : openCase);
    const hint = LANGUAGES[chosen] ? chosen : conv.language;
    const listContext = currentList(before)?.lines.join('\n') ?? '';
    let message;
    let u;
    if (audio) {
      u = await language.understandAudio(String(audio), { hint, listContext });
      if (!u) throw Object.assign(new Error("Sorry, I didn't catch that. Please try again, a little closer to the microphone."), { status: 422 });
      message = u.heard;
    } else {
      message = String(text ?? '').trim().slice(0, 1000);
      if (!message) throw Object.assign(new Error('Please say something first.'), { status: 400 });
      u = await language.understand(message, { hint, listContext });
    }
    const spoken = u.language;
    u = { ...u, language: replyLanguage(spoken, chosen ?? conv.language), spoken };
    const heard = (caseId) => store.addTurn(user.account_id, caseId, 'customer', spoken, message, u.english, { intent: u.intent, choice: u.choice, by: u.by });

    if (u.intent === 'greeting' && !before) {
      heard(null);
      const first = String(user.name ?? '').split(/\s+/)[0];
      const english = `Hello${first ? ` ${first}` : ''}. This is FastPay payment help. I can help when a payment didn't arrive or went wrong. Tell me what happened, for example how much, to whom and when.`;
      const said = await language.speak(english, u.language);
      store.save(user.account_id, { language: u.language, case_id: null });
      store.addTurn(user.account_id, null, 'assistant', said.language, said.text, english);
      return { heard: u, reply: said.text, reply_language: said.language, english, speech_lang: LANGUAGES[said.language].speech, case: null };
    }

    const after = await step(session, before, u);
    heard(after.id); // filed under the case it belongs to (a first message opens the case)
    return { heard: u, ...(await finish(session, user, conv, u.intent === 'new_problem' ? null : before, after, u.language, { step: u.intent })) };
  }

  /** The customer tapped something on the screen. Each tap maps to exactly one Module 2/3 call. */
  async function tap(session, user, body) {
    const conv = store.conversation(user.account_id);
    const before = await loadCase(session, conv.case_id);
    if (!before) throw Object.assign(new Error('There is no open case. Tell me what happened first.'), { status: 409 });
    const lang = conv.language ?? 'en';
    let after;
    switch (body.action) {
      case 'confirm': after = await confirmAndCheck(session, before, String(body.reference ?? '')); break;
      case 'none': after = await bridge.noneOfThese(session, before.id); break;
      case 'choose': after = await bridge.choose(session, before.id, String(body.option_id ?? '')); break;
      case 'back': after = await bridge.back(session, before.id); break;
      case 'check_again': after = await bridge.investigate(session, before.id, true); break;
      // Forwarded exactly as the card showed it. Module 3 checks the terms hash, expiry, owner and single use.
      case 'approve': after = await bridge.approve(session, before.id, String(body.authorization_id ?? ''), String(body.terms_hash ?? '')); break;
      default: throw Object.assign(new Error('Unknown action.'), { status: 400 });
    }
    store.addTurn(user.account_id, before.id, 'customer', lang, `[tap: ${body.action}]`, null, { action: body.action });
    return finish(session, user, conv, before, after, lang, { tap: body.action });
  }

  /**
   * The customer tapped a button on the payment-help page (which called Module 2/3 itself). Say what changed:
   * the support messages after index `since`, and any new list or card, in their language.
   */
  async function narrateSince(session, user, { case_id: caseId, since = 0, language: chosen, before_state: beforeState = null }) {
    const conv = store.conversation(user.account_id);
    const c = await loadCase(session, String(caseId ?? ''));
    if (!c) throw Object.assign(new Error('Case not found.'), { status: 404 });
    const n = Math.max(0, Math.min(Number(since) || 0, c.messages.length));
    const lang = replyLanguage(chosen, conv.language);
    const stub = {
      id: c.id,
      messages: c.messages.slice(0, n),
      status: beforeState?.status ?? c.status,
      candidates: beforeState?.status === c.status ? c.candidates : [],
      resolution: beforeState?.resolution ?? null,
    };
    return finish(session, user, conv, stub, c, lang, { narrate: true });
  }

  /** Where the customer left off (for reloading the page). */
  async function resume(session, user) {
    const conv = store.conversation(user.account_id);
    const c = await loadCase(session, conv.case_id);
    return { language: conv.language, case: screenView(c), turns: store.turns(user.account_id, c?.id ?? null, 30) };
  }

  function startOver(user) {
    const conv = store.conversation(user.account_id);
    store.save(user.account_id, { language: conv.language, case_id: null });
  }

  return { turn, tap, narrateSince, resume, startOver };
}
