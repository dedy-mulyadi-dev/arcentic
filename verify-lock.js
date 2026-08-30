#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   verify-lock.js — Penjaga zona kode kritis ARCENTIC.
   ----------------------------------------------------------------------------
   KENAPA INI ADA:
   Beberapa kali AI coding assistant (Eiji) atau editan manual pernah hampir/
   benar-benar mengubah baris yang seharusnya tidak disentuh — baik karena
   salah paham instruksi, atau lupa baris lain ikut kepotong. File ini tidak
   mencegah AI mengedit, tapi memastikan kalau sebuah zona yang ditandai
   "terkunci" berubah, kamu SADAR sebelum commit itu ter-push — bukan baru
   ketahuan pas sudah production dan orang lain yang melapor rusak.

   CARA KERJA:
   1. Di file sumber (app.js, index.html, network-config.js, eiji-code.js),
      zona kritis dibungkus komentar:
        // ARCENTIC-LOCK:nama-zona
        ...kode...
        // ARCENTIC-LOCK-END:nama-zona
      (pakai gaya komentar HTML atau JS apa pun — bebas, script ini
      cuma mencari teks penandanya, bukan parsing sintaks komentar).
   2. Isi persis di antara dua marker itu di-hash (SHA-256).
   3. Hash "yang sah" disimpan di .arcentic-lock.json (WAJIB di-commit ke git,
      supaya semua orang/AI yang kerja di repo ini pakai baseline yang sama).
   4. Setiap kali script ini dijalankan (`npm run verify-lock`), hash zona
      SEKARANG dibandingkan ke baseline. Kalau beda → exit code 1, penjelasan
      rinci ditampilkan di terminal, proses gagal (cocok dipasang sebagai
      pre-commit hook atau langkah wajib sebelum push).

   CARA PAKAI:
     node verify-lock.js              → cek semua zona, gagal kalau ada yang berubah
     node verify-lock.js --update     → tulis ulang baseline dari isi SEKARANG
                                         (pakai ini SETELAH kamu yakin perubahan
                                         di zona terkunci itu memang disengaja)
     node verify-lock.js --list       → tampilkan semua zona yang terdaftar

   PENTING: --update TIDAK melakukan verifikasi apa pun, cuma menerima kondisi
   sekarang sebagai "benar". Jangan jalankan --update untuk menghilangkan
   error tanpa membaca dulu APA yang berubah dan APAKAH itu memang maksudmu.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const BASELINE_PATH = path.join(ROOT, '.arcentic-lock.json');

// Daftar file yang discan untuk marker ARCENTIC-LOCK.
// Tambahkan file lain di sini kalau ada zona kritis baru di masa depan.
const WATCHED_FILES = [
    'app.js',
    'index.html',
    'network-config.js',
    'api/eiji-code.js',
];

const LOCK_START_RE = (id) => new RegExp(`ARCENTIC-LOCK:${escapeRe(id)}\\b`);
const LOCK_END_RE   = (id) => new RegExp(`ARCENTIC-LOCK-END:${escapeRe(id)}\\b`);

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sha256(str) {
    return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// Cari semua pasangan marker ARCENTIC-LOCK:<id> ... ARCENTIC-LOCK-END:<id>
// di satu file, dan ambil isi PERSIS di antara baris marker (marker sendiri
// tidak ikut di-hash, supaya ganti kata-kata di komentar marker tidak
// dianggap "berubah").
function extractZones(filePath, content) {
    const lines = content.split('\n');
    const zones = [];
    const openMarkers = new Map(); // id -> lineIndex

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const startMatch = line.match(/ARCENTIC-LOCK:([a-zA-Z0-9_-]+)/);
        const endMatch = line.match(/ARCENTIC-LOCK-END:([a-zA-Z0-9_-]+)/);

        if (startMatch && !endMatch) {
            const id = startMatch[1];
            if (openMarkers.has(id)) {
                throw new Error(
                    `${filePath}: marker "${id}" dibuka dua kali tanpa ditutup ` +
                    `(baris ${openMarkers.get(id) + 1} dan ${i + 1}).`
                );
            }
            openMarkers.set(id, i);
        }
        if (endMatch) {
            const id = endMatch[1];
            if (!openMarkers.has(id)) {
                throw new Error(
                    `${filePath}: ARCENTIC-LOCK-END:"${id}" di baris ${i + 1} ` +
                    `tidak punya pasangan ARCENTIC-LOCK pembuka.`
                );
            }
            const startLine = openMarkers.get(id);
            const zoneLines = lines.slice(startLine + 1, i); // isi TANPA baris marker
            zones.push({
                id,
                file: filePath,
                startLine: startLine + 1,
                endLine: i + 1,
                content: zoneLines.join('\n'),
            });
            openMarkers.delete(id);
        }
    }

    for (const [id, lineIdx] of openMarkers) {
        throw new Error(
            `${filePath}: ARCENTIC-LOCK:"${id}" di baris ${lineIdx + 1} tidak ` +
            `pernah ditutup dengan ARCENTIC-LOCK-END:"${id}".`
        );
    }

    return zones;
}

function collectAllZones() {
    const allZones = [];
    for (const rel of WATCHED_FILES) {
        const full = path.join(ROOT, rel);
        if (!fs.existsSync(full)) {
            console.warn(`⚠  Dilewati (file tidak ada di sini): ${rel}`);
            continue;
        }
        const content = fs.readFileSync(full, 'utf8');
        const zones = extractZones(rel, content);
        allZones.push(...zones);
    }
    return allZones;
}

function loadBaseline() {
    if (!fs.existsSync(BASELINE_PATH)) return null;
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

function saveBaseline(zones) {
    const baseline = {};
    for (const z of zones) {
        baseline[z.id] = { file: z.file, hash: sha256(z.content) };
    }
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    return baseline;
}

function preview(text, maxLines = 6) {
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    return lines.slice(0, maxLines).map((l) => '      ' + l.trim()).join('\n');
}

function main() {
    const args = process.argv.slice(2);
    const mode = args.includes('--update') ? 'update' : args.includes('--list') ? 'list' : 'check';

    let zones;
    try {
        zones = collectAllZones();
    } catch (err) {
        console.error('\n🔴 GAGAL — struktur marker ARCENTIC-LOCK rusak:\n');
        console.error('   ' + err.message + '\n');
        console.error('   Perbaiki pasangan marker (LOCK harus punya LOCK-END dengan id sama)');
        console.error('   sebelum lanjut commit.\n');
        process.exit(1);
    }

    if (zones.length === 0) {
        console.warn('⚠  Tidak ada zona ARCENTIC-LOCK ditemukan di file yang dipantau.');
        process.exit(0);
    }

    if (mode === 'list') {
        console.log(`\n📋 ${zones.length} zona terkunci ditemukan:\n`);
        for (const z of zones) {
            console.log(`   • ${z.id}  (${z.file}, baris ${z.startLine}-${z.endLine})`);
        }
        console.log('');
        process.exit(0);
    }

    if (mode === 'update') {
        const baseline = saveBaseline(zones);
        console.log(`\n✅ Baseline diperbarui — ${Object.keys(baseline).length} zona disimpan ke .arcentic-lock.json`);
        console.log('   Commit file .arcentic-lock.json ini bersamaan dengan perubahan kodenya.\n');
        process.exit(0);
    }

    // mode === 'check'
    const baseline = loadBaseline();
    if (!baseline) {
        console.error('\n🔴 GAGAL — .arcentic-lock.json belum ada.');
        console.error('   Jalankan `node verify-lock.js --update` sekali untuk membuat baseline awal,');
        console.error('   lalu commit file .arcentic-lock.json ke git.\n');
        process.exit(1);
    }

    const problems = [];
    for (const z of zones) {
        const currentHash = sha256(z.content);
        const base = baseline[z.id];
        if (!base) {
            problems.push({ type: 'new-zone', zone: z });
            continue;
        }
        if (base.hash !== currentHash) {
            problems.push({ type: 'changed', zone: z, base });
        }
    }
    // Zona yang ada di baseline tapi hilang dari kode (marker ke-delete)
    for (const id of Object.keys(baseline)) {
        if (!zones.find((z) => z.id === id)) {
            problems.push({ type: 'missing', id, base: baseline[id] });
        }
    }

    if (problems.length === 0) {
        console.log(`\n✅ Semua ${zones.length} zona terkunci masih utuh. Aman untuk commit.\n`);
        process.exit(0);
    }

    console.error(`\n🔴 GAGAL VERIFIKASI — ${problems.length} zona bermasalah:\n`);
    for (const p of problems) {
        if (p.type === 'changed') {
            console.error(`   ✗ "${p.zone.id}" di ${p.zone.file} (baris ${p.zone.startLine}-${p.zone.endLine}) BERUBAH dari baseline.`);
            console.error(`     Isi zona ini SEKARANG:`);
            console.error(preview(p.zone.content));
            console.error('');
        } else if (p.type === 'new-zone') {
            console.error(`   ⚠ "${p.zone.id}" di ${p.zone.file} — zona BARU, belum ada di baseline.`);
            console.error(`     Kalau ini memang zona baru yang kamu tambahkan sengaja, jalankan --update.\n`);
        } else if (p.type === 'missing') {
            console.error(`   ✗ "${p.id}" (harusnya di ${p.base.file}) — marker HILANG dari kode!`);
            console.error(`     Ini tanda paling serius: seluruh blok kode yang tadinya dijaga zona ini`);
            console.error(`     mungkin ikut terhapus. Cek riwayat git file ${p.base.file} SEKARANG.\n`);
        }
    }
    console.error('   Kalau semua perubahan di atas memang kamu maksudkan (sudah kamu cek satu-satu),');
    console.error('   jalankan: node verify-lock.js --update\n');
    console.error('   Kalau TIDAK yakin — JANGAN commit. Cek dulu apa yang mengubah zona ini.\n');
    process.exit(1);
}

main();
