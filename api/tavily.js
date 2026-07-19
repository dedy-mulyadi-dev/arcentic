import { guard } from './_guard.js';

export default async function handler(req, res) {
    if (!guard(req, res)) return;

    if (!process.env.TAVILY_API_KEY) {
        return res.status(500).json({ error: 'TAVILY_API_KEY belum diset di server.' });
    }

    try {
        const response = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + process.env.TAVILY_API_KEY
            },
            body: JSON.stringify(req.body || {})
        });
        const data = await response.json();
        return res.status(response.status).json(data);
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
}
