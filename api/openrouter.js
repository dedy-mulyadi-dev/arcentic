import { guard } from './_guard.js';

// Fallback provider untuk Eiji. OpenRouter itu OpenAI-compatible, jadi body dari
// frontend (messages, tools, tool_choice) bisa langsung diteruskan. Model bisa
// diatur lewat env OPENROUTER_MODEL (default: llama-3.3-70b yang mendukung tools).
export default async function handler(req, res) {
    if (!guard(req, res)) return;

    if (!process.env.OPENROUTER_API_KEY) {
        return res.status(500).json({ error: 'OPENROUTER_API_KEY belum diset di server.' });
    }

    try {
        const body = {
            ...(req.body || {}),
            model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct'
        };

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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
            body: JSON.stringify(body)
        });
        const data = await response.json();
        return res.status(response.status).json(data);
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
}
