// api/eiji-code.js
//
// Admin-only "coding mode" backend for Eiji AI. Lets Eiji read this
// project's own frontend source from GitHub and, after an explicit
// wallet-signed approval from the admin, commit a change back to GitHub.
//
// ================= SECURITY MODEL (read before deploying) =================
// - Every request is verified SERVER-SIDE against ADMIN_WALLET. The
//   frontend's isAdminWallet() check only hides/shows UI — it is NOT
//   trusted here, because anyone can call this endpoint directly with
//   devtools/curl. The server independently proves the caller controls
//   ADMIN_WALLET's private key via an EIP-191 personal_sign signature.
// - "session" action: admin signs ONCE to get a short-lived session
//   token (default 30 min). That token only grants READ access — it can
//   never be used to commit.
// - "commit" action: ALWAYS requires a FRESH signature over the exact
//   payload (path + new content + the file's current sha), regardless of
//   an active session. That signature is the actual "approve & push"
//   action — there is no other path that writes to GitHub.
// - File access is restricted to an explicit allowlist (EDITABLE_FILES).
//   Nothing else in the repo — including this file, vercel.json, or any
//   other file under /api — can ever be read or written through this
//   endpoint, even by the admin, without manually editing the allowlist
//   in the deployed source.
// - No database or KV store is used. Nonces/sessions are stateless,
//   self-verifying tokens (HMAC-signed with EIJI_ADMIN_SECRET), so this
//   works on serverless with zero extra infra. Trade-off: a nonce is
//   valid for its full TTL rather than being strictly single-use — kept
//   short (5 min) to limit exposure. Fine for a single-admin tool; if
//   you ever open this up further, add a real single-use store.
//
// ================= REQUIRED ENV VARS (Vercel Project Settings) =================
//   GITHUB_TOKEN      Fine-grained PAT scoped to ONLY this repo, with
//                      "Contents: Read and write" permission and nothing
//                      else (no admin/workflow/other scopes).
//   GITHUB_OWNER       e.g. "dedy-mulyadi-dev"
//   GITHUB_REPO        e.g. "arcentic"
//   GITHUB_BRANCH      e.g. "main"
//   ADMIN_WALLET       wallet address allowed to use this feature
//                      (should match ADMIN_WALLET in app.js)
//   EIJI_ADMIN_SECRET  any long random string — used to sign nonce/
//                      session tokens. Keep this secret. Generate with:
//                      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// ================= REQUIRED NPM DEPENDENCY =================
//   npm install ethers
//   (used only for EIP-191 signature verification — ethers.verifyMessage)

const crypto = require('crypto');
const { ethers } = require('ethers');

const EDITABLE_FILES = ['app.js', 'index.html', 'styles.css'];

const NONCE_TTL_MS = 5 * 60 * 1000;      // 5 minutes to use a nonce
const SESSION_TTL_MS = 30 * 60 * 1000;   // 30 minutes coding-mode session
const MAX_READ_LINES = 400;              // default cap when no range given
const MAX_RANGE_LINES = 600;             // hard cap per single read request

function hmac(data) {
    return crypto.createHmac('sha256', process.env.EIJI_ADMIN_SECRET || '').update(data).digest('hex');
}

function sha256Hex(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function shortHash(data) {
    return sha256Hex(data).slice(0, 16);
}

function makeToken(payloadObj, ttlMs) {
    const payload = { ...payloadObj, exp: Date.now() + ttlMs };
    const json = JSON.stringify(payload);
    const b64 = Buffer.from(json).toString('base64url');
    return b64 + '.' + hmac(json);
}

function verifyToken(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const idx = token.lastIndexOf('.');
    const b64 = token.slice(0, idx);
    const sig = token.slice(idx + 1);
    let json;
    try { json = Buffer.from(b64, 'base64url').toString('utf8'); } catch { return null; }
    if (hmac(json) !== sig) return null;
    let payload;
    try { payload = JSON.parse(json); } catch { return null; }
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
}

function isAdmin(addr) {
    const admin = (process.env.ADMIN_WALLET || '').toLowerCase();
    return !!addr && !!admin && String(addr).toLowerCase() === admin;
}

async function ghContents(path, opts = {}) {
    const url = `https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
    const res = await fetch(url, {
        ...opts,
        headers: {
            'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'eiji-admin-code',
            ...(opts.headers || {})
        }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.message || `GitHub API error ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return data;
}

module.exports = async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const action = (req.query && req.query.action) || (req.body && req.body.action);

    try {
        // ---- issue a nonce (no auth required to request one — it's useless
        // without a valid admin signature over it) ----
        if (action === 'nonce') {
            const nonceToken = makeToken({ t: 'nonce', n: crypto.randomBytes(16).toString('hex') }, NONCE_TTL_MS);
            return res.status(200).json({ nonceToken, nonceHash: shortHash(nonceToken) });
        }

        if (req.method !== 'POST') {
            return res.status(405).json({ error: 'Method not allowed' });
        }
        const body = req.body || {};

        // ---- exchange one signature for a short-lived READ-ONLY session ----
        if (action === 'session') {
            const { nonceToken, signature, wallet } = body;
            const nonce = verifyToken(nonceToken);
            if (!nonce || nonce.t !== 'nonce') {
                return res.status(400).json({ error: 'Nonce tidak valid atau sudah kedaluwarsa, coba lagi.' });
            }
            const message = `Eiji Coding Session\nwallet:${wallet}\nnonce:${shortHash(nonceToken)}`;
            let recovered;
            try { recovered = ethers.verifyMessage(message, signature); } catch { recovered = null; }
            if (!recovered || !isAdmin(recovered) || recovered.toLowerCase() !== String(wallet || '').toLowerCase()) {
                return res.status(403).json({ error: 'Wallet ini tidak punya akses coding mode.' });
            }
            const sessionToken = makeToken({ t: 'session', w: recovered.toLowerCase() }, SESSION_TTL_MS);
            return res.status(200).json({ sessionToken, expiresInMs: SESSION_TTL_MS });
        }

        // ---- read-only file access, gated by session token ----
        if (action === 'read') {
            const { sessionToken, path, startLine, endLine, query } = body;
            const session = verifyToken(sessionToken);
            if (!session || session.t !== 'session' || !isAdmin(session.w)) {
                return res.status(403).json({ error: 'Sesi coding mode tidak valid / kedaluwarsa. Aktifkan ulang coding mode.' });
            }
            if (!EDITABLE_FILES.includes(path)) {
                return res.status(400).json({ error: 'File ini tidak diizinkan diakses lewat Eiji.' });
            }

            const file = await ghContents(`${path}?ref=${process.env.GITHUB_BRANCH || 'main'}`);
            const content = Buffer.from(file.content, 'base64').toString('utf8');
            const lines = content.split('\n');

            if (query) {
                const q = String(query).toLowerCase();
                const matches = [];
                for (let i = 0; i < lines.length && matches.length < 20; i++) {
                    if (lines[i].toLowerCase().includes(q)) {
                        const from = Math.max(0, i - 3), to = Math.min(lines.length, i + 4);
                        matches.push({
                            line: i + 1,
                            snippet: lines.slice(from, to).map((l, idx) => `${from + idx + 1}: ${l}`).join('\n')
                        });
                    }
                }
                return res.status(200).json({ path, sha: file.sha, totalLines: lines.length, matches });
            }

            let start = startLine ? Math.max(1, parseInt(startLine, 10)) : 1;
            let end = endLine ? parseInt(endLine, 10) : Math.min(lines.length, MAX_READ_LINES);
            if (end < start) end = start;
            if (end - start + 1 > MAX_RANGE_LINES) end = start + MAX_RANGE_LINES - 1;
            end = Math.min(end, lines.length);
            const truncated = !startLine && !endLine && lines.length > MAX_READ_LINES;

            const numbered = lines.slice(start - 1, end).map((l, idx) => `${start + idx}: ${l}`).join('\n');
            return res.status(200).json({
                path, sha: file.sha, totalLines: lines.length,
                startLine: start, endLine: end, truncated, content: numbered
            });
        }

        // ---- commit a line-range replacement, gated by a FRESH signature ----
        if (action === 'commit') {
            const { path, newText, startLine, endLine, sha, commitMessage, signature, message, nonceToken, wallet } = body;
            const nonce = verifyToken(nonceToken);
            if (!nonce || nonce.t !== 'nonce') {
                return res.status(400).json({ error: 'Nonce tidak valid atau sudah kedaluwarsa, minta Eiji baca ulang lalu coba lagi.' });
            }
            if (!EDITABLE_FILES.includes(path)) {
                return res.status(400).json({ error: 'File ini tidak diizinkan di-commit lewat Eiji.' });
            }
            if (typeof newText !== 'string' || !sha || !startLine || !endLine) {
                return res.status(400).json({ error: 'Payload tidak lengkap.' });
            }

            const payloadHash = shortHash(JSON.stringify({ path, newText, startLine, endLine, sha }));
            const expectedMessage = `Eiji Admin Commit\nwallet:${wallet}\npath:${path}\nlines:${startLine}-${endLine}\npayloadHash:${payloadHash}\nnonce:${shortHash(nonceToken)}`;
            if (message !== expectedMessage) {
                return res.status(400).json({ error: 'Pesan yang ditandatangani tidak cocok dengan payload — dibatalkan demi keamanan.' });
            }
            let recovered;
            try { recovered = ethers.verifyMessage(message, signature); } catch { recovered = null; }
            if (!recovered || !isAdmin(recovered) || recovered.toLowerCase() !== String(wallet || '').toLowerCase()) {
                return res.status(403).json({ error: 'Wallet ini tidak punya akses admin.' });
            }

            // Always re-fetch the CURRENT file from GitHub and splice against
            // that — never trust any full-file content the client may have
            // cached — so parts of the file Eiji never even looked at can
            // never be lost, no matter how partial its read was.
            const file = await ghContents(`${path}?ref=${process.env.GITHUB_BRANCH || 'main'}`);
            if (file.sha !== sha) {
                return res.status(409).json({ error: 'File sudah berubah di GitHub sejak terakhir dibaca. Minta Eiji baca ulang file ini dulu.' });
            }
            const lines = Buffer.from(file.content, 'base64').toString('utf8').split('\n');
            const s = Math.max(1, parseInt(startLine, 10));
            const e = Math.min(lines.length, parseInt(endLine, 10));
            const newLines = newText.split('\n');
            lines.splice(s - 1, e - s + 1, ...newLines);
            const newContent = lines.join('\n');

            const result = await ghContents(path, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: commitMessage || `Eiji AI: update ${path} (lines ${s}-${e})`,
                    content: Buffer.from(newContent, 'utf8').toString('base64'),
                    sha: file.sha,
                    branch: process.env.GITHUB_BRANCH || 'main',
                    committer: { name: 'Eiji AI', email: 'eiji-bot@users.noreply.github.com' }
                })
            });

            return res.status(200).json({
                ok: true,
                commitSha: result.commit && result.commit.sha,
                commitUrl: result.commit && result.commit.html_url,
                newFileSha: result.content && result.content.sha
            });
        }

        return res.status(400).json({ error: 'Aksi tidak dikenal.' });
    } catch (err) {
        console.error('eiji-code error:', err);
        if (err.status === 409) {
            return res.status(409).json({ error: 'File sudah berubah di GitHub sejak terakhir dibaca. Minta Eiji baca ulang file ini dulu.' });
        }
        return res.status(500).json({ error: err.message || 'Terjadi kesalahan server.' });
    }
};
