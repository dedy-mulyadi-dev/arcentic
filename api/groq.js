import { guard, sanitizeChatBody, parseModelList, fetchUpstream, readUpstream } from './_guard.js';

export default async function handler(req, res) {
    if (!guard(req, res)) return;

    if (!process.env.GROQ_API_KEY) {
        return res.status(500).json({ error: 'GROQ_API_KEY belum diset di server.' });
    }

    // Model dipilih frontend (supaya bisa diganti tanpa deploy server), tapi format dan batasnya
    // dicek. Isi GROQ_ALLOWED_MODELS di Vercel (pisahkan koma) untuk mengunci ke model tertentu.
    const checked = sanitizeChatBody(req.body, { allowedModels: parseModelList(process.env.GROQ_ALLOWED_MODELS) });
    if (!checked.ok) return res.status(checked.status).json({ error: checked.error });

    try {
        const response = await fetchUpstream('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
            },
            body: JSON.stringify(checked.body)
        });
        const data = await readUpstream(response);
        return res.status(response.status).json(data);
    } catch (err) {
        return res.status(502).json({ error: err.message });
    }
}
