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
