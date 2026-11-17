// Meta model client (OpenAI-compatible chat completions). The only AI this module uses.
// It interprets and words things. It never decides anything about money.

export function parseJsonObject(text) {
  const s = String(text ?? '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON.');
  const obj = JSON.parse(s.slice(start, end + 1));
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('The model did not return a JSON object.');
  return obj;
}

export function createMetaClient({ apiKey, baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
  const enabled = Boolean(apiKey && baseUrl);

  async function complete({ model, system, user }) {
    if (!enabled) throw new Error('The Meta model is not configured.');
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Meta model returned HTTP ${res.status}${data?.error?.message ? `: ${data.error.message}` : ''}`);
    const content = data?.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((c) => c?.text ?? '').join('') : content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('The Meta model returned an empty answer.');
    return text.trim();
  }

  return {
    enabled,
    complete,
    completeJson: async (args) => parseJsonObject(await complete(args)),
  };
}
