import { guard } from './_guard.js';

export default async function handler(req, res) {
    if (!guard(req, res)) return;

    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ error: 'GEMINI_API_KEY belum diset di server.' });
    }

    try {
        // Gemini punya endpoint OpenAI-compatible, jadi body dari frontend
        // (messages, tools, tool_choice, dst) bisa langsung diteruskan.
        // Hanya model name yang disesuaikan ke nama model Gemini.
        const body = { ...(req.body || {}), model: 'gemini-2.0-flash' };

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
