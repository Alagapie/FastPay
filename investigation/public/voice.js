// FastPay Voice on the payment-help page: speak instead of typing, in English, Pidgin, Hausa, Yoruba or Igbo,
// and hear the answers in your language. Everything else on the page stays the same: payments and options
// are still tapped, and money is only ever approved by tapping Approve.
//
// The voice service (../digital-human, proxied at /voice/api/*) hears the recording, turns it into the
// English this page's case API understands, makes the one matching call, and says the reply in the
// customer's language. Uses globals from app.js: state, api, run, render, remember, showError, el, icon, input.
(() => {
  const LANG_NAMES = { en: 'English', pcm: 'Pidgin', ha: 'Hausa', yo: 'Yoruba', ig: 'Igbo' };
  const BROWSER_CAN_SAY = new Set(['en', 'pcm']);
  const mic = document.getElementById('mic');
  const picker = document.getElementById('voice-lang');

  const v = {
    available: false,
    yarn: false, // YarnGPT voice (all five languages); otherwise the browser's voice (English / Pidgin)
    on: false, // speak answers aloud: after the customer first uses the mic or picks a language other than English
    lang: 'en',
    recording: false,
    note: null, // { at, heard, reply, language } the last spoken exchange, shown under its message
  };
  const saved = (() => { try { return localStorage.getItem('fastpay.voice.lang'); } catch { return null; } })();

  // ---- Speaking --------------------------------------------------------------------------------

  let player = null;
  function stop() {
    if (player) player.pause();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    mic.classList.remove('speaking');
  }

  async function say(text, language) {
    if (!text) return;
    stop();
    mic.classList.add('speaking');
    try {
      if (v.yarn) {
        const res = await fetch('/voice/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, language }) });
        if (res.ok) {
          const url = URL.createObjectURL(await res.blob());
          const audio = new Audio(url);
          player = audio;
          await new Promise((resolve) => {
            audio.onended = audio.onpause = audio.onerror = resolve;
            audio.play().catch(resolve);
          });
          URL.revokeObjectURL(url);
          return;
        }
      }
      if (BROWSER_CAN_SAY.has(language) && 'speechSynthesis' in window) {
        await new Promise((resolve) => {
          const u = new SpeechSynthesisUtterance(text.replace(/\n+/g, '. '));
          u.lang = 'en-NG';
          u.rate = 0.95;
          u.onend = u.onerror = resolve;
          speechSynthesis.speak(u);
        });
      }
    } finally {
      if (player?.paused !== false) player = null;
      mic.classList.remove('speaking');
    }
  }

  // ---- Listening -------------------------------------------------------------------------------

  let recorder = null;
  let stopTimer = null;

  async function toggleMic() {
    if (mic.classList.contains('speaking')) return stop();
    if (state.busy) return;
    if (v.recording) return recorder?.state !== 'inactive' && recorder.stop();
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return showError('Voice needs a browser with a microphone, such as Chrome. You can still type.');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch {
      return showError('Please allow the microphone to speak, or type your message.');
    }
    const chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      clearTimeout(stopTimer);
      setRecording(false);
      if (!chunks.length) return;
      try {
        const wav = await toWav16k(new Blob(chunks, { type: recorder.mimeType }));
        if (wav.seconds < 0.4) return;
        turn({ audio: wav.base64 });
      } catch {
        showError('Could not read the recording. Please try again, or type.');
      }
    };
    recorder.start();
    setRecording(true);
    watchSilence(stream);
    stopTimer = setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), 30_000);
  }

  function setRecording(on) {
    v.recording = on;
    mic.classList.toggle('on', on);
    mic.setAttribute('aria-label', on ? 'Stop recording' : 'Speak');
    input.placeholder = on ? `Listening… speak in ${LANG_NAMES[v.lang]}, then pause` : input.dataset.placeholder ?? input.placeholder;
    if (!on) render();
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
      if (!v.recording) return ctx.close();
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const x of buf) sum += x * x;
      const level = Math.sqrt(sum / buf.length);
      mic.style.setProperty('--level', Math.min(1, level * 12).toFixed(2));
      if (level > 0.02) { spoke = true; quietSince = performance.now(); }
      else if (spoke && performance.now() - quietSince > 1600) return recorder.state !== 'inactive' && recorder.stop();
      requestAnimationFrame(tick);
    };
    tick();
  }

  /** Any recording -> 16 kHz mono 16-bit WAV, base64 (what the voice service's Meta model expects). */
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

  // ---- Turns -------------------------------------------------------------------------------------

  /** One spoken (or typed, in another language) turn through the voice service, on the case on screen. */
  function turn(body) {
    v.on = true;
    const path = body.audio ? '/voice/api/turn-audio' : '/voice/api/turn';
    run(body.audio ? 'Listening to what you said' : 'Reading your message', async () => {
      const r = await api(path, { method: 'POST', body: { ...body, language: v.lang, case_id: state.case?.id ?? null } });
      if (r.case?.id) {
        state.case = (await api(`/api/cases/${r.case.id}`)).case;
        remember(state.case.id);
      }
      v.note = { at: state.case?.messages.length ?? 0, heard: r.heard?.heard ?? body.text ?? '', reply: r.reply, language: r.reply_language };
      if (r.heard?.language && LANG_NAMES[r.heard.language] && r.heard.language !== v.lang && r.reply_language === r.heard.language) setLang(r.heard.language);
      say(r.reply, r.reply_language);
    }, { narrate: false });
  }

  /** After a tap on the page (confirm, choose, approve…): say what changed, in their language. */
  async function afterAction(before) {
    if (!v.on || !state.case || !before) return;
    try {
      const r = await api('/voice/api/narrate', { method: 'POST', body: { case_id: state.case.id, since: before.id === state.case.id ? before.count : 0, language: v.lang, before_state: before.state } });
      v.note = { at: state.case.messages.length, heard: null, reply: r.reply, language: r.reply_language };
      render();
      say(r.reply, r.reply_language);
    } catch { /* the screen already shows it */ }
  }

  function setLang(code) {
    v.lang = code;
    picker.value = code;
    try { localStorage.setItem('fastpay.voice.lang', code); } catch { /* fine */ }
  }

  // ---- What app.js calls --------------------------------------------------------------------------

  window.voice = {
    /** Typed text goes through the voice service when they chose a language other than English. */
    takesText: () => v.available && v.lang !== 'en',
    sendText: (text) => turn({ text }),
    snapshot: () => state.case && {
      id: state.case.id,
      count: state.case.messages.length,
      state: { status: state.case.status, resolution: state.case.resolution && { state: state.case.resolution.state, options: state.case.resolution.options ?? [], confirm: state.case.resolution.confirm ?? null } },
    },
    afterAction,
    /** The spoken exchange, shown under the message it belongs to (with a replay button). */
    noteAfter(i) {
      const n = v.note;
      if (!n || !state.case || i !== Math.min(n.at, state.case.messages.length) - 1) return null;
      const replay = el('button', { class: 'voice-replay', type: 'button', title: 'Play again', onclick: () => say(n.reply, n.language) }, icon('sound'), 'Play');
      return el('div', { class: 'voice-note' },
        n.heard ? el('div', { class: 'voice-heard' }, el('b', {}, 'You said: '), n.heard) : null,
        n.language !== 'en' ? el('div', { class: 'voice-reply' }, el('span', { class: 'voice-lang-tag' }, LANG_NAMES[n.language] ?? n.language), n.reply) : null,
        replay);
    },
    async init() {
      try {
        const s = await api('/voice/api/session');
        v.available = true;
        v.yarn = s.voice_output === 'yarngpt';
        const langs = (s.languages ?? ['en']).filter((l) => LANG_NAMES[l]);
        picker.replaceChildren(...langs.map((l) => el('option', { value: l }, LANG_NAMES[l])));
        setLang(langs.includes(saved) ? saved : 'en');
        v.on = v.lang !== 'en';
        picker.hidden = false;
        mic.hidden = false;
        mic.replaceChildren(icon('mic'));
        picker.addEventListener('change', () => { setLang(picker.value); v.on = v.on || picker.value !== 'en'; render(); });
        mic.addEventListener('click', toggleMic);
        document.body.classList.add('has-voice');
      } catch {
        // No voice service running: the page works exactly as before, by typing.
      }
    },
  };
  window.dispatchEvent(new Event('voice-ready'));
})();
