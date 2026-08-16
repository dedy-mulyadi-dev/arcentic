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
      yang literally menandatangani transaksi deploy. Ini berarti `PRIVATE_KEY`
      di `.env.mainnet` **harus** private key dari wallet `0x86435cad...` itu
      sendiri, bukan wallet deployer terpisah. Script `DeployMainnet.s.sol`
      sekarang `require()` mengecek ini otomatis dan akan berhenti (revert)
      kalau wallet yang dipakai deploy tidak cocok — jadi kalau dry run
      gagal di sini, itu bukan bug script, itu memang pengaman yang disengaja.

      Risiko yang perlu kamu sadari sebelum lanjut: private key wallet ini
      sekarang jadi satu-satunya kunci untuk SEMUA kontrak (deploy + owner +
      treasury). Simpan di hardware wallet (Ledger/Trezor), bukan file teks
      atau plain env var di laptop, karena kebocoran key ini = kontrol penuh
      atas seluruh sistem, tanpa recovery.

## Fase 1 — Begitu Arc rilis info mainnet (dekat 16 September)

- [ ] Cek `docs.arc.io/arc/references/connect-to-arc` untuk RPC URL & chain ID
      mainnet resmi. Isi ke `.env.mainnet`.
- [ ] Cek `docs.arc.io/arc/references/contract-addresses` untuk alamat **USDC
      mainnet** resmi. Isi `MAINNET_USDC`.
- [ ] **[Perlu keputusan]** cirBTC dan USDT di proyekmu — cek apakah itu token
      test buatan sendiri (kalau ya, kamu perlu deploy ulang kontrak token
      itu juga ke mainnet, saya tidak punya source code-nya untuk dibantu)
      atau token pihak ketiga yang sudah ada. Kalau kontrak sendiri, tambahkan
      deploy step-nya ke `DeployMainnet.s.sol` SEBELUM `LendingBorrowing`
      (karena `LendingBorrowing` butuh alamat cirBTC valid di constructor).
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
