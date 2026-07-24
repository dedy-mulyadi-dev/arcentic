// build.js
// Build step sederhana (tanpa dependency tambahan) untuk cache-busting.
//
// Yang dilakukan:
// 1. Baca app.js dan styles.css
// 2. Hitung content hash pendek (8 karakter) dari isi masing-masing file
// 3. Tulis ulang file itu ke dist/ dengan nama ber-hash, misal app.a1b2c3d4.js
// 4. Baca index.html, ganti referensi "app.js" dan "styles.css" jadi nama
//    ber-hash tsb, lalu tulis ke dist/index.html
// 5. Salin semua file lain di root (selain node_modules, dist, build.js, .git)
//    apa adanya ke dist/, supaya aset lain (kalau ada) tidak ketinggalan
//
// Karena nama file berubah otomatis setiap isinya berubah, aman untuk
// dicache browser/CDN selamanya (immutable) — deploy baru = nama baru,
// jadi tidak akan pernah menyajikan versi basi.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

function hashOf(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
}

function main() {
  // Reset folder output
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  const targets = [
    { file: 'app.js', ext: '.js' },
    { file: 'vault.js', ext: '.js' },
    { file: 'styles.css', ext: '.css' },
  ];

  const renameMap = {}; // "app.js" -> "app.a1b2c3d4.js"

  for (const t of targets) {
    const srcPath = path.join(ROOT, t.file);
    if (!fs.existsSync(srcPath)) {
      console.warn(`  (lewati, tidak ditemukan: ${t.file})`);
      continue;
    }
    const content = fs.readFileSync(srcPath);
    const hash = hashOf(content);
    const base = path.basename(t.file, t.ext);
    const hashedName = `${base}.${hash}${t.ext}`;
    fs.writeFileSync(path.join(DIST, hashedName), content);
    renameMap[t.file] = hashedName;
    console.log(`  ${t.file} -> ${hashedName}`);
  }

  // Update index.html dengan nama file baru
  const htmlPath = path.join(ROOT, 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  for (const [oldName, newName] of Object.entries(renameMap)) {
    // Ganti hanya kemunculan nama file sebagai referensi src/href persis,
    // supaya tidak menimpa teks lain yang kebetulan sama.
    const re = new RegExp(`(["'])${oldName.replace('.', '\\.')}\\1`, 'g');
    html = html.replace(re, `$1${newName}$1`);
  }
  fs.writeFileSync(path.join(DIST, 'index.html'), html);
  console.log('  index.html diperbarui referensinya');

  // Salin HANYA aset statis yang aman untuk publik (whitelist ekstensi),
  // bukan copy-semua-kecuali-skip. Ini sengaja: folder seperti api/,
  // contracts/, artifacts/, atau file seperti secrets.js TIDAK BOLEH
  // pernah ikut masuk ke dist/ (yang jadi output publik), walau lupa
  // ditambahkan ke skip list.
  const SAFE_EXT = new Set(['.png', '.jpg', '.jpeg', '.svg', '.ico', '.webp', '.gif', '.woff', '.woff2', '.ttf']);
  for (const entry of fs.readdirSync(ROOT)) {
    const src = path.join(ROOT, entry);
    if (!fs.statSync(src).isFile()) continue; // lewati semua folder (api/, contracts/, artifacts/, dll)
    const ext = path.extname(entry).toLowerCase();
    if (!SAFE_EXT.has(ext)) continue; // lewati semua file non-aset (secrets.js, .env, dll)
    fs.cpSync(src, path.join(DIST, entry));
    console.log(`  aset disalin: ${entry}`);
  }

  console.log('Build selesai -> dist/');
}

main();
