import { guard } from './_guard.js';

// CATATAN: file ini bernama "openrouter" tapi sebenarnya memanggil Groq
// (api.groq.com), dan frontend (app.js) TIDAK memanggil /api/openrouter sama
// sekali — jadi endpoint ini tidak terpakai. Boleh kamu hapus. Aku biarkan
// (dengan pengamanan) supaya kalau masih ada yang memakainya tidak error.
export default async function handler(req, res) {
    if (!guard(req, res)) return;

    if (!process.env.GROQ_API_KEY) {
        return res.status(500).json({ error: 'GROQ_API_KEY belum diset di server.' });
    }

    try {
        const body = { ...(req.body || {}), model: 'llama-3.3-70b-versatile' };

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
            },
            body: JSON.stringify(body)
        });
        const data = await response.json();
        return res.status(response.status).json(data);
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
}
