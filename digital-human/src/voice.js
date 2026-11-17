// Her speaking voice: YarnGPT (Nigerian voices for English, Pidgin, Hausa, Yoruba and Igbo).
// One call per reply to POST /api/v1/streaming/conversation, which returns the audio directly.
// Voice ids change over time on YarnGPT's side, so they are settings, checked against GET /api/v1/voices on start.

// Every YarnGPT voice speaks all five languages, so she keeps ONE female voice whatever the language:
// "idera" (melodic, gentle). Other female voices: zainab, adaora, chinenye, regina, remi, wura, mary.
// Override per language with DH_VOICE_<LANG>, or for all with DH_VOICE.
export const DEFAULT_VOICES = { en: 'idera', pcm: 'idera', ha: 'idera', yo: 'idera', ig: 'idera' };

export function createVoice({ apiKey, baseUrl = 'https://api.yarngpt.ai', voices = {}, fetchImpl = globalThis.fetch, timeoutMs = 30_000, log = console }) {
  const enabled = Boolean(apiKey);
  const chosen = { ...DEFAULT_VOICES, ...Object.fromEntries(Object.entries(voices).filter(([, v]) => v)) };

  /** Text in the customer's language -> { audio: Buffer, contentType }. */
  async function speak(text, language) {
    if (!enabled) throw Object.assign(new Error('No speaking voice is configured.'), { status: 503 });
    const res = await fetchImpl(`${baseUrl}/api/v1/streaming/conversation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text).slice(0, 5000), voice: chosen[language] ?? chosen.en, output_format: 'mp3' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      const code = data?.error?.code ?? res.status;
      log.warn?.(`[voice] YarnGPT refused (${code}): ${data?.error?.message ?? ''} trace=${data?.error?.trace_id ?? '-'}`);
      throw Object.assign(new Error('The voice service is not available right now.'), { status: 502, code });
    }
    return { audio: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'audio/mpeg' };
  }

  /** On start: does the key work, and do the chosen voices exist? */
  async function check() {
    if (!enabled) return { ok: false, message: 'OFF (set YARNGPT_API_KEY). Using the browser voice.' };
    try {
      const res = await fetchImpl(`${baseUrl}/api/v1/voices`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
      if (res.status === 401) return { ok: false, message: 'key REJECTED (401). Check YARNGPT_API_KEY.' };
      const data = await res.json().catch(() => null);
      const list = Array.isArray(data) ? data : data?.voices ?? data?.data ?? [];
      const ids = new Set(list.map((v) => (typeof v === 'string' ? v : v?.id ?? v?.name)).filter(Boolean));
      const missing = Object.entries(chosen).filter(([, id]) => ids.size && !ids.has(id));
      return {
        ok: true,
        voices: [...ids],
        message: missing.length
          ? `connected, but these voices don't exist: ${missing.map(([l, id]) => `${l}=${id}`).join(', ')}. Available: ${[...ids].join(', ')}`
          : `connected (${Object.entries(chosen).map(([l, id]) => `${l}=${id}`).join(', ')})`,
      };
    } catch (err) {
      return { ok: false, message: `not reachable (${err.message})` };
    }
  }

  return { enabled, voices: chosen, speak, check };
}
