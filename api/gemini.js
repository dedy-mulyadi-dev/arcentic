export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        // Gemini punya endpoint OpenAI-compatible, jadi body dari frontend
        // (yang sudah berformat OpenAI: messages, tools, tool_choice, dst)
        // bisa langsung diteruskan tanpa perlu konversi manual.
        // Hanya model name yang perlu disesuaikan ke nama model Gemini.
        const body = { ...req.body, model: 'gemini-2.0-flash' };

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
        return res.status(500).json({ error: err.message });
    }
}