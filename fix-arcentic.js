/* fix-arcentic.js
   Pakai: node fix-arcentic.js            -> terapkan perbaikan bug
          node fix-arcentic.js testnet    -> perbaikan + ganti ARC_NETWORK ke testnet
          node fix-arcentic.js mainnet    -> perbaikan + ganti ARC_NETWORK ke mainnet
   Aman dijalankan berulang kali. Backup otomatis: <file>.bak (dibuat sekali). */
const fs = require('fs');

const arg = (process.argv[2] || '').toLowerCase();
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

step('app.js: tambah connectWallet()', 'app.js', (t) => {
    if (/function\s+connectWallet\s*\(/.test(t)) return t;
    return t + '\n\n/* fix: dipanggil tombol Stake & Lend */\nfunction connectWallet() { return handleWallet(); }\n';
});

step('app.js: hapus baris preview yang menunjuk elemen tidak ada', 'app.js', (t) => {
    const eol = t.includes('\r\n') ? '\r\n' : '\n';
    return t.split(/\r?\n/)
        .filter((l) => !/getElementById\('(deposit|borrow)PreviewAmt'\)/.test(l))
        .join(eol);
});

step('app.js: vaultView masuk hideAllOverlays()', 'app.js', (t) => {
    if (t.includes("'spotTradeView','vaultView'")) return t;
    return t.replace("'tradingHubView','spotTradeView']", "'tradingHubView','spotTradeView','vaultView']");
});

step('app.js: matikan Bridge di mainnet', 'app.js', (t) => {
    if (t.includes('ARCENTIC-FIX bridge-guard')) return t;
    return t.replace(/async function executeBridge\(\) \{/, (m) =>
        m + "\n        /* ARCENTIC-FIX bridge-guard */\n" +
        "        if (window.ARCENTIC_NETWORK === 'mainnet') {\n" +
        "            showToast('warning','Bridge Belum Tersedia','Bridge dinonaktifkan di mainnet sampai konfigurasi CCTP mainnet selesai.');\n" +
        "            return;\n" +
        "        }");
});

step('vault.js: jangan buat Contract kalau alamat null', 'vault.js', (t) => {
    return t.replace(
        /vaultRO = new ethers\.Contract\(VAULT_CONFIG\.address, VAULT_ABI, readProvider\);/,
        'vaultRO = VAULT_CONFIG.address ? new ethers.Contract(VAULT_CONFIG.address, VAULT_ABI, readProvider) : null;'
    );
});

if (arg === 'testnet' || arg === 'mainnet') {
    step('network-config.js: ARC_NETWORK = ' + arg, 'network-config.js', (t) =>
        t.replace(/^(\s*)const ARC_NETWORK = '(?:testnet|mainnet)';/m, "$1const ARC_NETWORK = '" + arg + "';")
    );
}

console.log('');
results.forEach((r) => console.log(r));
console.log('');
console.log('Selesai. Backup ada di file *.bak. Lanjut ke langkah "Cek syntax".');
