// Renders problem.html to a video file with headless Chrome. No dependencies.
// Usage: node video/render.js
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const dir = __dirname;
const page = 'file:///' + path.join(dir, 'problem.html').replace(/\\/g, '/');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-video-'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1280,720', '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-background-timer-throttling', page], { stdio: 'ignore' });
  try {
    let target;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(250);
      try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page'); } catch {}
    }
    if (!target) throw new Error('Chrome did not start');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const waiting = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const n = ++id; waiting.set(n, m => m.error ? rej(new Error(m.error.message)) : res(m.result));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
    const evaluate = async expression => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    await sleep(800);

    if (process.argv.includes('--frames')) {       // still frames, to check the look
      for (const t of [3, 7.5, 12.5, 16.5, 19.5]) {
        const data = await evaluate(`(drawAt(${t}), document.getElementById('c').toDataURL('image/png').split(',')[1])`);
        fs.writeFileSync(path.join(dir, `frame-${t}.png`), Buffer.from(data, 'base64'));
      }
      console.log('frames written');
    } else {
      console.log('recording 20 seconds…');
      const { mime, b64 } = await evaluate('record()');
      const out = path.join(dir, 'problem.' + (mime.includes('mp4') ? 'mp4' : 'webm'));
      fs.writeFileSync(out, Buffer.from(b64, 'base64'));
      console.log(`${out}  (${mime}, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
    }
    ws.close();
  } finally {
    chrome.kill();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
})().catch(e => { console.error(e); process.exit(1); });
