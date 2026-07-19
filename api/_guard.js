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
