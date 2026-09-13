// VetTranslate API (Cloudflare Worker).
// Holds the Gemini API key as a secret so it never appears in the public site,
// and stores the shared phrase cards so every device sees the same ones.
//
// POST /translate  { text, target }                     ->  { text }
// GET  /cards                                           ->  { version, cards | null }
// POST /cards      { type, ... }  + X-Edit-Password     ->  { version, cards }
//   type: 'import' { cards }  (merge; sets everything when the store is empty)
//         'add' { cat, text } | 'update' { id, text } | 'delete' { id } | 'favorite' { id, value }

import { DurableObject } from 'cloudflare:workers';

const MAX_TEXT_LENGTH = 5000;
const MAX_CATEGORY_LENGTH = 100;
const MAX_STATE_BYTES = 1_000_000;
const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) || isLocal ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Password',
    'Vary': 'Origin',
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
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
    if (url.pathname === '/translate' && request.method === 'POST') return handleTranslate(request, env, cors);
    if (url.pathname === '/cards') {
      const store = env.CARDS.get(env.CARDS.idFromName('main'));
      if (request.method === 'GET') return json(await store.getState(), 200, cors);
      if (request.method === 'POST') return handleCardsEdit(request, env, store, cors);
    }
    return json({ error: 'Not found' }, 404, cors);
  },
};

async function handleTranslate(request, env, cors) {
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
}

async function handleCardsEdit(request, env, store, cors) {
  if (!env.EDIT_PASSWORD) return json({ error: 'not_configured' }, 503, cors);
  if (Number(request.headers.get('Content-Length') || 0) > MAX_STATE_BYTES) {
    return json({ error: 'too_large' }, 413, cors);
  }
  let op;
  try {
    op = await request.json();
  } catch {
    return json({ error: 'invalid', message: 'Invalid JSON' }, 400, cors);
  }
  const result = await store.applyOp(request.headers.get('X-Edit-Password') || '', op);
  const status = { wrong_password: 401, locked: 429, empty: 409, invalid: 400, too_large: 413 }[result.error] || 200;
  return json(result, status, cors);
}

async function passwordMatches(given, expected) {
  if (!expected || typeof given !== 'string') return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all(
    [given, expected].map(s => crypto.subtle.digest('SHA-256', encoder.encode(s)))
  );
  return crypto.subtle.timingSafeEqual(a, b);
}

function cleanText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > MAX_TEXT_LENGTH) throw new Error('Invalid text');
  return text;
}

function cleanCategory(value) {
  const cat = typeof value === 'string' ? value.trim() : '';
  if (!cat || cat.length > MAX_CATEGORY_LENGTH) throw new Error('Invalid category');
  return cat;
}

function normalizeCards(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid cards');
  const out = {};
  for (const [cat, list] of Object.entries(input)) {
    if (!Array.isArray(list)) throw new Error('Invalid cards');
    out[cleanCategory(cat)] = list
      .filter(item => item && typeof item.text === 'string' && item.text.trim())
      .map(item => ({
        id: typeof item.id === 'string' && item.id ? item.id.slice(0, 64) : crypto.randomUUID(),
        text: cleanText(item.text),
        favorite: item.favorite === true,
      }));
  }
  return out;
}

function findCard(cards, id) {
  for (const list of Object.values(cards)) {
    const card = list.find(c => c.id === id);
    if (card) return { list, card };
  }
  throw new Error('Card not found');
}

// Returns the new cards object; throws on invalid input.
function applyToCards(cards, op) {
  if (op?.type === 'import') {
    const incoming = normalizeCards(op.cards);
    if (!cards) return incoming;
    const merged = structuredClone(cards);
    for (const [cat, list] of Object.entries(incoming)) {
      merged[cat] ||= [];
      for (const card of list) {
        const existing = merged[cat].find(c => c.text === card.text);
        if (existing) existing.favorite ||= card.favorite;
        else merged[cat].push({ ...card, id: crypto.randomUUID() });
      }
    }
    return merged;
  }

  if (!cards) return null;
  const next = structuredClone(cards);
  switch (op?.type) {
    case 'add': {
      const cat = cleanCategory(op.cat);
      (next[cat] ||= []).push({ id: crypto.randomUUID(), text: cleanText(op.text), favorite: false });
      return next;
    }
    case 'update':
      findCard(next, op.id).card.text = cleanText(op.text);
      return next;
    case 'delete': {
      const { list, card } = findCard(next, op.id);
      list.splice(list.indexOf(card), 1);
      return next;
    }
    case 'favorite':
      findCard(next, op.id).card.favorite = op.value === true;
      return next;
    default:
      throw new Error('Unknown operation');
  }
}

// Single shared store for all cards. Durable Object calls run one at a time,
// so each edit reads and writes the latest state without races.
export class CardStore extends DurableObject {
  async getState() {
    return (await this.ctx.storage.get('state')) || { version: 0, cards: null };
  }

  async checkPassword(password) {
    const now = Date.now();
    let failures = (await this.ctx.storage.get('failedLogins')) || { count: 0, since: 0 };
    if (now - failures.since >= LOCKOUT_MS) failures = { count: 0, since: now };
    if (failures.count >= MAX_FAILED_LOGINS) return 'locked';
    if (await passwordMatches(password, this.env.EDIT_PASSWORD)) return 'ok';
    await this.ctx.storage.put('failedLogins', { count: failures.count + 1, since: failures.since });
    return 'wrong_password';
  }

  async applyOp(password, op) {
    const auth = await this.checkPassword(password);
    if (auth !== 'ok') return { error: auth };

    const state = await this.getState();
    let cards;
    try {
      cards = applyToCards(state.cards, op);
    } catch (e) {
      return { error: 'invalid', message: e.message };
    }
    if (!cards) return { error: 'empty' };

    const next = { version: state.version + 1, cards };
    if (JSON.stringify(next).length > MAX_STATE_BYTES) return { error: 'too_large' };
    await this.ctx.storage.put('state', next);
    return next;
  }
}
