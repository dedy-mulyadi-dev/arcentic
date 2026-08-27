import { guard } from './_guard.js';

export default async function handler(req, res) {
    if (!guard(req, res)) return;

    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ error: 'GEMINI_API_KEY belum diset di server.' });
    }

    try {
        // GANTI Agu 2026: 'gemini-2.0-flash' sudah tidak tersedia lagi
        // (pesan error Google eksplisit menyuruh pindah ke gemini-3.6-flash).
        const body = { ...(req.body || {}), model: 'gemini-3.6-flash' };

        const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + process.env.GEMINI_API_KEY
            },
            body: JSON.stringify(body)
        });
        const data = await response.json();
        return res.status(response.status).json(data);
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
}
