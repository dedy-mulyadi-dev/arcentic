// Shared security helpers for the serverless API endpoints
// (/api/groq, /api/gemini, /api/openrouter, /api/tavily).
//
//  - applyCors():    sets CORS headers, restricted to your own site(s).
//  - originAllowed(): blocks other websites from abusing your API keys.
//  - rateLimit():    simple in-memory per-IP limiter so a single user or bot
//                    can't drain your quota / rack up cost.
//  - guard():        one call that does CORS + OPTIONS + method + origin + rate
//                    limit. Returns false if the response is already sent.
//
// NOTE: the in-memory counter is per serverless instance and resets on a cold
// start, so it's a first line of defense — not bulletproof. For stronger limits
// under heavy traffic, back it with a shared store (e.g. Upstash Redis).

const WINDOW_MS = 60_000; // 1 minute window
const MAX_REQUESTS = Number(process.env.AI_RATE_LIMIT || 20); // max calls / IP / window
const hits = new Map(); // ip -> { count, resetAt }

function allowedOrigins() {
    return (process.env.ALLOWED_ORIGINS || '')
        .split(',').map(s => s.trim()).filter(Boolean);
}

export function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
    return (req.socket && req.socket.remoteAddress) || 'unknown';
}

export function rateLimit(req) {
    const ip = getClientIp(req);
    const now = Date.now();
    if (hits.size > 5000) {            // cegah Map membengkak selama instance hidup
        for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
        if (hits.size > 5000) hits.clear();
    }
    const rec = hits.get(ip);
    if (!rec || now > rec.resetAt) {
        hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
        return { ok: true, remaining: MAX_REQUESTS - 1 };
    }
    if (rec.count >= MAX_REQUESTS) {
        return { ok: false, retryAfter: Math.ceil((rec.resetAt - now) / 1000) };
    }
    rec.count++;
    return { ok: true, remaining: MAX_REQUESTS - rec.count };
}

// Set ALLOWED_ORIGINS in Vercel (comma-separated), e.g.:
//   https://arcentic.vercel.app,https://www.arcentic.com
// If it's unset we fall back to "*" so nothing breaks before you configure it —
// but set it in production to actually lock the API to your site.
export function applyCors(req, res) {
    const allowed = allowedOrigins();
    const origin = req.headers.origin || '';
    if (allowed.length === 0) {
        res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && allowed.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export function originAllowed(req) {
    const allowed = allowedOrigins();
    if (allowed.length === 0) return true;         // not configured yet -> allow
    const origin = req.headers.origin || '';
    if (!origin) return true;                      // same-origin/no-origin request
    return allowed.includes(origin);
}

// One-call guard for every endpoint. Handles CORS, the OPTIONS preflight, the
// method check, origin allow-list and rate limiting. Returns true if the
// request should proceed; false means the response has already been sent.
export function guard(req, res) {
    applyCors(req, res);
    if (req.method === 'OPTIONS') { res.status(200).end(); return false; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return false; }
    if (!originAllowed(req)) { res.status(403).json({ error: 'Forbidden origin' }); return false; }
    const rl = rateLimit(req);
    if (!rl.ok) {
        res.setHeader('Retry-After', String(rl.retryAfter || 60));
        res.status(429).json({ error: 'Too many requests — please slow down.' });
        return false;
    }
    return true;
}


// ───────────────────────── Validasi & pembatasan isi permintaan ─────────────────────────
// Proxy ini sebelumnya meneruskan seluruh body dari browser apa adanya, sehingga siapa pun
// yang memanggil endpoint bisa memilih model, max_tokens besar, stream, dsb. dan menguras
// kuota. Sekarang hanya field yang dipakai Eiji yang diteruskan, dengan batas wajar.
// Semua batas bisa diubah lewat env tanpa edit kode.

const MAX_BODY_CHARS = Number(process.env.AI_MAX_BODY_CHARS || 400_000);
const MAX_MESSAGES = Number(process.env.AI_MAX_MESSAGES || 120);
const MAX_TOOLS = 30;
const MAX_TOKENS_CAP = Number(process.env.AI_MAX_TOKENS_CAP || 4096);
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/;

const bad = (error, status = 400) => ({ ok: false, status, error });

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function clampInt(v, min, max, dflt) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
}

// opts.forceModel   : model dipaksa dari server (OpenRouter, Gemini) — model dari browser diabaikan.
// opts.allowedModels: daftar model yang boleh dipilih browser (Groq). Kosong = hanya cek format nama.
export function sanitizeChatBody(body, opts = {}) {
    if (!isPlainObject(body)) return bad('Body harus berupa objek JSON.');
    let size = 0;
    try { size = JSON.stringify(body).length; } catch { return bad('Body tidak valid.'); }
    if (size > MAX_BODY_CHARS) return bad('Permintaan terlalu besar.', 413);

    const { messages } = body;
    if (!Array.isArray(messages) || messages.length === 0) return bad('messages wajib berupa array tidak kosong.');
    if (messages.length > MAX_MESSAGES) return bad('Terlalu banyak pesan dalam satu permintaan.', 413);
    const cleanMessages = [];
    for (const m of messages) {
        if (!isPlainObject(m) || !ROLES.has(m.role)) return bad('Format pesan tidak valid.');
        const c = {};
        for (const k of ['role', 'content', 'name', 'tool_calls', 'tool_call_id']) if (m[k] !== undefined) c[k] = m[k];
        if (c.content !== undefined && c.content !== null && typeof c.content !== 'string' && !Array.isArray(c.content)) {
            return bad('Isi pesan tidak valid.');
        }
        cleanMessages.push(c);
    }

    const out = { messages: cleanMessages };

    // model
    if (opts.forceModel) {
        out.model = opts.forceModel;
    } else {
        const model = body.model;
        if (typeof model !== 'string' || !MODEL_RE.test(model)) return bad('Model tidak valid.');
        if (opts.allowedModels && opts.allowedModels.length && !opts.allowedModels.includes(model)) {
            return bad('Model ini tidak diizinkan.', 403);
        }
        out.model = model;
    }

    out.max_tokens = clampInt(body.max_tokens, 1, MAX_TOKENS_CAP, 1024);
    if (body.temperature !== undefined) {
        const t = Number(body.temperature);
        if (Number.isFinite(t)) out.temperature = Math.min(2, Math.max(0, t));
    }

    if (body.tools !== undefined) {
        if (!Array.isArray(body.tools) || body.tools.length > MAX_TOOLS) return bad('tools tidak valid.');
        out.tools = body.tools;
    }
    if (body.tool_choice !== undefined && out.tools) {
        const tc = body.tool_choice;
        if (typeof tc === 'string' && ['auto', 'none', 'required'].includes(tc)) out.tool_choice = tc;
        else if (isPlainObject(tc) && tc.type === 'function' && isPlainObject(tc.function) && typeof tc.function.name === 'string') {
            out.tool_choice = { type: 'function', function: { name: tc.function.name.slice(0, 64) } };
        } else return bad('tool_choice tidak valid.');
    }
    return { ok: true, body: out };
}

export function parseModelList(envValue) {
    return String(envValue || '').split(',').map(s => s.trim()).filter(Boolean);
}

export function sanitizeTavilyBody(body) {
    if (!isPlainObject(body)) return bad('Body harus berupa objek JSON.');
    const query = typeof body.query === 'string' ? body.query.trim().slice(0, 400) : '';
    if (!query) return bad('query wajib diisi.');
    const out = {
        query,
        search_depth: body.search_depth === 'advanced' ? 'advanced' : 'basic',
        max_results: clampInt(body.max_results, 1, 8, 5),
        include_answer: body.include_answer !== false
    };
    if (body.topic === 'news' || body.topic === 'general') out.topic = body.topic;
    if (out.topic === 'news' && body.days !== undefined) out.days = clampInt(body.days, 1, 30, 7);
    return { ok: true, body: out };
}

// Panggilan upstream dengan batas waktu, supaya request yang menggantung tidak menahan function.
export function fetchUpstream(url, init) {
    const ms = Number(process.env.AI_UPSTREAM_TIMEOUT_MS || 50_000);
    return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

// Baca respons upstream; kalau bukan JSON (halaman error HTML dsb.) kembalikan error yang jelas
// dengan bentuk { error: { message } } yang sama seperti yang dibaca frontend.
export async function readUpstream(response) {
    const text = await response.text();
    try { return JSON.parse(text); }
    catch { return { error: { message: 'Respons upstream bukan JSON (status ' + response.status + ').' } }; }
}
