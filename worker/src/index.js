// VetTranslate API proxy (Cloudflare Worker).
// Holds the Gemini API key as a secret so it never appears in the public site.
// POST /translate  { text: string, target: string }  ->  { text: string }

const MAX_TEXT_LENGTH = 5000;

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) || isLocal ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function systemPrompt(target) {
  return `You are a translation engine for a veterinary clinic receptionist. Detect the input language automatically. Translate the given text accurately into ${target}, preserving veterinary and medical terminology precision. If the text has multiple lines, translate line by line and preserve the exact same line breaks in the output. Keep any emoji that are in the input, but never add emoji or any other decoration that is not in the input. Respond with ONLY the translated text — no quotes, no explanations, no language labels, nothing else.`;
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request.headers.get('Origin'), env);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname !== '/translate' || request.method !== 'POST') {
      return json({ error: 'Not found' }, 404, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400, cors);
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const target = typeof body.target === 'string' ? body.target.trim().slice(0, 50) : '';
    if (!text || !target) return json({ error: 'text and target are required' }, 400, cors);
    if (text.length > MAX_TEXT_LENGTH) return json({ error: 'Text too long' }, 413, cors);

    // Free-tier models are often briefly overloaded (503) or rate limited (429),
    // so fall through to the next model on transient errors.
    const models = [env.GEMINI_MODEL || 'gemini-flash-latest',
      ...(env.GEMINI_FALLBACK_MODELS || '').split(',').map(s => s.trim()).filter(Boolean)];
    const requestBody = JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt(target) }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: { temperature: 0.2 },
    });

    let lastStatus = 502;
    for (const model of models) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
          body: requestBody,
        }
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const parts = data.candidates?.[0]?.content?.parts || [];
        const translated = parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
        return json({ text: translated }, 200, cors);
      }
      console.error('Gemini error', model, res.status, JSON.stringify(data));
      lastStatus = res.status;
      if (![429, 500, 503, 504].includes(res.status)) break;
    }
    const status = lastStatus === 429 ? 429 : 502;
    return json({ error: status === 429 ? 'Rate limited' : 'Upstream error' }, status, cors);
  },
};
