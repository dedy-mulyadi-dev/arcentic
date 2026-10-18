import { guard, sanitizeTavilyBody, fetchUpstream, readUpstream } from './_guard.js';

export default async function handler(req, res) {
    if (!guard(req, res)) return;

    if (!process.env.TAVILY_API_KEY) {
        return res.status(500).json({ error: 'TAVILY_API_KEY belum diset di server.' });
    }

    // Hanya query, search_depth, max_results (1-8), include_answer, topic yang diteruskan;
    // opsi mahal seperti include_raw_content dibuang.
    const checked = sanitizeTavilyBody(req.body);
    if (!checked.ok) return res.status(checked.status).json({ error: checked.error });

    try {
        const response = await fetchUpstream('https://api.tavily.com/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + process.env.TAVILY_API_KEY
            },
            body: JSON.stringify(checked.body)
        });
        const data = await readUpstream(response);
        return res.status(response.status).json(data);
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
}
