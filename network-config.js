/* ══════════════════════════════════════════════════════════════════════════
   network-config.js — Satu sumber kebenaran untuk chain ID & alamat kontrak.
   ----------------------------------------------------------------------------
   KENAPA FILE INI ADA:
   Sebelumnya app.js dan vault.js masing-masing punya definisi chain ID dan
   alamat VAULT_ADDRESS sendiri-sendiri. Kalau salah satu diupdate untuk
   mainnet dan yang satunya lupa, Vault bisa nyambung ke network yang salah
   sementara bagian lain situs sudah pindah — bug yang baru ketahuan setelah
   user kehilangan transaksi. File ini menghapus kemungkinan itu: app.js dan
   vault.js SAMA-SAMA baca dari objek yang sama di sini.

   CARA GANTI KE MAINNET NANTI (begitu Arc rilis alamat resminya):
   1. Isi semua field kosong (null) di bawah CURRENT_NETWORK = 'mainnet'
   2. Ganti baris `const ARC_NETWORK = 'testnet';` di bawah jadi 'mainnet'
   3. Tidak perlu sentuh app.js atau vault.js sama sekali.

   Load file ini SEBELUM app.js dan vault.js di index.html:
     <script src="network-config.js" defer></script>
     <script src="app.js" defer></script>
     <script src="vault.js" defer></script>
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    // ── Ganti baris ini ke 'mainnet' saat migrasi ──────────────────────────
    const ARC_NETWORK = 'testnet';
    // ─────────────────────────────────────────────────────────────────────

    const NETWORKS = {
        testnet: {
            chainIdHex: '0x4CEF52',
            chainIdDec: 5042002,
            chainName: 'Arc Testnet',
            rpcUrls: [
                // RPC_PROXY_URL diisi runtime oleh app.js (origin-relative /api/rpc)
                // Migrasi 8 Okt 2026: arc.network -> arc.io (URL lama dihapus 15 Okt 2026,
                // lihat status.arc.io). Sumber URL: docs.arc.io/arc/references/rpc-endpoints
                'https://rpc.testnet.arc.io',
                'https://rpc.drpc.testnet.arc.io',
                'https://arc-testnet.drpc.org'
            ],
            rpcUrlFallback: 'https://rpc.drpc.testnet.arc.io',
            nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
            blockExplorerUrls: ['https://testnet.arcscan.app/'],
            explorerUrl: 'https://testnet.arcscan.app',

            cctp: {
                domain: 26,
                usdc: '0x3600000000000000000000000000000000000000',
                tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
                messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275'
            },

            // Circle Attestation API (Iris) — GANTI ke endpoint production Iris
            // saat mainnet (bukan lagi -sandbox), cek docs.arc.io / developers.circle.com
            attestationApi: 'https://iris-api-sandbox.circle.com/v2/messages',

            // ARCENTIC-LOCK:testnet-contracts — address kontrak testnet. Perubahan
            // di sini HARUS disengaja (redeploy ulang), tidak boleh berubah karena
            // salah edit AI. Update baseline lewat `npm run verify-lock -- --update`
            // hanya setelah kamu benar-benar yakin ini perubahan yang diinginkan.
            //
            // RIWAYAT:
            // - 5 Sep 2026: ArcenticMultiPool diganti dari
            //   0x628a1D28cd6415e221ded959f3965d033a882516 (bug kritis: swap()
            //   salah hitung harga untuk token dengan desimal berbeda, USDC 6
            //   desimal vs USDT 18 desimal) ke 0x4d3f5801304E13d243ec898Bb129d96eC7B1b2d9.
            //   Liquidity dimigrasi (967.71 dari 1000 USDT — sisa 32.29 USDT
            //   ketinggalan karena bug desain LP tracking terpisah).
            // - 11 Sep 2026: ArcenticMultiPool diganti lagi dari
            //   0x4d3f5801304E13d243ec898Bb129d96eC7B1b2d9 ke
            //   0xe77053064D513ca55b702c9717F1570Cbab894b6 — fix 2 bug:
            //   (1) removeLiquidity() sekarang partial-withdraw (min(amount,
            //   reserves tersedia)) alih-alih revert total saat reserves
            //   kurang dari lpBalance tercatat; (2) emergencyWithdraw()
            //   sekarang konsisten mengurangi reserves[_token] tercatat.
            //   Owner kontrak baru di-set LANGSUNG ke Safe ARCENIS
            //   (0xFe8f4adF85f842B9fd90bC46B75C712cE69A54B1) saat deploy —
            //   tidak lewat transferOwnership/acceptOwnership lagi. Liquidity
            //   dimigrasi penuh untuk USDC (35000), USDT hampir penuh
            //   (967.68 dari 967.71 — sisa 0.0276 USDT ketinggalan di
            //   kontrak lama, gejala langsung dari bug #1 yang baru saja
            //   difix).
            contracts: {
                ArcenticMultiPool : '0xe77053064D513ca55b702c9717F1570Cbab894b6',
                CENTIC            : '0xC55D995d096A5c0832c1ee6918C481f502DCBcB7',
                USDC              : '0x3600000000000000000000000000000000000000',
                EURC              : '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
                USDT              : '0x175CdB1D338945f0D851A741ccF787D343E57952',
                cirBTC            : '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
                LendingBorrowing  : '0xdE6190BBb66edc13c2Ab58AEa2Fd9c2323a606DB',
                ArcenticStaking   : '0x473d6b0a414d6E72Cc40A040dC38d9d0AC635D5d',
                ArcenticVault     : '0xf3b0798A5363eEDDd2aB5ED23A023621a4d63621'
            }
            // ARCENTIC-LOCK-END:testnet-contracts
        },

        // Isi semua field di bawah begitu Arc mengumumkan alamat mainnet resmi
        // (docs.arc.io/arc/references/contract-addresses — halaman itu sendiri
        // saat ini bilang "Mainnet addresses are not yet available").
        mainnet: {
            // ── Diisi 16 Sep 2026 dari docs.arc.io/arc/references/contract-addresses
            // dan /arc/references/rpc-endpoints (dicek langsung, bukan dari cache/pihak
            // ketiga). RPC dikonfirmasi TERBUKA tanpa kredensial via eth_blockNumber
            // (hasil: block 0x142b447 = 21,148,743), meski docs masih menyebut fase
            // "private mainnet" — jangan kaget kalau suatu saat butuh API key, cek lagi
            // docs.arc.io kalau RPC ini berhenti merespons.
            chainIdHex: '0x13B2',
            chainIdDec: 5042,
            chainName: 'Arc Mainnet',
            rpcUrls: [
                'https://rpc.mainnet.arc.io'
            ],
            rpcUrlFallback: 'https://rpc.mainnet.arc.io',
            nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
            blockExplorerUrls: ['https://explorer.arc.io/'],
            explorerUrl: 'https://explorer.arc.io',

            cctp: {
                domain: 26,
                usdc: '0x3600000000000000000000000000000000000000',
                tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
                messageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64'
            },

            // TODO: ganti dari -sandbox ke endpoint production Iris — belum
            // diverifikasi, JANGAN tebak, cek docs.arc.io / developers.circle.com dulu.
            attestationApi: null,

            contracts: {
                // Alamat resmi Circle — sudah pasti benar, sumber: docs.arc.io.
                USDC : '0x3600000000000000000000000000000000000000',
                EURC : '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',

                // TODO: isi setelah redeploy masing-masing kontrak milik ARCENTIC
                // sendiri ke mainnet. Constructor semua kontrak sudah menerima
                // address sebagai parameter (bukan hardcoded), jadi redeploy
                // tidak perlu ubah kode Solidity.
                // USDT & cirBTC: PUTUSKAN dulu — pakai token asli (kalau ada di
                // Arc mainnet) atau mock buatan sendiri yang di-redeploy ulang.
                ArcenticMultiPool : null,
                CENTIC            : null,
                USDT              : null,
                cirBTC            : null,
                LendingBorrowing  : null,
                ArcenticStaking   : null,
                ArcenticVault     : null
            }
        }
    };

    const active = NETWORKS[ARC_NETWORK];
    if (!active) {
        throw new Error(`network-config.js: ARC_NETWORK "${ARC_NETWORK}" tidak dikenal. Pakai 'testnet' atau 'mainnet'.`);
    }

    // Peringatan keras kalau mainnet dipilih tapi field-nya belum diisi —
    // supaya salah pilih config tidak lolos diam-diam ke production.
    if (ARC_NETWORK === 'mainnet' && !active.chainIdHex) {
        throw new Error(
            'network-config.js: ARC_NETWORK diset ke "mainnet" tapi field-fieldnya ' +
            'masih null/TODO. Isi dulu semua alamat & chain ID mainnet sebelum deploy production.'
        );
    }

    window.ARCENTIC_NETWORK = ARC_NETWORK;
    window.ARCENTIC_NETWORK_CONFIG = active;
})();
