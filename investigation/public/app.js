// FastPay · Payment help. Plain JavaScript, no build step. All text goes in through textContent.
const main = document.getElementById('main');
const aside = document.getElementById('aside');
const composer = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const toast = document.getElementById('toast');

const state = {
  session: null,
  case: null,
  busy: null,           // text shown while waiting for a reply
  checking: null,       // { steps: [...], done: n } while an investigation runs
  chosen: null,         // reference the customer picked
  seenMessages: 0,      // messages already animated in
  shownResult: null,    // report id already animated in
};

// ---- Icons (inline SVG, drawn with the current text colour) ---------------------------
const NS = 'http://www.w3.org/2000/svg';
const P = (d) => ['path', { d }];
const ICONS = {
  send: [P('M22 2 11 13'), P('M22 2 15 22l-4-9-9-4 20-7z')],
  out: [P('M7 17 17 7'), P('M8 7h9v9')],
  in: [P('M17 7 7 17'), P('M16 17H7V8')],
  plus: [P('M12 5v14'), P('M5 12h14')],
  bank: [P('M3 21h18'), P('M5 21V11'), P('M19 21V11'), P('M9.5 21v-6'), P('M14.5 21v-6'), P('M2 11 12 4l10 7')],
  repeat: [P('m17 2 4 4-4 4'), P('M3 11V9a3 3 0 0 1 3-3h15'), P('m7 22-4-4 4-4'), P('M21 13v2a3 3 0 0 1-3 3H3')],
  check: [P('M20 6 9 17l-5-5')],
  x: [P('M18 6 6 18'), P('m6 6 12 12')],
  alert: [P('M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'), P('M12 9v4'), P('M12 17h.01')],
  clock: [['circle', { cx: 12, cy: 12, r: 9 }], P('M12 7v5l3 2')],
  info: [['circle', { cx: 12, cy: 12, r: 9 }], P('M12 16v-4'), P('M12 8h.01')],
  shield: [P('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'), P('m9 12 2 2 4-4')],
  lock: [['rect', { x: 4, y: 11, width: 16, height: 10, rx: 2 }], P('M8 11V7a4 4 0 0 1 8 0v4')],
  search: [['circle', { cx: 11, cy: 11, r: 7 }], P('m20 20-3.5-3.5')],
  copy: [['rect', { x: 9, y: 9, width: 12, height: 12, rx: 2 }], P('M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1')],
  undo: [P('M9 14 4 9l5-5'), P('M4 9h11a5 5 0 0 1 0 10h-4')],
  refresh: [P('M21 12a9 9 0 1 1-2.6-6.4L21 8'), P('M21 3v5h-5')],
  chat: [P('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z')],
  arrow: [P('M5 12h14'), P('m13 6 6 6-6 6')],
  dash: [P('M8 12h8')],
  sparkle: [P('M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8')],
  mic: [['rect', { x: 9, y: 2, width: 6, height: 12, rx: 3 }], P('M5 10v1a7 7 0 0 0 14 0v-1'), P('M12 18v4')],
  sound: [P('M11 5 6 9H2v6h4l5 4V5z'), P('M15.5 8.5a5 5 0 0 1 0 7'), P('M19 5a10 10 0 0 1 0 14')],
};

function icon(name, cls = 'icon') {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: cls, 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  for (const [tag, attrs] of ICONS[name] ?? []) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
  }
  return svg;
}

/** The big animated status mark on the result card: a ring that draws itself, then the symbol. */
function statusMark(tone) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 68 68');
  svg.setAttribute('aria-hidden', 'true');
  const add = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    svg.append(n);
  };
  add('circle', { class: 'disc', cx: 34, cy: 34, r: 34 });
  add('circle', { class: 'ring', cx: 34, cy: 34, r: 26, stroke: 'currentColor', pathLength: 1, transform: 'rotate(-90 34 34)' });
  const mark = {
    good: ['M23 35l7.5 7.5L46 27'],
    bad: ['M34 22v15', 'M34 45.5v.5'],
    warn: ['M34 22v13l8 5'],
    info: ['M34 31v14', 'M34 23v.5'],
  }[tone] ?? ['M34 31v14'];
  for (const d of mark) add('path', { class: 'mark', d, stroke: 'currentColor', pathLength: 1 });
  const wrap = el('div', { class: 'status-icon' });
  wrap.append(svg);
  return wrap;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
const initials = (name) => String(name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const delay = (node, s) => { node.style.animationDelay = `${s}s`; return node; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function remember(id) {
  try {
    if (id) localStorage.setItem('fastpay.investigation.case', id);
    else localStorage.removeItem('fastpay.investigation.case');
  } catch { /* storage blocked: the page still works */ }
}
function recall() {
  try { return localStorage.getItem('fastpay.investigation.case'); } catch { return null; }
}

// ---- API ------------------------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Something went wrong (${res.status}).`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer;
function showError(message) {
  toast.replaceChildren(icon('alert'), el('span', {}, message));
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
}

async function run(label, fn, { narrate = true } = {}) {
  state.busy = label;
  const before = window.voice?.snapshot();
  render();
  try {
    await fn();
    if (narrate) window.voice?.afterAction(before);
  } catch (err) {
    if (err.status === 401) return showSignIn(err.data?.signin_url);
    showError(err.message);
  } finally {
    state.busy = null;
    state.checking = null;
    render();
  }
}

// ---- Actions ----------------------------------------------------------------------------

function sendMessage(text) {
  const message = text.trim();
  if (!message || state.busy) return;
  input.value = '';
  autosize();
  if (window.voice?.takesText()) return window.voice.sendText(message);
  // Show the customer's message straight away while FastPay reads it.
  if (state.case) state.case = { ...state.case, messages: [...state.case.messages, { role: 'customer', body: message, created_at: new Date().toISOString() }], candidates: [] };
  else state.pending = message;
  const followUp = Boolean(state.case?.result);
  if (followUp) state.shownResult = state.case.result.report_id; // a re-check animates its new result in
  run(followUp ? 'Typing' : 'Reading your message', async () => {
    const { case: c } = state.case
      ? await api(`/api/cases/${state.case.id}/messages`, { method: 'POST', body: { message } })
      : await api('/api/cases', { method: 'POST', body: { message } });
    state.pending = null;
    state.case = c;
    remember(c.id);
  }).finally(() => { state.pending = null; });
}

/** The "checking" animation follows the real request: it can't finish before the answer arrives. */
async function withChecking(steps, request) {
  state.checking = { steps, done: 0 };
  render();
  const timer = setInterval(() => {
    if (state.checking && state.checking.done < steps.length - 1) {
      state.checking.done += 1;
      renderMain();
    }
  }, 750);
  try {
    const result = await request();
    clearInterval(timer);
    // The answer is in: tick off the remaining checks one by one so each step is seen.
    while (state.checking && state.checking.done < steps.length) {
      state.checking.done += 1;
      renderMain();
      await sleep(state.checking.done === steps.length ? 500 : 280);
    }
    return result;
  } finally {
    clearInterval(timer);
  }
}

function checkingSteps(channel) {
  return [
    "Reading FastPay's record of this payment",
    channel === 'PayPal' ? 'Checking the payment with PayPal' : null,
    'Checking your FastPay balance',
    'Looking for similar problems',
    'Preparing your result',
  ].filter(Boolean);
}

function confirmPayment(candidate) {
  if (state.busy) return;
  state.chosen = candidate.reference;
  run('Checking the records', async () => {
    state.case = (await api(`/api/cases/${state.case.id}/confirm`, { method: 'POST', body: { reference: candidate.reference } })).case;
    state.case = (await withChecking(checkingSteps(candidate.display.channel), () =>
      api(`/api/cases/${state.case.id}/investigate`, { method: 'POST', body: {} }))).case;
  });
}

function noneOfThese() {
  run('One moment', async () => {
    state.case = (await api(`/api/cases/${state.case.id}/none`, { method: 'POST', body: {} })).case;
  });
}

function checkAgain() {
  run('Checking again', async () => {
    state.shownResult = null;
    state.case = (await withChecking(checkingSteps(null), () =>
      api(`/api/cases/${state.case.id}/investigate`, { method: 'POST', body: { again: true } }))).case;
  });
}

// ---- Module 3: resolution --------------------------------------------------------------
// Money only moves through "approve", which sends back the exact terms hash the card showed.

function resolutionStep(step, body, label) {
  if (state.busy) return;
  run(label, async () => {
    state.case = (await api(`/api/cases/${state.case.id}/resolution/${step}`, { method: 'POST', body })).case;
  });
}
const chooseOption = (o) => resolutionStep('choose', { option_id: o.id }, o.action === 'WAIT' ? 'One moment' : 'Preparing the details');
const backOption = () => resolutionStep('back', {}, 'One moment');
const approveOption = (c) => resolutionStep('approve', { authorization_id: c.id, terms_hash: c.terms_hash }, 'Checking the payment once more and carrying it out');

function newComplaint() {
  state.case = null;
  state.chosen = null;
  state.seenMessages = 0;
  state.shownResult = null;
  remember(null);
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  input.focus();
}

async function copy(text, chip) {
  try {
    await navigator.clipboard.writeText(text);
    const label = chip.querySelector('span');
    const before = label.textContent;
    label.textContent = 'Copied';
    setTimeout(() => { label.textContent = before; }, 1200);
  } catch { /* clipboard blocked: nothing to do */ }
}

// ---- Rendering: header and case panel -----------------------------------------------------

function renderWho() {
  const u = state.session.user;
  document.getElementById('who').replaceChildren(
    state.session.fastpay_url
      ? el('a', { class: 'back-to-app', href: state.session.fastpay_url, 'aria-label': 'Back to FastPay' }, icon('undo'), el('span', {}, 'Back to FastPay'))
      : null,
    el('span', { class: 'secure-pill' }, icon('lock'), 'Secure session'),
    el('div', { class: 'user-chip' },
      el('div', { class: 'avatar' }, initials(u.name)),
      el('div', { class: 'user-meta' }, el('strong', {}, u.name), el('span', {}, u.account_id))),
  );
}

const STEPS = [
  ['Describe the problem', 'In your own words'],
  ['Find the payment', 'We search your history'],
  ['Confirm it', 'You choose the right one'],
  ['Investigate', 'FastPay and PayPal records'],
  ['Result', 'What happened and next steps'],
];

function currentStep() {
  const c = state.case;
  if (state.checking || c?.status === 'CONFIRMED') return 3;
  if (!c) return state.busy ? 1 : 0;
  if (c.status === 'INVESTIGATED') return 5;
  if (c.status === 'AWAITING_CONFIRMATION') return 2;
  return state.busy ? 1 : 0;
}

function renderAside() {
  const at = currentStep();
  const c = state.case;
  const d = c?.details;
  const facts = [
    ['Payment', c?.pinned?.reference],
    ['Problem', c?.complaint_label],
    ['Amount', d?.amount],
    ['Person', d?.counterparty],
    ['When', d?.when],
  ].filter(([, v]) => v);

  aside.replaceChildren(...[
    el('div', { class: 'panel' },
      el('h4', {}, 'Your case'),
      el('div', { class: 'case-id' }, c ? c.id : 'Not started yet'),
      el('ol', { class: 'stepper' }, STEPS.map(([title, hint], i) => {
        const cls = i < at ? 'done' : i === at ? 'active' : '';
        return el('li', { class: cls },
          el('span', { class: 'step-dot' }, i < at ? icon('check') : String(i + 1)),
          el('div', { class: 'step-text' }, el('strong', {}, title), el('span', {}, hint)));
      }))),
    facts.length
      ? el('div', { class: 'panel secondary' }, el('h4', {}, 'What we understood'),
        el('dl', { class: 'facts' }, facts.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v)))))
      : null,
    el('div', { class: 'panel secondary' },
      el('div', { class: 'safety' }, icon('shield'),
        el('span', {}, 'This is a read-only investigation. We only look at your own payments, and no money is moved while we check.'))),
  ].filter(Boolean));
}

// ---- Rendering: conversation -------------------------------------------------------------

const SUGGESTIONS = [
  ['out', 'Money sent, not received', "I sent Musa $50 yesterday, but he hasn't received it."],
  ['plus', 'Top-up not showing', 'I added $20 with PayPal today and it is not in my balance.'],
  ['bank', 'Cash out not arrived', 'I cashed out $30 to PayPal and it has not arrived.'],
  ['repeat', 'Charged twice', 'I was charged twice when I paid Aisha $15.'],
];

function renderHero() {
  const first = state.session.user.name.split(' ')[0];
  return el('section', { class: 'hero' },
    el('span', { class: 'hero-badge' }, icon('sparkle'), 'Payment help'),
    el('h1', {}, `Hi ${first}, `, el('span', { class: 'grad' }, 'what went wrong'), ' with your payment?'),
    el('p', {}, "Tell us in your own words. We'll find the payment, ask you to confirm it, then check FastPay's and PayPal's records to show you exactly what happened to your money."),
    el('div', { class: 'suggestions' }, SUGGESTIONS.map(([ic, title, text], i) =>
      delay(el('button', { class: 'suggestion', type: 'button', onclick: () => sendMessage(text) },
        el('span', { class: 's-icon' }, icon(ic)),
        el('span', {}, el('strong', {}, title), el('span', {}, `“${text}”`))), 0.15 + i * 0.07))));
}

function renderMessage(m, i) {
  const cls = `msg-row ${m.role}${i >= state.seenMessages ? ' enter' : ''}`;
  const bubble = el('div', { class: 'bubble' },
    m.role === 'support' ? el('div', { class: 'bubble-meta' }, 'FastPay Support') : null,
    m.body,
    el('span', { class: 'bubble-time' }, clock(m.created_at)));
  return m.role === 'support'
    ? el('div', { class: cls }, el('div', { class: 'bot-avatar', 'aria-hidden': 'true' }, 'F'), bubble)
    : el('div', { class: cls }, bubble);
}

function payIcon(d) {
  if (d.kind.startsWith('Cash out')) return icon('bank');
  if (d.kind === 'Add money') return icon('plus');
  return icon(d.direction === 'OUT' ? 'out' : 'in');
}

function renderCandidates(c) {
  return el('div', { class: 'cards' },
    c.candidates.map((x, i) => {
      const d = x.display;
      return delay(el('div', { class: `pay-card${state.chosen === x.reference ? ' chosen' : ''}` },
        el('div', { class: `pay-icon ${d.direction === 'OUT' ? 'out' : 'in'}` }, payIcon(d)),
        el('div', { class: 'pay-main' },
          el('div', { class: 'pay-title' }, d.counterparty),
          el('div', { class: 'pay-sub' }, `${d.kind} · ${d.channel} · ${d.when_display}`),
          el('div', { class: 'match-chips' }, x.reasons.map((r) => el('span', { class: 'match-chip' }, icon('check'), r))),
          d.warnings?.length ? el('div', { class: 'date-warning', role: 'note' }, icon('alert'), d.warnings.join(' · ')) : null),
        el('div', { class: 'pay-side' },
          el('div', {},
            el('div', { class: 'pay-amount' }, `${d.direction === 'OUT' ? '−' : '+'}${d.amount_display}`),
            el('div', { class: 'ref mono' }, d.reference)),
          el('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: Boolean(state.busy), onclick: () => confirmPayment(x) },
            'This is the one', icon('arrow')))), 0.08 + i * 0.07);
    }),
    el('button', { class: 'btn btn-ghost btn-sm none-link', type: 'button', disabled: Boolean(state.busy), onclick: noneOfThese }, icon('search'), 'None of these'));
}

function renderChecking() {
  const { steps, done } = state.checking;
  return el('div', { class: 'checking', role: 'status' },
    el('h3', {}, icon('search'), 'Checking the records'),
    el('ul', { class: 'check-list' }, steps.map((s, i) =>
      el('li', { class: i < done ? 'done' : i === done ? 'active' : '' },
        el('span', { class: 'ck' }, i < done ? icon('check') : null), s))));
}

// The server words each step from the evidence ("Not yet recorded", "In progress"); these are fallbacks.
const STATE_TEXT = { done: '', missing: 'Not yet recorded', pending: 'In progress', returned: '', unknown: 'Could not be confirmed' };
const STATE_ICON = { done: 'check', missing: 'dash', pending: 'clock', returned: 'undo', unknown: 'info' };

function renderResult(v) {
  const fresh = state.shownResult !== v.report_id;
  state.shownResult = v.report_id;
  return el('article', { class: `result tone-${v.tone}${fresh ? ' enter' : ''}`, 'aria-label': 'Investigation result' },
    el('div', { class: 'result-hero' },
      statusMark(v.tone),
      el('div', { class: 'eyebrow' }, 'Investigation result'),
      el('h2', {}, v.headline),
      el('div', { class: 'big-amount' }, v.amount_display),
      el('p', { class: 'status-line' }, v.status)),
    v.incident_note ? el('div', { class: 'incident-note' }, icon('info'), el('span', {}, v.incident_note)) : null,
    el('section', {},
      el('h3', {}, 'What we found'),
      v.details.map((d) => el('p', {}, d)),
      el('ul', { class: 'checked' }, v.checked.map((x) => el('li', {}, icon('check'), x)))),
    v.timeline?.length
      ? el('section', {},
        el('h3', {}, 'Payment timeline'),
        el('ol', { class: 'timeline' }, v.timeline.map((s) =>
          el('li', {},
            el('span', { class: `t-dot ${s.state}` }, icon(STATE_ICON[s.state] ?? 'info')),
            el('div', { class: 't-label' }, s.label, (s.state_text ?? STATE_TEXT[s.state]) ? el('span', { class: 't-state' }, s.state_text ?? STATE_TEXT[s.state]) : null),
            el('div', { class: 't-time' }, s.at_display ?? '')))))
      : null,
    el('section', {},
      el('h3', {}, 'What to do next'),
      el('ol', { class: 'next-steps' }, v.next_steps.map((s) => el('li', {}, el('span', {}, s))))),
    el('div', { class: 'result-foot' },
      el('div', { class: 'money-note' }, icon('shield'), el('span', {}, v.money_note)),
      el('div', { class: 'refs' },
        [['Payment', v.reference], ['Case', v.case_id]].map(([k, val]) => {
          const chip = el('button', { class: 'ref-chip', type: 'button', title: `Copy ${k.toLowerCase()} reference` },
            el('span', {}, `${k} `), el('b', { class: 'mono' }, val), icon('copy'));
          chip.addEventListener('click', () => copy(val, chip));
          return chip;
        }))),
    el('div', { class: 'result-actions' },
      v.can_check_again ? el('button', { class: 'btn btn-primary', type: 'button', disabled: Boolean(state.busy), onclick: checkAgain }, icon('refresh'), 'Check again') : null,
      el('button', { class: 'btn', type: 'button', onclick: newComplaint }, icon('chat'), 'New complaint')));
}

/** The payment the customer opened help from in FastPay, shown (not yet confirmed) under the first message. */
function renderPinned(c) {
  const d = c.pinned.display;
  const first = String(d.counterparty).split(' ')[0];
  const topics = {
    'Money sent': [[`${first} hasn't received it`, `I sent this payment to ${d.counterparty} but they have not received it`]],
    'Money received': [["I haven't received it", `${d.counterparty} sent me this payment but I have not received it`]],
    'Add money': [["It's not in my balance", 'I added money with this payment but it is not in my balance']],
    'Cash out to PayPal': [["It hasn't arrived in PayPal", 'I cashed out this money but it has not arrived in PayPal']],
    'Payment request (PayPal invoice)': [["Paid, but I didn't get it", 'They paid my request but I have not received it']],
  }[d.kind] ?? [];
  const common = [
    d.direction === 'OUT' ? ['I was charged twice', 'I was charged twice for this payment'] : null,
    ['The amount is wrong', 'The wrong amount was taken for this payment'],
    ["I don't recognise it", "I don't recognise this payment"],
  ].filter(Boolean);
  return el('div', { class: 'pinned-block' },
    el('div', { class: 'pay-card pinned' },
      el('div', { class: `pay-icon ${d.direction === 'OUT' ? 'out' : 'in'}` }, payIcon(d)),
      el('div', { class: 'pay-main' },
        el('div', { class: 'pay-title' }, d.counterparty),
        el('div', { class: 'pay-sub' }, `${d.kind} · ${d.channel} · ${d.when_display}`)),
      el('div', { class: 'pay-side' },
        el('div', {},
          el('div', { class: 'pay-amount' }, `${d.direction === 'OUT' ? '−' : '+'}${d.amount_display}`),
          el('div', { class: 'ref mono' }, d.reference)))),
    el('div', { class: 'quick-replies', role: 'group', 'aria-label': 'What went wrong?' },
      [...topics, ...common].map(([label, text]) =>
        el('button', { class: 'quick-reply', type: 'button', disabled: Boolean(state.busy), onclick: () => sendMessage(text) }, label))));
}

/** One-tap follow-ups once there is a result. They are sent as ordinary chat messages. */
function renderQuickReplies(v) {
  const troubled = v.tone === 'bad' || v.tone === 'warn';
  const options = [
    'Why did this happen?',
    v.can_check_again ? 'Check again' : null,
    troubled ? 'What happens to my money?' : null,
    'Thank you',
  ].filter(Boolean);
  return el('div', { class: 'quick-replies', role: 'group', 'aria-label': 'Quick replies' },
    options.map((text) => el('button', { class: 'quick-reply', type: 'button', disabled: Boolean(state.busy), onclick: () => sendMessage(text) }, text)));
}

const OPTION_ICON = { CREDIT_WALLET: 'arrow', REFUND_PAYPAL: 'undo', RETURN_TO_WALLET: 'undo', WAIT: 'clock', ESCALATE: 'info' };

function renderResolution(r) {
  const card = (tone, eyebrow, ...body) => el('article', { class: `resolution tone-${tone}`, 'aria-label': 'Resolution' },
    el('div', { class: 'eyebrow' }, eyebrow), ...body,
    r.simulated ? el('p', { class: 'sim-note' }, icon('info'), el('span', {}, 'Test mode: wallet credits and refunds are simulated.')) : null);

  if (r.state === 'CHOOSE') {
    return card('info', 'What we can do',
      el('div', { class: 'options' }, r.options.map((o) =>
        el('button', { class: `option${r.suggested === o.id ? ' suggested' : ''}`, type: 'button', disabled: Boolean(state.busy), onclick: () => chooseOption(o) },
          el('span', { class: 'option-icon' }, icon(OPTION_ICON[o.action] ?? 'info')),
          el('span', { class: 'option-main' }, el('b', {}, o.title), el('span', {}, o.detail)),
          r.suggested === o.id ? el('span', { class: 'badge' }, 'Suggested') : icon('arrow')))),
      el('p', { class: 'fine' }, icon('lock'), el('span', {}, 'Nothing happens until you approve it.')));
  }
  if (r.state === 'CONFIRM') {
    const c = r.confirm;
    return card('warn', 'Please confirm',
      el('h3', {}, c.title),
      el('dl', { class: 'terms' },
        el('dt', {}, 'Amount'), el('dd', {}, c.amount_display),
        el('dt', {}, 'What happens'), el('dd', {}, c.detail),
        el('dt', {}, 'Payment'), el('dd', { class: 'mono' }, c.reference),
        el('dt', {}, 'Valid until'), el('dd', {}, clock(c.expires_at))),
      c.needs_staff ? el('p', { class: 'fine' }, icon('info'), el('span', {}, 'Because of the amount, our payments team also approves this before it is carried out.')) : null,
      el('p', { class: 'fine' }, icon('shield'), el('span', {}, 'This approval can be used once, only for exactly this.')),
      el('div', { class: 'res-actions' },
        el('button', { class: 'btn btn-primary', type: 'button', disabled: Boolean(state.busy), onclick: () => approveOption(c) }, icon('check'), 'Approve'),
        el('button', { class: 'btn', type: 'button', disabled: Boolean(state.busy), onclick: backOption }, 'Back')));
  }
  if (r.state === 'DONE' || r.state === 'PROBLEM') {
    const ok = r.state === 'DONE';
    return card(ok ? 'good' : 'bad', ok ? 'Resolved' : 'Needs attention',
      el('div', { class: 'outcome' }, statusMark(ok ? 'good' : 'bad'),
        el('div', {}, el('h3', {}, r.outcome.title),
          el('p', {}, ok ? `Done and confirmed in the records at ${clock(r.outcome.at)}. Approved by ${r.outcome.authorized_by}.` : 'Our payments team has been alerted. Please do not send the money again.'))),
      el('div', { class: 'refs' }, el('span', { class: 'ref-chip' }, el('span', {}, 'Resolution '), el('b', { class: 'mono' }, r.outcome.resolution_id))));
  }
  if (r.state === 'AWAITING_STAFF') return card('warn', 'Waiting for approval', el('h3', {}, r.action.title), el('p', {}, 'Because of the amount, a member of our payments team approves this first. It is carried out as soon as they do.'));
  if (r.state === 'IN_PROGRESS') return card('info', 'In progress', el('h3', {}, r.action.title), el('p', {}, r.why ?? 'This will be carried out shortly.'));
  if (r.state === 'WITH_STAFF') return card('info', 'With our payments team', el('p', {}, 'A person is reviewing this case. Nothing changes until they do.'));
  return null;
}

function renderMain() {
  const c = state.case;
  const thread = el('div', { class: 'thread' });
  const messages = c?.messages ?? (state.pending ? [{ role: 'customer', body: state.pending, created_at: new Date().toISOString() }] : []);

  if (!c && !state.pending) {
    main.replaceChildren(renderHero());
    return;
  }
  const lastSupport = messages.map((m) => m.role).lastIndexOf('support');
  // The result card stays under the message that delivered it, so the chat can carry on below it.
  const resultAt = c?.result && !state.checking
    ? Math.min(c.result.after_message ?? messages.length - 1, messages.length - 1)
    : -1;
  if (c?.result && !state.checking && resultAt < 0) thread.append(renderResult(c.result));
  messages.forEach((m, i) => {
    thread.append(renderMessage(m, i));
    if (i === 0 && c?.pinned && c.status === 'NEEDS_DETAILS' && messages.length === 1 && !state.busy) thread.append(renderPinned(c));
    if (i === lastSupport && c?.status === 'AWAITING_CONFIRMATION' && c.candidates.length && !state.checking) thread.append(renderCandidates(c));
    if (i === resultAt) thread.append(renderResult(c.result));
    const note = window.voice?.noteAfter(i);
    if (note) thread.append(note);
  });
  state.seenMessages = messages.length;

  if (state.checking) thread.append(renderChecking());
  else if (state.busy) {
    thread.append(el('div', { class: 'typing', role: 'status' },
      el('div', { class: 'bot-avatar', 'aria-hidden': 'true' }, 'F'),
      el('div', { class: 'typing-bubble' }, el('span', { class: 'dots' }, el('i'), el('i'), el('i')), state.busy)));
  } else if (c?.result) {
    const card = c.resolution ? renderResolution(c.resolution) : null;
    if (card) thread.append(card);
    if (!['CHOOSE', 'CONFIRM'].includes(c.resolution?.state)) thread.append(renderQuickReplies(c.result));
  }
  main.replaceChildren(thread);
}

function render() {
  if (!state.session) return;
  const c = state.case;
  // The chat stays open after the result: the customer can ask why, ask to check again, or say thanks.
  composer.hidden = Boolean(state.checking);
  input.placeholder = c?.result
    ? 'Ask about this payment, e.g. "why did this happen?" or "check again"'
    : c?.pinned
      ? 'Tell us what went wrong with this payment'
      : 'Describe what went wrong, e.g. I sent Musa $50 yesterday, but he hasn\'t received it';
  sendBtn.disabled = Boolean(state.busy);
  input.disabled = Boolean(state.busy);
  renderAside();
  renderMain();
  requestAnimationFrame(() => {
    const fresh = document.querySelector('.result.enter');
    if (fresh) fresh.scrollIntoView({ behavior: 'smooth', block: 'start' }); // show the result from its top
    else if (c || state.pending) window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  });
}

function showSignIn(url) {
  composer.hidden = true;
  aside.replaceChildren();
  document.getElementById('who').replaceChildren();
  main.replaceChildren(
    el('div', { class: 'signin' },
      el('div', { class: 'lock' }, icon('lock')),
      el('h1', {}, 'Sign in to FastPay first'),
      el('p', {}, 'We use your FastPay sign-in to look at your own payments. Sign in, then come back to this page.'),
      el('div', { class: 'row' },
        el('a', { class: 'btn btn-primary', href: url || 'http://localhost:5173' }, 'Open FastPay', icon('arrow')),
        el('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, icon('refresh'), "I've signed in"))),
  );
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

sendBtn.append(icon('send'));
composer.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage(input.value);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage(input.value);
  }
});
input.addEventListener('input', autosize);

(async function start() {
  try {
    state.session = await api('/api/session');
  } catch (err) {
    if (err.status === 401) return showSignIn(err.data?.signin_url);
    main.replaceChildren(el('div', { class: 'signin' }, el('div', { class: 'lock' }, icon('alert')), el('h1', {}, "We can't reach FastPay right now"), el('p', {}, err.message),
      el('div', { class: 'row' }, el('button', { class: 'btn btn-primary', type: 'button', onclick: () => location.reload() }, icon('refresh'), 'Try again'))));
    return;
  }
  renderWho();
  // Speak instead of typing, when the voice service is running. voice.js loads after this file: wait for it.
  if (!window.voice) {
    await new Promise((r) => {
      window.addEventListener('voice-ready', r, { once: true });
      setTimeout(r, 3000); // no voice.js: carry on, typing only
    });
  }
  await window.voice?.init();
  // Opened from a payment in the FastPay app (/?ref=FP-…): start a case about that payment.
  const ref = new URLSearchParams(location.search).get('ref');
  if (ref) {
    history.replaceState(null, '', location.pathname); // a refresh must not open the case twice
    try {
      state.case = (await api('/api/cases/from-payment', { method: 'POST', body: { reference: ref } })).case;
      remember(state.case.id);
      render();
      input.focus();
      return;
    } catch (err) {
      if (err.status === 401) return showSignIn(err.data?.signin_url);
      showError(err.message);
    }
  }
  const saved = recall();
  if (saved) {
    try {
      state.case = (await api(`/api/cases/${saved}`)).case;
      state.seenMessages = state.case.messages.length; // don't replay old messages
      state.shownResult = state.case.result?.report_id ?? null;
    } catch {
      remember(null);
    }
  }
  render();
  if (!state.case) input.focus();
})();
