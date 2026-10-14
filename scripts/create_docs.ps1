$checklistContent = @'
# Checklist Deploy ARCENTIC ke Arc Mainnet

Status per 15 Agustus 2026: Arc mainnet publik dijadwalkan **16 September 2026**.
Alamat kontrak mainnet **belum dirilis** — dokumentasi resmi Arc masih eksplisit
bilang "Mainnet addresses are not yet available". Checklist ini disiapkan
sekarang supaya begitu Arc rilis info, kamu tinggal isi field kosong dan jalan,
bukan mulai riset dari nol saat waktu sudah mepet.

---

## Fase 0 — Persiapan (bisa dikerjakan SEKARANG, sebelum mainnet resmi)

- [ ] Buka `REMIX_DEPLOYMENT_GUIDE.md` — itu panduan detail step-by-step di
      Remix IDE, dokumen ini cuma ringkasan urutan fase.
- [ ] Compile ulang 5 kontrak di Remix, pastikan tidak ada error compiler —
      lakukan ini SEKARANG, bukan tunggu hari-H, supaya ada waktu perbaiki
      kalau ada masalah.
- [ ] Setup wallet deployer: pastikan `0x86435cad0B9a46A67fD0756BdA7cFa992417ef1f`
      terisi USDC asli yang cukup untuk gas 5 transaksi deploy + beberapa
      transaksi setup admin. Simpan private key di hardware wallet
      (Ledger/Trezor) kalau belum, bukan hanya di MetaMask browser biasa —
      wallet ini sekarang jadi satu-satunya kunci untuk semua kontrak.
- [x] **Dikonfirmasi:** `owner` dan `treasury` untuk semua kontrak = wallet
      personal `0x86435cad0B9a46A67fD0756BdA7cFa992417ef1f`.

      ⚠️ **Konsekuensi teknis yang wajib diperhatikan:** `ArcenticMultiPool.sol`
      TIDAK punya fungsi `transferOwnership()` — owner-nya otomatis jadi wallet
      yang literally menandatangani transaksi deploy di Remix. Ini berarti
      akun MetaMask yang aktif di Remix saat klik Deploy **harus** persis
      `0x86435cad...` itu sendiri, bukan wallet lain — cek ulang di panel
      "Deploy & Run Transactions" sebelum tiap klik Deploy (lihat
      `REMIX_DEPLOYMENT_GUIDE.md` bagian atas untuk detail).

      Risiko yang perlu kamu sadari sebelum lanjut: private key wallet ini
      sekarang jadi satu-satunya kunci untuk SEMUA kontrak (deploy + owner +
      treasury). Simpan di hardware wallet (Ledger/Trezor), bukan hanya di
      MetaMask browser biasa, karena kebocoran key ini = kontrol penuh atas
      seluruh sistem, tanpa recovery.

## Fase 1 — Begitu Arc rilis info mainnet (dekat 16 September)

- [ ] Cek `docs.arc.io/arc/references/connect-to-arc` untuk RPC URL & chain ID
      mainnet resmi — tambahkan sebagai custom network baru di MetaMask.
- [ ] Cek `docs.arc.io/arc/references/contract-addresses` untuk alamat **USDC
      mainnet** resmi — catat, dipakai sebagai constructor arg di Langkah 3
      `REMIX_DEPLOYMENT_GUIDE.md`.
- [ ] **[Perlu keputusan]** cirBTC dan USDT di proyekmu — cek apakah itu token
      test buatan sendiri (kalau ya, kamu perlu deploy ulang kontrak token
      itu juga ke mainnet lewat Remix, sebelum Langkah 3) atau token pihak
      ketiga yang sudah ada.
- [ ] EURC mainnet: cek alamat resmi Circle di dokumentasi yang sama.

## Fase 2 — Dry run (sangat disarankan sebelum deploy sungguhan)

- [ ] Kalau memungkinkan, test dulu urutan deploy + constructor args yang
      sama di **testnet** (bukan mainnet) sebagai gladi bersih — pastikan
      tidak ada typo alamat atau parameter yang kebalik urutannya.
- [ ] Cek saldo USDC asli di wallet `0x86435cad...` cukup untuk gas semua
      transaksi deploy + setup admin.
- [ ] **Sebelum klik Deploy pertama kali**, cek ulang di Remix bagian
      "Deploy & Run Transactions" → Account yang aktif benar-benar
      `0x86435cad...`, bukan wallet lain yang kebetulan aktif di MetaMask.

## Fase 3 — Deploy sungguhan

- [ ] Ikuti `REMIX_DEPLOYMENT_GUIDE.md` langkah 1–5 secara berurutan.
- [ ] Simpan SEMUA alamat hasil deploy — masukkan ke `network-config.js`
      bagian `mainnet: { contracts: {...} }`.
- [ ] Verify tiap kontrak di block explorer mainnet lewat plugin
      "Contract Verification" di Remix (butuh API key explorer mainnet,
      cek dokumentasi Arc begitu block explorer mainnet resmi rilis).

## Fase 4 — Setup admin pasca-deploy (kontrak BELUM siap dipakai tanpa ini)

Kontrak yang baru di-deploy itu kosong — tidak ada token yang di-whitelist,
tidak ada tier staking, tidak ada reward pool terisi. User tidak bisa staking
apa pun sampai langkah ini selesai.

- [ ] **[Keputusan bisnis — saya tidak tahu angka yang kamu mau]** Tentukan
      tier staking: berapa `lockDuration` (dalam detik) dan `aprBps` (basis
      poin, 100 = 1%) untuk tiap tier di `ArcenticStaking` dan `ArcenticVault`.
      Kalau kamu kasih tahu angka yang dipakai di testnet sekarang, saya bisa
      bantu tulis batch script `addToken()` + `addTier()`-nya.
- [ ] Panggil `staking.addToken(<alamat token>)` untuk setiap token yang mau
      didukung, lalu `staking.addTier(...)` untuk tier-nya.
- [ ] Panggil `vault.addToken(...)` + `vault.addTier(...)` — ini KONTRAK
      TERPISAH dari staking, whitelist-nya tidak otomatis ikut sama.
- [ ] Fund reward pool: kontrak staking/vault butuh token reward ditransfer
      masuk sebelum ada yang bisa klaim reward. Cek fungsi `fundRewards()`
      (kalau ada) atau transfer langsung, sesuaikan dengan pola di kontrak.
- [ ] **[Perhatian keamanan, bukan asumsi — saya baca langsung dari kode]**
      `ArcenticLendingBorrowing.sol` punya `cirBTCPriceUSDC = 65000 * 1e6`
      HARDCODED di constructor level, TIDAK baca dari oracle harga live.
      Kalau harga cirBTC riil sudah jauh beda dari $65,000 saat mainnet live,
      ini bisa dieksploitasi (user pinjam/agunkan dengan harga yang salah).
      Putuskan: update manual harganya sebelum go-live, atau tambah oracle
      (Chainlink dsb, Arc docs menyebut ada kategori "Oracles" di
      `docs.arc.io/arc/tools/oracles`) sebelum mainnet — ini keputusan yang
      sebaiknya diambil sebelum uang sungguhan masuk, bukan setelah.

## Fase 5 — Update frontend

- [ ] Isi `network-config.js` bagian `mainnet` dengan semua alamat dari Fase 3.
- [ ] Ganti `ARC_NETWORK = 'testnet'` jadi `'mainnet'` di `network-config.js`.
- [ ] Deploy ke Vercel, cek `build.js` jalan benar (network-config.js ikut ter-hash).
- [ ] Test end-to-end di mainnet dengan jumlah KECIL dulu (staking, unstake,
      lending) sebelum umumkan ke publik.
'@
[System.IO.File]::WriteAllText("D:\ARCENTIC\DEPLOYMENT_CHECKLIST.md", $checklistContent, [System.Text.Encoding]::UTF8)

$guideContent = @'
# Panduan Deploy ARCENTIC ke Arc Mainnet — Remix IDE

Ini versi Remix dari rencana deploy sebelumnya. Urutan dan constructor args
sama persis, cuma cara eksekusinya lewat UI Remix, bukan `forge script`.

**Status per 15 Agustus 2026:** alamat mainnet belum dirilis Arc. Panduan ini
untuk dipakai begitu Arc rilis chain ID + RPC + alamat token mainnet resmi.

---

## Sebelum mulai — WAJIB dibaca

**Wallet MetaMask yang aktif di Remix saat deploy `ArcenticMultiPool` dan
`ARCENTIC.sol` (CENTIC token) HARUS wallet `0x86435cad0B9a46A67fD0756BdA7cFa992417ef1f`
itu sendiri.** [Pasti, saya baca langsung dari source code]. Dua kontrak ini
set `owner = msg.sender` otomatis saat deploy, dan `ArcenticMultiPool.sol`
**tidak punya fungsi transferOwnership()** — kalau salah akun MetaMask saat
klik Deploy, owner-nya salah selamanya, tidak bisa diperbaiki tanpa deploy
ulang seluruh pool + migrasi liquidity yang sudah masuk.

Sebelum deploy sungguhan: di MetaMask, cek pojok atas Remix "Deploy & Run
Transactions" tab → pastikan **Account** yang tertera adalah `0x86435cad...`,
bukan wallet lain yang mungkin kebetulan aktif di MetaMask kamu.

---

## Langkah 0 — Setup di Remix

1. Buka https://remix.ethereum.org
2. Upload/paste 5 file kontrak: `ARCENTIC.sol`, `ArcenticMultiPool.sol`,
   `ArcenticLendingBorrowing.sol`, `ArcenticStakingMultiToken.sol`,
   `ArcenticVault.sol` (dan `IERC20.sol` kalau ada import lokal ke situ).
3. Tab **Solidity Compiler** → compile semua, pastikan tidak ada error.
   (`ArcenticVault.sol` dan `ArcenticStakingMultiToken.sol` import
   `@openzeppelin/contracts@5.0.2/...` — Remix resolve ini otomatis lewat
   GitHub/npm, tidak perlu setup manual seperti di Foundry.)
4. Tab **Deploy & Run Transactions**:
   - Environment: **Injected Provider - MetaMask**
   - Pastikan MetaMask sudah connect ke **Arc Mainnet** (tambahkan network
     manual di MetaMask kalau belum ada — butuh chain ID + RPC URL resmi
     dari Arc, belum tersedia per sekarang)
   - Account: **cek dan pastikan** `0x86435cad...` (lihat peringatan di atas)

---

## Langkah 1 — Deploy `ArcenticMultiPool`

- Contract: `ArcenticMultiPool`
- Constructor args: **tidak ada** (kosong)
- Klik **Deploy**, konfirmasi di MetaMask
- **Catat alamat hasil deploy** — dibutuhkan di Langkah 5

## Langkah 2 — Deploy `ARCENTIC` (token CENTIC)

- Contract: `ARCENTIC`
- Constructor args: **tidak ada** (kosong — cek ulang di kode kalau ada
  parameter, tapi berdasarkan yang saya baca, constructor cuma mint ke
  `msg.sender` tanpa parameter)
- Klik **Deploy**
- **Catat alamat hasil deploy**

## Langkah 3 — Deploy `LendingBorrowing`

- Contract: `LendingBorrowing` (dari file `ArcenticLendingBorrowing.sol`)
- Constructor args (isi di field sebelum klik Deploy):
  - `_cirBTC` : alamat cirBTC mainnet (isi setelah kamu putuskan — lihat
    pertanyaan terbuka di bawah)
  - `_usdc` : alamat USDC mainnet resmi dari Arc
- Klik **Deploy**
- **Catat alamat hasil deploy**

> ⚠️ **Perhatian keamanan yang sudah saya temukan sebelumnya, masih berlaku:**
> kontrak ini punya `cirBTCPriceUSDC = 65000 * 1e6` **hardcoded**, tidak baca
> harga live dari oracle. Putuskan sebelum deploy: update manual harganya
> supaya sesuai harga real saat mainnet live, atau tunda deploy kontrak ini
> sampai oracle terpasang.

## Langkah 4 — Deploy `ArcenticStakingMultiToken`

- Contract: `ArcenticStakingMultiToken`
- Constructor args:
  - `_owner` : `0x86435cad0B9a46A67fD0756BdA7cFa992417ef1f`
- Klik **Deploy**
- **Catat alamat hasil deploy**
- (treasury otomatis = owner di dalam kontrak ini, tidak perlu isi terpisah)

## Langkah 5 — Deploy `ArcenticVault`

- Contract: `ArcenticVault`
- Constructor args:
  - `_owner` : `0x86435cad0B9a46A67fD0756BdA7cFa992417ef1f`
  - `_treasury` : `0x86435cad0B9a46A67fD0756BdA7cFa992417ef1f`
  - `_pool` : alamat `ArcenticMultiPool` dari **Langkah 1**
- Klik **Deploy**
- **Catat alamat hasil deploy**

---

## Langkah 6 — Setup admin pasca-deploy (WAJIB, kontrak belum siap dipakai)

Di tab **Deploy & Run Transactions**, kontrak yang baru di-deploy muncul di
bagian bawah dengan tombol-tombol fungsi. Untuk tiap kontrak yang punya
whitelist token (`ArcenticStakingMultiToken`, `ArcenticVault`):

- [ ] `addToken(<alamat token>)` — untuk setiap token yang mau didukung
- [ ] `addTier(<token>, <lockDuration detik>, <aprBps>)` — **[Perlu jawabanmu]**
      isi angka yang sama dengan tier testnet sekarang, atau angka baru
- [ ] Fund reward pool — transfer token reward masuk ke kontrak (cek
      `fundRewards()` kalau ada, atau transfer ERC20 langsung ke alamat
      kontrak, tergantung pola masing-masing kontrak)

---

## Langkah 7 — Catat semua alamat ke `network-config.js`

Buka `network-config.js` di project VS Code kamu, isi bagian `mainnet:`:

```js
mainnet: {
    chainIdHex: '...',     // dari Arc
    chainIdDec: ...,       // dari Arc
    chainName: 'Arc Mainnet',
    rpcUrls: ['...'],      // dari Arc
    rpcUrlFallback: '...', // dari Arc
    blockExplorerUrls: ['...'], // dari Arc
    explorerUrl: '...',
    cctp: {
        domain: ...,        // cek apakah masih 26 di mainnet
        usdc: '...',        // dari Arc
        tokenMessenger: '...',
        messageTransmitter: '...'
    },
    attestationApi: '...', // endpoint PRODUCTION Iris, bukan -sandbox
    contracts: {
        ArcenticMultiPool : '<dari Langkah 1>',
        CENTIC            : '<dari Langkah 2>',
        USDC              : '<alamat USDC mainnet>',
        EURC              : '<alamat EURC mainnet>',
        USDT              : '<lihat pertanyaan terbuka>',
        cirBTC            : '<lihat pertanyaan terbuka>',
        LendingBorrowing  : '<dari Langkah 3>',
        ArcenticStaking   : '<dari Langkah 4>',
        ArcenticVault     : '<dari Langkah 5>'
    }
}
```

Lalu ganti `const ARC_NETWORK = 'testnet';` jadi `'mainnet'`.

---

## Pertanyaan terbuka yang masih perlu jawabanmu

1. **cirBTC dan USDT** — token buatan sendiri (perlu deploy ulang kontraknya
   juga, kasih source code-nya) atau token pihak ketiga yang sudah ada di
   mainnet?
2. **Angka tier staking** yang dipakai sekarang di testnet (lock duration +
   APR per tier) — supaya saya bisa tulis daftar `addTier()` yang tinggal
   copy-paste ke Remix.
'@
[System.IO.File]::WriteAllText("D:\ARCENTIC\REMIX_DEPLOYMENT_GUIDE.md", $guideContent, [System.Text.Encoding]::UTF8)

Write-Host "Kedua file berhasil dibuat di D:\ARCENTIC"
