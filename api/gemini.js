import { guard, sanitizeChatBody, fetchUpstream, readUpstream } from './_guard.js';

export default async function handler(req, res) {
    if (!guard(req, res)) return;

    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ error: 'GEMINI_API_KEY belum diset di server.' });
    }

    // GANTI Agu 2026: 'gemini-2.0-flash' sudah tidak tersedia lagi
    // (pesan error Google eksplisit menyuruh pindah ke gemini-3.6-flash).
    // Model selalu dipaksa dari server; model kiriman browser diabaikan.
    const checked = sanitizeChatBody(req.body, { forceModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash' });
    if (!checked.ok) return res.status(checked.status).json({ error: checked.error });

    try {
        const response = await fetchUpstream('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + process.env.GEMINI_API_KEY
            },
            body: JSON.stringify(checked.body)
        });
        const data = await readUpstream(response);
        return res.status(response.status).json(data);
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
}
