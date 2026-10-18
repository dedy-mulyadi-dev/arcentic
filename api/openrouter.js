import { guard, sanitizeChatBody, fetchUpstream, readUpstream } from './_guard.js';

// Fallback provider untuk Eiji. OpenRouter itu OpenAI-compatible, jadi body dari
// frontend (messages, tools, tool_choice) bisa langsung diteruskan. Model bisa
// diatur lewat env OPENROUTER_MODEL (default: llama-3.3-70b yang mendukung tools).
export default async function handler(req, res) {
    if (!guard(req, res)) return;

    if (!process.env.OPENROUTER_API_KEY) {
        return res.status(500).json({ error: 'OPENROUTER_API_KEY belum diset di server.' });
    }

    const checked = sanitizeChatBody(req.body, {
        forceModel: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct'
    });
    if (!checked.ok) return res.status(checked.status).json({ error: checked.error });

    try {
        const response = await fetchUpstream('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
                // OpenRouter menyarankan 2 header ini untuk atribusi aplikasi.
                'HTTP-Referer': process.env.ALLOWED_ORIGINS
                    ? process.env.ALLOWED_ORIGINS.split(',')[0].trim()
                    : 'https://arcentic.vercel.app',
                'X-Title': 'ARCENTIC Eiji'
            },
            body: JSON.stringify(checked.body)
        });
        const data = await readUpstream(response);
        return res.status(response.status).json(data);
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
}
