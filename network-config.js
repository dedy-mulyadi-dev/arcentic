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
                'https://rpc.testnet.arc.network',
                'https://arc-testnet.drpc.org'
            ],
            rpcUrlFallback: 'https://rpc.testnet.arc.network',
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

            contracts: {
                ArcenticMultiPool : '0x1975f275E8b2F6974246e952a4636Cfc675d43cb',
                CENTIC            : '0xC55D995d096A5c0832c1ee6918C481f502DCBcB7',
                USDC              : '0x3600000000000000000000000000000000000000',
                EURC              : '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
                USDT              : '0x175CdB1D338945f0D851A741ccF787D343E57952',
                cirBTC            : '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
                LendingBorrowing  : '0x15e803e1Bac195896B15561337aA97cd0ffBcD58',
                ArcenticStaking   : '0x473d6b0a414d6E72Cc40A040dC38d9d0AC635D5d',
                ArcenticVault     : '0xf3b0798A5363eEDDd2aB5ED23A023621a4d63621'
            }
        },

        // Isi semua field di bawah begitu Arc mengumumkan alamat mainnet resmi
        // (docs.arc.io/arc/references/contract-addresses — halaman itu sendiri
        // saat ini bilang "Mainnet addresses are not yet available").
        mainnet: {
            chainIdHex: null,      // TODO: isi setelah Arc umumkan chain ID mainnet
            chainIdDec: null,
            chainName: 'Arc Mainnet',
            rpcUrls: [],           // TODO
            rpcUrlFallback: null,  // TODO
            nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
            blockExplorerUrls: [], // TODO: block explorer mainnet (kemungkinan besar bukan testnet.arcscan.app)
            explorerUrl: null,

            cctp: {
                domain: null,      // TODO: cek apakah domain CCTP 26 tetap sama di mainnet
                usdc: null,
                tokenMessenger: null,
                messageTransmitter: null
            },

            attestationApi: null,  // TODO: ganti dari -sandbox ke endpoint production Iris

            contracts: {
                // TODO: isi setelah redeploy masing-masing kontrak ke mainnet.
                // Constructor semua kontrak ARCENTIC sudah menerima address
                // sebagai parameter (bukan hardcoded), jadi redeploy tidak
                // perlu ubah kode Solidity — cukup jalankan deployment script
                // dengan constructor args yang sesuai environment mainnet.
                ArcenticMultiPool : null,
                CENTIC            : null,
                USDC              : null,
                EURC              : null,
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
