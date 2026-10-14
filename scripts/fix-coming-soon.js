/* fix-coming-soon.js
   Pakai: node fix-coming-soon.js
   Untuk network yang kontraknya belum lengkap (mainnet saat ini):
   - Swap, Pools, Spot Trading, Lend & Borrow, Bridge, Vault -> tampil redup + toast "Coming Soon", tidak membuka halaman rusak
   - Grafik TVL palsu di hero (garis naik yang di-hardcode) -> jadi garis datar putus-putus
   Otomatis tidak berbuat apa-apa untuk modul yang kontraknya sudah terisi.
   Aman dijalankan berulang. Backup: <file>.bak (dibuat sekali). */
const fs = require('fs');
const results = [];

function step(label, file, fn) {
    if (!fs.existsSync(file)) { results.push('SKIP  ' + label + '  (' + file + ' tidak ditemukan)'); return; }
    const before = fs.readFileSync(file, 'utf8');
    const after = fn(before);
    if (after === before) { results.push('SAMA  ' + label + '  (sudah beres / tidak ada yang cocok)'); return; }
    if (!fs.existsSync(file + '.bak')) fs.copyFileSync(file, file + '.bak');
    fs.writeFileSync(file, after);
    results.push('OK    ' + label);
}

const GATE_BLOCK = [
    "/* ARCENTIC-FIX coming-soon-gate */",
    "(function () {",
    "    var C = (NET && NET.contracts) || {};",
    "    var gates = [",
    "        { fn: 'showSwap',      ok: !!C.ArcenticMultiPool, label: 'Swap' },",
    "        { fn: 'showPools',     ok: !!C.ArcenticMultiPool, label: 'Liquidity Pools' },",
    "        { fn: 'showSpotTrade', ok: !!C.ArcenticMultiPool, label: 'Spot Trading' },",
    "        { fn: 'showLend',      ok: !!(C.LendingBorrowing && C.cirBTC), label: 'Lend & Borrow' },",
    "        { fn: 'showBridge',    ok: !!NET.attestationApi, label: 'Bridge' },",
    "        { fn: 'showVault',     ok: !!C.ArcenticVault, label: 'Vault' }",
    "    ];",
    "    gates.forEach(function (g) {",
    "        if (g.ok) return;",
    "        try {",
    "            document.querySelectorAll('[onclick*=\"' + g.fn + '(\"]').forEach(function (el) {",
    "                el.style.opacity = '.5';",
    "                el.title = g.label + ' - coming soon on mainnet';",
    "            });",
    "        } catch (e) {}",
    "        if (g.fn === 'showVault') return; /* showVault didefinisikan di vault.js, dijaga di sana */",
    "        if (typeof window[g.fn] !== 'function') return;",
    "        window[g.fn] = function () {",
    "            showToast('info', 'Coming Soon', g.label + ' belum aktif di mainnet.');",
    "        };",
    "    });",
    "    var line = document.getElementById('heroChartLine');",
    "    if (line) {",
    "        line.setAttribute('points', '0,110 1000,110');",
    "        line.setAttribute('stroke-dasharray', '10 10');",
    "        line.style.opacity = '.35';",
    "    }",
    "})();",
    ""
].join('\n');

step('app.js: gate "Coming Soon" + grafik hero palsu jadi datar', 'app.js', (t) => {
    if (t.includes('ARCENTIC-FIX coming-soon-gate')) return t;
    const anchor = '(function setupHashRouting() {';
    if (!t.includes(anchor)) return t;
    const eol = t.includes('\r\n') ? '\r\n' : '\n';
    const block = GATE_BLOCK.replace(/\n/g, eol);
    return t.replace(anchor, () => block + eol + anchor);
});

step('vault.js: Vault tampil "Coming Soon" kalau alamat null', 'vault.js', (t) => {
    if (t.includes('ARCENTIC-FIX vault-gate')) return t;
    return t.replace(/window\.showVault = function \(\) \{/, (m) =>
        m + "\n        /* ARCENTIC-FIX vault-gate */\n" +
        "        if (!VAULT_CONFIG.address) {\n" +
        "            if (window.showToast) window.showToast('info', 'Coming Soon', 'Vault belum aktif di mainnet.');\n" +
        "            return;\n" +
        "        }");
});

console.log('');
results.forEach((r) => console.log(r));
console.log('');
console.log('Selesai. Cek syntax lalu tes lokal sebelum git push.');
