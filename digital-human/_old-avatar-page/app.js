// Voice page.
// Listening: with Meta on, the page records the customer and Meta hears it; otherwise the browser's recognition.
// Speaking: YarnGPT's Nigerian female voices when configured, otherwise the browser's female voice.
const $ = (id) => document.getElementById(id);
const avatar = $('avatar');
const statusEl = $('status');
const transcript = $('transcript');
const cards = $('cards');
const mic = $('mic');
const replay = $('replay');
const toast = $('toast');

const SPEECH = { en: 'en-NG', ha: 'ha-NG', yo: 'yo-NG', ig: 'ig-NG', pcm: 'en-NG' };
const PROMPT = {
  en: 'Tap the microphone and tell me what happened.',
  ha: 'Danna makirufo ka faɗa mini abin da ya faru.',
  yo: 'Tẹ maikirofoonu kí o sọ ohun tó ṣẹlẹ̀ fún mi.',
  ig: 'Pịa igwe okwu ma gwa m ihe mere.',
  pcm: 'Press the mic make you tell me wetin happen.',
};

let lang = 'en';
let enabledLangs = ['en', 'pcm'];
let metaVoice = false;
let yarnVoice = false;
let busy = false;
let lastReply = null;

try { lang = localStorage.getItem('fastpay.voice.lang') || lang; } catch { /* storage blocked */ }

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}

function setState(state, text) {
  avatar.dataset.state = state;
  if (text) statusEl.textContent = text;
}

function showError(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showError.t);
  showError.t = setTimeout(() => { toast.hidden = true; }, 7000);
}

function showLangs() {
  for (const b of document.querySelectorAll('#langs button')) b.hidden = !enabledLangs.includes(b.dataset.lang);
}

function pickLang(code) {
  if (!enabledLangs.includes(code)) code = 'en';
  lang = code;
  try { localStorage.setItem('fastpay.voice.lang', code); } catch { /* ignore */ }
  for (const b of document.querySelectorAll('#langs button')) b.setAttribute('aria-pressed', String(b.dataset.lang === code));
  if (!busy) setState('idle', PROMPT[code]);
}

function addLine(who, text) {
  transcript.append(el('li', { class: who }, el('p', {}, text)));
  transcript.lastElementChild.scrollIntoView({ block: 'nearest' });
}

// ---- Speaking: a female voice -------------------------------------------------------------------

// Nigerian English first (Microsoft Edge has "Ezinne", en-NG), then well-known female voices.
const FEMALE = /ezinne|female|woman|zira|aria|jenny|libby|sonia|hazel|susan|samantha|karen|moira|tessa|serena|victoria|fiona|natasha|emma|ava|allison|clara|michelle|sara/i;
const MALE = /\b(male|abeo|david|mark|george|guy|ryan|daniel|alex|fred|tom|james|brian|christopher|eric|roger|william|thomas|oliver)\b/i;

function voiceFor() {
  const voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
  const female = voices.filter((v) => FEMALE.test(v.name) && !MALE.test(v.name));
  const score = (v) => (/en-NG/i.test(v.lang) ? 4 : 0) + (/natural|online|neural/i.test(v.name) ? 2 : 0) + (/en-GB/i.test(v.lang) ? 1 : 0);
  const best = (list) => [...list].sort((a, b) => score(b) - score(a))[0];
  return best(female) || best(voices.filter((v) => !MALE.test(v.name))) || null;
}

/** Her voice: YarnGPT when it's configured (Nigerian voices, all five languages), else the browser. */
async function say(text, language = lang) {
  if (yarnVoice && text) {
    try {
      return await playYarn(text, language);
    } catch { /* fall back to the browser voice below */ }
    if (!['en', 'pcm'].includes(language)) return setState('idle', PROMPT[lang]); // the browser can't say it properly
  }
  return browserSay(text);
}

let player = null;
async function playYarn(text, language) {
  setState('thinking', 'One moment…');
  const res = await fetch('/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, language }) });
  if (!res.ok) throw new Error('voice unavailable');
  const url = URL.createObjectURL(await res.blob());
  stopSpeaking();
  const audio = new Audio(url);
  player = audio;
  // The ring around her follows the loudness of her own voice.
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  const src = ctx.createMediaElementSource(audio);
  src.connect(an);
  an.connect(ctx.destination);
  const buf = new Float32Array(an.fftSize);
  const tick = () => {
    if (player !== audio || audio.paused) return;
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const x of buf) sum += x * x;
    avatar.style.setProperty('--level', Math.min(1, Math.sqrt(sum / buf.length) * 6).toFixed(2));
    requestAnimationFrame(tick);
  };
  return new Promise((resolve, reject) => {
    const done = () => {
      avatar.style.setProperty('--level', 0);
      URL.revokeObjectURL(url);
      ctx.close();
      if (player === audio) player = null;
      setState('idle', PROMPT[lang]);
      resolve();
    };
    audio.onended = done;
    audio.onpause = done;
    audio.onerror = () => { done(); reject(new Error('could not play')); };
    setState('speaking', 'Speaking…');
    audio.play().then(tick, (err) => { done(); reject(err); });
  });
}

function stopSpeaking() {
  if (player) player.pause();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

function browserSay(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || !text) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/\n+/g, '. '));
    const v = voiceFor();
    if (v) u.voice = v;
    u.lang = v?.lang || 'en-NG';
    u.rate = 0.95;
    u.pitch = v && FEMALE.test(v.name) ? 1 : 1.2; // nudge a neutral voice towards a female one
    u.onboundary = () => { avatar.classList.remove('beat'); void avatar.offsetWidth; avatar.classList.add('beat'); };
    u.onend = u.onerror = () => { setState('idle', PROMPT[lang]); resolve(); };
    setState('speaking', 'Speaking…');
    speechSynthesis.speak(u);
  });
}

// ---- Listening ------------------------------------------------------------------------------------

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let recorder = null;
let recording = false;
let stopTimer = null;

function listen() {
  if (busy) return;
  stopSpeaking();
  if (metaVoice && navigator.mediaDevices?.getUserMedia && window.MediaRecorder) return recording ? stopRecording() : startRecording();
  return browserListen();
}

async function startRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch {
    return showError('Please allow the microphone, or type below.');
  }
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    recording = false;
    mic.classList.remove('on');
    avatar.style.setProperty('--level', 0);
    clearTimeout(stopTimer);
    if (!chunks.length) return setState('idle', PROMPT[lang]);
    try {
      const wav = await toWav16k(new Blob(chunks, { type: recorder.mimeType }));
      if (wav.seconds < 0.4) return setState('idle', PROMPT[lang]);
      sendAudio(wav.base64);
    } catch {
      showError('Could not read the recording. Please try again, or type.');
      setState('idle', PROMPT[lang]);
    }
  };
  recorder.start();
  recording = true;
  mic.classList.add('on');
  setState('listening', 'Listening… tap again when you finish.');
  watchSilence(stream);
  stopTimer = setTimeout(stopRecording, 30_000);
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

/** Stops by itself after ~1.6 s of quiet once they have started talking. */
function watchSilence(stream) {
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  let spoke = false;
  let quietSince = performance.now();
  const tick = () => {
    if (!recording) return ctx.close();
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const x of buf) sum += x * x;
    const level = Math.sqrt(sum / buf.length);
    avatar.style.setProperty('--level', Math.min(1, level * 12).toFixed(2));
    if (level > 0.02) { spoke = true; quietSince = performance.now(); }
    else if (spoke && performance.now() - quietSince > 1600) return stopRecording();
    requestAnimationFrame(tick);
  };
  tick();
}

/** Any recording -> 16 kHz mono 16-bit WAV, base64 (the format Meta expects). */
async function toWav16k(blob) {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();
  const rate = 16000;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o, t) => { for (let i = 0; i < t.length; i++) out.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVEfmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  const bytes = new Uint8Array(out.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { base64: btoa(bin), seconds: decoded.duration };
}

function browserListen() {
  if (!Recognition) return showError('Voice input is not available in this browser. Please use Chrome, or type below.');
  if (rec) { rec.stop(); return; }
  rec = new Recognition();
  rec.lang = SPEECH[lang];
  rec.interimResults = true;
  let finalText = '';
  rec.onresult = (e) => {
    finalText = [...e.results].map((r) => r[0].transcript).join(' ');
    statusEl.textContent = `“${finalText}”`;
  };
  rec.onerror = (e) => {
    if (e.error !== 'no-speech' && e.error !== 'aborted') showError(`Microphone problem: ${e.error}`);
  };
  rec.onend = () => {
    rec = null;
    mic.classList.remove('on');
    if (finalText.trim()) send(finalText.trim());
    else setState('idle', PROMPT[lang]);
  };
  mic.classList.add('on');
  setState('listening', 'Listening…');
  rec.start();
}

// ---- Talking to the server -------------------------------------------------------------------

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    setState('idle', 'Please sign in to FastPay first, then come back to this page.');
    if (data.signin_url) cards.replaceChildren(el('a', { class: 'big', href: data.signin_url }, 'Open FastPay to sign in'));
    throw new Error(data.error || 'Please sign in.');
  }
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

async function exchange(fn) {
  if (busy) return;
  busy = true;
  mic.disabled = true;
  setState('thinking', 'One moment…');
  try {
    const r = await fn();
    lastReply = r;
    addLine('assistant', r.reply);
    render(r.case);
    replay.hidden = false;
    await say(r.reply, r.reply_language);
  } catch (err) {
    showError(err.message);
    setState('idle', PROMPT[lang]);
  } finally {
    busy = false;
    mic.disabled = false;
  }
}

function follow(r) {
  if (r.reply_language && r.reply_language !== lang && enabledLangs.includes(r.reply_language)) pickLang(r.reply_language);
  return r;
}

function send(text) {
  addLine('customer', text);
  return exchange(async () => follow(await api('/api/turn', { text, language: lang })));
}

function sendAudio(base64) {
  return exchange(async () => {
    const r = await api('/api/turn-audio', { audio: base64, language: lang });
    addLine('customer', r.heard?.heard ?? '(voice message)');
    return follow(r);
  });
}

const tap = (body, label) => {
  addLine('customer', label);
  return exchange(() => api('/api/tap', body));
};

// ---- Cards -------------------------------------------------------------------------------------

function render(c) {
  cards.replaceChildren();
  if (!c) return;
  if (c.candidates.length) {
    cards.append(el('h2', {}, 'Which payment?'));
    c.candidates.forEach((p, i) => cards.append(el('button', { class: 'card pick', type: 'button', onclick: () => tap({ action: 'confirm', reference: p.reference }, `${i + 1}`) },
      el('span', { class: 'num' }, String(i + 1)),
      el('span', { class: 'body' }, el('strong', {}, `${p.amount_display} ${p.direction === 'OUT' ? '→' : '←'} ${p.counterparty}`), el('small', {}, `${p.when_display} · ${p.channel} · ${p.reference}`)))));
    cards.append(el('button', { class: 'ghost', type: 'button', onclick: () => tap({ action: 'none' }, 'None of these') }, 'None of these'));
  }
  if (c.result && !c.resolution?.options?.length && !c.resolution?.confirm) {
    cards.append(el('div', { class: `card result ${c.result.tone}` }, el('strong', {}, c.result.headline), el('p', {}, c.result.status), el('small', {}, `${c.result.amount_display} · ${c.result.reference}`)));
  }
  const r = c.resolution;
  if (r?.options?.length) {
    cards.append(el('h2', {}, 'Your options'));
    r.options.forEach((o, i) => cards.append(el('button', { class: 'card pick', type: 'button', onclick: () => tap({ action: 'choose', option_id: o.id }, `${i + 1}`) },
      el('span', { class: 'num' }, String(i + 1)), el('span', { class: 'body' }, el('strong', {}, o.title), el('small', {}, o.detail)))));
  }
  if (r?.confirm) {
    const k = r.confirm;
    cards.append(el('div', { class: 'card confirm' },
      el('strong', {}, k.title), el('p', { class: 'amount' }, k.amount_display), el('small', {}, `${k.detail} · ${k.reference}`),
      r.simulated ? el('small', {}, 'Test mode: simulated, no real money moves.') : null,
      el('div', { class: 'row' },
        el('button', { class: 'approve', type: 'button', onclick: () => tap({ action: 'approve', authorization_id: k.authorization_id, terms_hash: k.terms_hash }, 'Approve') }, '✓ Approve'),
        el('button', { class: 'ghost', type: 'button', onclick: () => tap({ action: 'back' }, 'Back') }, 'Back'))));
  }
  if (r?.outcome) cards.append(el('div', { class: 'card result good' }, el('strong', {}, r.outcome.title), el('small', {}, r.outcome.status)));
}

// ---- Start -----------------------------------------------------------------------------------

for (const b of document.querySelectorAll('#langs button')) b.addEventListener('click', () => pickLang(b.dataset.lang));
mic.addEventListener('click', listen);
replay.addEventListener('click', () => lastReply && say(lastReply.reply, lastReply.reply_language));
$('typeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('typeInput').value.trim();
  if (v) { $('typeInput').value = ''; send(v); }
});
$('newBtn').addEventListener('click', async () => {
  try { await api('/api/new', {}); cards.replaceChildren(); transcript.replaceChildren(); setState('idle', PROMPT[lang]); } catch (err) { showError(err.message); }
});
if ('speechSynthesis' in window) speechSynthesis.getVoices(); // starts loading the voice list

showLangs();
pickLang(lang);
(async () => {
  try {
    const s = await api('/api/session');
    $('name').textContent = s.assistant;
    if (s.languages?.length) enabledLangs = s.languages;
    metaVoice = s.voice_input === 'meta';
    yarnVoice = s.voice_output === 'yarngpt';
    showLangs();
    pickLang(lang);
    const r = await api('/api/resume');
    if (r.language) pickLang(r.language);
    for (const t of r.turns) if (!t.text.startsWith('[tap')) addLine(t.speaker, t.text);
    render(r.case);
  } catch { /* shown already */ }
})();
