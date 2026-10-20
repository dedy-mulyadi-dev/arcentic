// api/rpc.js
//
// Proxy JSON-RPC untuk chain Arc Testnet.
// Tujuan: browser user tidak pernah lihat/kirim API key Alchemy secara
// langsung. Key disimpan di Vercel Environment Variable (server-side only).
//
// SETUP (wajib dilakukan manual di dashboard Vercel):
//   1. Buka project di vercel.com -> Settings -> Environment Variables
//   2. Tambahkan variable baru:
//        Name  : ALCHEMY_RPC_URL
//        Value : https://arc-testnet.g.alchemy.com/v2/<API_KEY_KAMU>
//      (pindahkan URL + key yang sebelumnya ada di app.js ke sini)
//   3. Pastikan juga ada variable:
//        Name  : ALLOWED_ORIGINS
//        Value : https://arcentic.vercel.app,https://arcentic-git-main-dedy-mulyadi.vercel.app
//      (daftar domain yang BOLEH memanggil proxy ini, dipisah koma —
//      masukkan semua domain preview/production yang kamu pakai)
//   4. Redeploy project setelah menambahkan/mengubah env var (env var baru
//      butuh redeploy baru supaya kebaca).
//
// Setelah itu, frontend (app.js) tidak lagi menyimpan key sama sekali —
// dia cuma manggil "/api/rpc" di domain sendiri.
//
// KENAPA CORS-nya dibatasi (bukan '*' lagi):
// Sebelumnya endpoint ini bisa dipanggil dari domain MANA PUN, karena
// dikira perlu untuk WalletConnect / wallet mobile. Padahal yang
// memanggil "/api/rpc" itu selalu halaman arcentic.vercel.app sendiri
// (baik dibuka di browser biasa maupun di in-app browser wallet mobile)
// — WalletConnect sendiri tidak lewat endpoint ini sama sekali, dia pakai
// jalur relay/QR/deep-link terpisah. Jadi CORS '*' di sini tidak
// dibutuhkan, dan malah membuka celah: siapa pun bisa embed endpoint ini
// di situs lain dan memakai kuota Alchemy kita secara gratis
// (RPC-proxy abuse / quota drain). Makanya sekarang dibatasi hanya ke
// domain yang ada di ALLOWED_ORIGINS.

// Rate limit sederhana per-IP (in-memory). CATATAN: karena serverless
// function bisa jalan di banyak instance berbeda & instance-nya bisa
// "dingin" lagi kapan saja, ini BUKAN rate limit yang presisi/terjamin —
// tapi cukup untuk meredam spam kasar dari satu sumber saja. Untuk
// proteksi yang benar-benar kuat, pertimbangkan Vercel Firewall /
// Upstash Ratelimit di masa depan.
const RATE_LIMIT_WINDOW_MS = 10_000; // 10 detik
const RATE_LIMIT_MAX_REQUESTS = 30;  // maksimal 30 request / IP / 10 detik
const rateLimitBuckets = new Map();  // ip -> [timestamps]

function isRateLimited(ip) {
    const now = Date.now();
    const timestamps = (rateLimitBuckets.get(ip) || []).filter(
        (t) => now - t < RATE_LIMIT_WINDOW_MS
    );
    timestamps.push(now);
    rateLimitBuckets.set(ip, timestamps);
    // Buang entri lama biar Map ini tidak membengkak selama instance hidup.
    if (rateLimitBuckets.size > 5000) rateLimitBuckets.clear();
    return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

function getAllowedOrigins() {
    return (process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

// Preview Vercel proyek ini (hanya VERCEL_ENV=preview; tidak pernah aktif di production)
function isPreviewOrigin(origin) {
    return process.env.VERCEL_ENV === 'preview' &&
        /^https:\/\/arcentic[a-z0-9-]*-dedy-mulyadi\.vercel\.app$/.test(origin);
}

const MAX_BATCH = 50;
const BLOCKED_METHOD = /^(debug_|trace_|admin_|txpool_|personal_|engine_|miner_)/i;

function checkRpcBody(body) {
    const items = Array.isArray(body) ? body : [body];
    if (items.length === 0 || items.length > MAX_BATCH) return { ok: false, error: 'Ukuran batch tidak valid.' };
    for (const it of items) {
        if (!it || typeof it !== 'object' || Array.isArray(it)) return { ok: false, error: 'Format JSON-RPC tidak valid.' };
        if (typeof it.method !== 'string' || it.method.length > 64) return { ok: false, error: 'method tidak valid.' };
        if (BLOCKED_METHOD.test(it.method)) return { ok: false, error: 'Method RPC ini tidak diizinkan.' };
        if (it.params !== undefined && !Array.isArray(it.params)) return { ok: false, error: 'params harus array.' };
    }
    return { ok: true, body };
}

export default async function handler(req, res) {
    const origin = req.headers.origin;
    const allowedOrigins = getAllowedOrigins();

    // Kalau ALLOWED_ORIGINS belum di-set sama sekali di Vercel, jangan
    // diam-diam balik ke '*' (itu justru bug lama yang sedang kita
    // perbaiki) — kasih pesan jelas supaya ketahuan pas testing, bukan
    // pas sudah di-abuse orang.
    if (allowedOrigins.length === 0) {
        res.status(500).json({
            error: 'Server misconfigured: ALLOWED_ORIGINS belum di-set di Vercel Environment Variables.'
        });
        return;
    }

    if (origin) {
        // Request dari browser (fetch/XHR cross- atau same-origin selalu
        // kirim header Origin) — harus cocok dengan whitelist.
        if (!allowedOrigins.includes(origin) && !isPreviewOrigin(origin)) {
            res.status(403).json({ error: 'Origin tidak diizinkan.' });
            return;
        }
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    // Kalau tidak ada header Origin sama sekali (misal dipanggil dari
    // server/skrip, bukan browser), tidak ada header CORS yang perlu
    // diset — browser lain tetap akan diblokir CORS-nya sendiri karena
    // kita hanya mengizinkan origin yang match di atas.

    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed. Use POST.' });
        return;
    }

    const clientIp =
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket?.remoteAddress ||
        'unknown';
    if (isRateLimited(clientIp)) {
        res.status(429).json({ error: 'Terlalu banyak request, coba lagi sebentar.' });
        return;
    }

    // Validasi: hanya JSON-RPC 2.0 biasa, batch dibatasi, method debug/trace/admin diblokir
    // (mahal di kuota Alchemy dan tidak dipakai frontend).
    const checked = checkRpcBody(req.body);
    if (!checked.ok) {
        res.status(400).json({ error: checked.error });
        return;
    }

    const targetUrl = process.env.ALCHEMY_RPC_URL;

    if (!targetUrl) {
        // Env var belum di-set di Vercel dashboard.
        res.status(500).json({
            error: 'Server misconfigured: ALCHEMY_RPC_URL belum di-set di Vercel Environment Variables.'
        });
        return;
    }

    try {
        // Body dari client (ethers.js / wallet) diteruskan apa adanya
        // ke Alchemy. req.body sudah otomatis di-parse jadi object oleh Vercel
        // kalau Content-Type: application/json.
        const upstreamResponse = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(checked.body),
            signal: AbortSignal.timeout(20_000)
        });

        const data = await upstreamResponse.json();
        res.status(upstreamResponse.status).json(data);
    } catch (err) {
        res.status(502).json({
            error: 'Gagal menghubungi RPC upstream.',
            detail: err.message
        });
    }
}
