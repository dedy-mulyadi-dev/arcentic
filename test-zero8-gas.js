/* ══════════════════════════════════════════════════════════════════════════
   test-zero8-gas.js
   ----------------------------------------------------------------------------
   Tujuan: catat gas usage AKTUAL untuk swap() dan liquidate() di Arc Testnet
   pasca-Zero8 (v0.8.0), sebagai baseline sebelum mainnet 16 Sept.

   TIDAK menguji emergencyWithdraw() secara sengaja — kontrak MultiPool yang
   dideploy sekarang punya bug: emergencyWithdraw() tidak mengurangi
   reserves[_token] setelah transfer, jadi memanggilnya akan merusak state
   reserves testnet-mu sendiri dan bikin hasil swap test tidak representatif.
   Perbaiki bug itu dulu (tambahkan `reserves[_token] -= _amount;`) sebelum
   menguji fungsi ini.

   CARA PAKAI:
   1. npm install ethers dotenv --save
   2. Buat file .env di folder yang sama:
        TESTNET_PRIVATE_KEY=0x...   (wallet testnet, JANGAN wallet mainnet)
        TESTNET_RPC_URL=https://rpc.testnet.arc.network
   3. node test-zero8-gas.js
   ══════════════════════════════════════════════════════════════════════════ */
require('dotenv').config();
const { ethers } = require('ethers');

// ── Konfigurasi dari network-config.js kamu ────────────────────────────────
const RPC_URL = process.env.TESTNET_RPC_URL || 'https://rpc.testnet.arc.network';
const RPC_FALLBACK = 'https://arc-testnet.drpc.org';
const CHAIN_ID = 5042002; // 0x4CEF52

const ADDR = {
    MultiPool: '0x628a1D28cd6415e221ded959f3965d033a882516',
    LendingBorrowing: '0xdE6190BBb66edc13c2Ab58AEa2Fd9c2323a606DB',
    USDC: '0x3600000000000000000000000000000000000000',
    USDT: '0x175CdB1D338945f0D851A741ccF787D343E57952',
    cirBTC: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF'
};

// ── ABI minimal — cukup fungsi yang kita uji, langsung dari source .sol ────
const MULTIPOOL_ABI = [
    'function swap(address _tokenIn, address _tokenOut, uint256 _amountIn, uint256 _minAmountOut) external returns (uint256 amountOut)',
    'function reserves(address) view returns (uint256)',
    'function owner() view returns (address)'
];

const LENDING_ABI = [
    'function liquidate(address borrower, uint256 repayAmount) external',
    'function isLiquidatable(address borrower) view returns (bool)',
    'function collateralValueOf(address borrower) view returns (uint256)',
    'function loans(address) view returns (uint256 amount, uint256 collateral, bool isActive)',
    'function cirBTCPriceUSDC() view returns (uint256)'
];

const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function decimals() view returns (uint8)'
];

async function getProvider() {
    try {
        const p = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
        await p.getBlockNumber();
        return p;
    } catch (e) {
        console.warn(`RPC utama gagal (${RPC_URL}), coba fallback...`);
        return new ethers.JsonRpcProvider(RPC_FALLBACK, CHAIN_ID);
    }
}

async function main() {
    if (!process.env.TESTNET_PRIVATE_KEY) {
        throw new Error('TESTNET_PRIVATE_KEY belum diset di .env. JANGAN pernah commit file .env ke git.');
    }

    const provider = await getProvider();
    const wallet = new ethers.Wallet(process.env.TESTNET_PRIVATE_KEY, provider);

    const network = await provider.getNetwork();
    console.log(`Terhubung ke chain ID ${network.chainId} via ${provider._getConnection().url}`);
    if (Number(network.chainId) !== CHAIN_ID) {
        throw new Error(`Chain ID tidak cocok! Expect ${CHAIN_ID}, dapat ${network.chainId}. Cek RPC.`);
    }

    const block = await provider.getBlock('latest');
    console.log(`Block terbaru: #${block.number}, timestamp ${new Date(block.timestamp * 1000).toISOString()}\n`);

    const multiPool = new ethers.Contract(ADDR.MultiPool, MULTIPOOL_ABI, wallet);
    const lending = new ethers.Contract(ADDR.LendingBorrowing, LENDING_ABI, wallet);
    const usdc = new ethers.Contract(ADDR.USDC, ERC20_ABI, wallet);
    const usdt = new ethers.Contract(ADDR.USDT, ERC20_ABI, wallet);
    const cirBTC = new ethers.Contract(ADDR.cirBTC, ERC20_ABI, wallet);

    const results = { timestamp: new Date().toISOString(), block: block.number, tests: {} };

    // ── TEST 1: swap() — USDC -> USDT, jumlah kecil ────────────────────────
    // Desimal diambil langsung on-chain, bukan ditebak — token berbeda bisa
    // punya desimal berbeda (mis. USDC Arc = 6, belum tentu USDT sama).
    console.log('── TEST 1: swap() ──');
    try {
        const TOKEN_IN_DECIMALS = await usdc.decimals();
        const TOKEN_OUT_DECIMALS = await usdt.decimals();
        console.log(`Desimal USDC on-chain: ${TOKEN_IN_DECIMALS}, Desimal USDT on-chain: ${TOKEN_OUT_DECIMALS}`);

        const amountIn = ethers.parseUnits('1', TOKEN_IN_DECIMALS);
        const reserveIn = await multiPool.reserves(ADDR.USDC);
        const reserveOut = await multiPool.reserves(ADDR.USDT);
        console.log(`Reserve USDC: ${ethers.formatUnits(reserveIn, TOKEN_IN_DECIMALS)}, Reserve USDT: ${ethers.formatUnits(reserveOut, TOKEN_OUT_DECIMALS)}`);

        const walletBalance = await usdc.balanceOf(wallet.address);
        console.log(`Saldo USDC wallet: ${ethers.formatUnits(walletBalance, TOKEN_IN_DECIMALS)}`);
        if (walletBalance < amountIn) {
            throw new Error(`Saldo wallet (${ethers.formatUnits(walletBalance, TOKEN_IN_DECIMALS)} USDC) kurang dari amountIn (${ethers.formatUnits(amountIn, TOKEN_IN_DECIMALS)} USDC). Cek faucet atau kurangi amountIn.`);
        }

        if (reserveIn === 0n || reserveOut === 0n) {
            console.warn('Reserve salah satu token = 0, swap akan revert ("Pool liquidity insufficient"). Skip.');
            results.tests.swap = { skipped: true, reason: 'insufficient pool liquidity' };
        } else {
            // Hitung minAmountOut on-chain-equivalent lalu kasih toleransi 1%
            const expectedOut = (amountIn * reserveOut) / (reserveIn + amountIn);
            const minAmountOut = (expectedOut * 99n) / 100n;

            const allowance = await usdc.allowance(wallet.address, ADDR.MultiPool);
            if (allowance < amountIn) {
                console.log('Approve USDC ke MultiPool...');
                const approveTx = await usdc.approve(ADDR.MultiPool, amountIn);
                await approveTx.wait();
            }

            const tx = await multiPool.swap(ADDR.USDC, ADDR.USDT, amountIn, minAmountOut);
            const receipt = await tx.wait();
            console.log(`swap() sukses. Gas used: ${receipt.gasUsed.toString()}, tx: ${receipt.hash}`);
            results.tests.swap = {
                success: true,
                gasUsed: receipt.gasUsed.toString(),
                txHash: receipt.hash,
                expectedOut: expectedOut.toString(),
                minAmountOut: minAmountOut.toString()
            };
        }
    } catch (err) {
        console.error(`swap() gagal: ${err.reason || err.message}`);
        results.tests.swap = { success: false, error: err.reason || err.message, rawError: err.info?.error?.message };
    }

    // ── TEST 2: isLiquidatable() + liquidate() (read-only check dulu) ──────
    console.log('\n── TEST 2: liquidate() ──');
    try {
        // Ganti dengan alamat borrower yang benar-benar under-water di testnet-mu.
        // Tanpa alamat borrower yang valid, test ini hanya memverifikasi bahwa
        // isLiquidatable() bisa dipanggil tanpa error RPC baru dari Zero8.
        const testBorrower = process.env.TEST_BORROWER_ADDRESS;
        if (!testBorrower) {
            console.warn('TEST_BORROWER_ADDRESS tidak diset di .env — skip liquidate(), hanya cek isLiquidatable() dummy call.');
            const dummyCheck = await lending.isLiquidatable(wallet.address);
            console.log(`isLiquidatable(self) = ${dummyCheck} (diharapkan false, cuma tes RPC call jalan normal)`);
            results.tests.liquidate = { skipped: true, reason: 'no TEST_BORROWER_ADDRESS set' };
        } else {
            const liquidatable = await lending.isLiquidatable(testBorrower);
            console.log(`isLiquidatable(${testBorrower}) = ${liquidatable}`);

            if (!liquidatable) {
                console.warn('Posisi ini belum liquidatable. Tidak bisa test liquidate() tanpa reverts.');
                results.tests.liquidate = { skipped: true, reason: 'position not liquidatable', address: testBorrower };
            } else {
                const loan = await lending.loans(testBorrower);
                const repayAmount = loan.amount / 10n; // repay 10% dulu, jangan langsung full
                console.log(`Loan amount: ${ethers.formatUnits(loan.amount, 6)} USDC. Repay test: ${ethers.formatUnits(repayAmount, 6)} USDC`);

                const allowance = await usdc.allowance(wallet.address, ADDR.LendingBorrowing);
                if (allowance < repayAmount) {
                    const approveTx = await usdc.approve(ADDR.LendingBorrowing, repayAmount);
                    await approveTx.wait();
                }

                const tx = await lending.liquidate(testBorrower, repayAmount);
                const receipt = await tx.wait();
                console.log(`liquidate() sukses. Gas used: ${receipt.gasUsed.toString()}, tx: ${receipt.hash}`);
                results.tests.liquidate = {
                    success: true,
                    gasUsed: receipt.gasUsed.toString(),
                    txHash: receipt.hash,
                    repayAmount: repayAmount.toString()
                };
            }
        }
    } catch (err) {
        console.error(`liquidate() gagal: ${err.reason || err.message}`);
        results.tests.liquidate = { success: false, error: err.reason || err.message, rawError: err.info?.error?.message };
    }

    // ── Ringkasan ────────────────────────────────────────────────────────
    console.log('\n══ RINGKASAN ══');
    console.log(JSON.stringify(results, null, 2));
    console.log('\nCatatan: emergencyWithdraw() sengaja TIDAK diuji — lihat komentar di atas file ini.');
}

main().catch((err) => {
    console.error('Script gagal:', err);
    process.exit(1);
});
