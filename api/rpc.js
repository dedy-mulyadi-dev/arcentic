// api/rpc.js
//
// Proxy JSON-RPC untuk chain Arc Testnet.
// Tujuan: browser user tidak pernah lihat/kirim API key Alchemy secara
// langsung. Key disimpan di Vercel Environment Variable (server-side only).
//
// SETUP (wajib dilakukan manual di dashboard Vercel):
//   1. Buka project di vercel.com -> Settings -> Environment Variables
//   2. Tambahkan variable baru:
//        Name  : ALCHEMY_RPC_URL
//        Value : https://arc-testnet.g.alchemy.com/v2/<API_KEY_KAMU>
//      (pindahkan URL + key yang sebelumnya ada di app.js ke sini)
//   3. Redeploy project setelah menambahkan env var (env var baru butuh
//      redeploy baru supaya kebaca).
//
// Setelah itu, frontend (app.js) tidak lagi menyimpan key sama sekali —
// dia cuma manggil "/api/rpc" di domain sendiri.

export default async function handler(req, res) {
    // CORS dasar: izinkan dipanggil dari browser manapun (perlu untuk
    // WalletConnect / wallet mobile yang originnya beda-beda), tapi cuma
    // menerima method POST (format JSON-RPC standard).
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed. Use POST.' });
        return;
    }

    const targetUrl = process.env.ALCHEMY_RPC_URL;

    if (!targetUrl) {
        // Env var belum di-set di Vercel dashboard.
        res.status(500).json({
            error: 'Server misconfigured: ALCHEMY_RPC_URL belum di-set di Vercel Environment Variables.'
        });
        return;
    }

    try {
        // Body dari client (ethers.js / wallet) diteruskan apa adanya
        // ke Alchemy. req.body sudah otomatis di-parse jadi object oleh Vercel
        // kalau Content-Type: application/json.
        const upstreamResponse = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });

        const data = await upstreamResponse.json();
        res.status(upstreamResponse.status).json(data);
    } catch (err) {
        res.status(502).json({
            error: 'Gagal menghubungi RPC upstream.',
            detail: err.message
        });
    }
}
