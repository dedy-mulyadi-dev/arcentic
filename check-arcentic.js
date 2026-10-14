/* check-arcentic.js
   Pakai: node check-arcentic.js
          node check-arcentic.js https://NAMA-PROYEKMU.vercel.app
   Butuh Node 18+ (fetch bawaan). */
const fs = require('fs');
const vm = require('vm');

if (typeof fetch !== 'function') {
    console.log('Node kamu terlalu lama (butuh 18+). Cek: node -v');
    process.exit(1);
}

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('network-config.js', 'utf8'), ctx);
const NET = ctx.window.ARCENTIC_NETWORK;
const C = ctx.window.ARCENTIC_NETWORK_CONFIG;

async function rpc(url, method, params) {
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] })
    });
    return r.json();
}

(async () => {
    console.log('\n=== KONFIGURASI ===');
    console.log('Network aktif :', NET, '| chainId', C.chainIdDec, '(' + C.chainIdHex + ')');
    console.log('attestationApi:', C.attestationApi);
    Object.entries(C.contracts).forEach(([k, v]) => console.log(' ', (v ? 'terisi ' : 'NULL   '), k, v || ''));

    console.log('\n=== RPC PUBLIK ===');
    const url = C.rpcUrls[0];
    try {
        const j = await rpc(url, 'eth_chainId');
        const ok = j.result && j.result.toLowerCase() === C.chainIdHex.toLowerCase();
        console.log(ok ? 'OK    ' : 'SALAH ', url, '->', j.result, ok ? '' : '(harusnya ' + C.chainIdHex + ')');
    } catch (e) { console.log('GAGAL ', url, e.message); }

    console.log('\n=== ADA KONTRAK DI ALAMAT? ===');
    for (const [k, v] of Object.entries(C.contracts)) {
        if (!v) continue;
        try {
            const j = await rpc(url, 'eth_getCode', [v, 'latest']);
            const empty = !j.result || j.result === '0x';
            console.log(empty ? 'KOSONG' : 'ada   ', k, v);
        } catch (e) { console.log('GAGAL ', k, e.message); }
    }

    const stk = C.contracts.ArcenticStaking;
    if (stk) {
        try {
            const j = await rpc(url, 'eth_call', [{ to: stk, data: '0x8da5cb5b' }, 'latest']);
            console.log('\nStaking owner() ->', j.result ? '0x' + j.result.slice(-40) : JSON.stringify(j.error || j));
        } catch (e) { console.log('Staking owner() gagal:', e.message); }
    }

    const site = (process.argv[2] || '').replace(/\/$/, '');
    if (site) {
        console.log('\n=== SITUS: ' + site + ' ===');
        try {
            const j = await rpc(site + '/api/rpc', 'eth_chainId');
            const ok = j.result && j.result.toLowerCase() === C.chainIdHex.toLowerCase();
            console.log(ok ? 'OK    ' : 'SALAH ', '/api/rpc ->', j.result || JSON.stringify(j),
                ok ? '' : '(harusnya ' + C.chainIdHex + ' - cek env ALCHEMY_RPC_URL di Vercel)');
        } catch (e) { console.log('GAGAL /api/rpc:', e.message); }

        const probes = [
            ['/api/tavily', { query: 'test', max_results: 1 }],
            ['/api/groq', { model: 'qwen/qwen3.6-27b', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }]
        ];
        for (const [path, body] of probes) {
            try {
                const r = await fetch(site + path, {
                    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
                });
                console.log(r.ok ? 'TERBUKA tanpa auth (kuota bisa dikuras orang)' : 'ditolak/ error ' + r.status, path);
            } catch (e) { console.log('GAGAL', path, e.message); }
        }
    } else {
        console.log('\n(Tambahkan URL situs sebagai argumen untuk tes /api/rpc, /api/tavily, /api/groq)');
    }
    console.log('');
})();
