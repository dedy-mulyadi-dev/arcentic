/* ══════════════════════════════════════════════════════════════════════════
   migrate-liquidity.js
   ----------------------------------------------------------------------------
   Tujuan: pindahkan LP position (USDC + USDT) dari MultiPool LAMA
   (0x4d3f5801... — versi fix desimal, tapi masih punya bug lpBalance/
   emergencyWithdraw) ke MultiPool BARU (0xe7705306... — sudah dipatch:
   removeLiquidity partial-withdraw + emergencyWithdraw accounting fix,
   owner di-set LANGSUNG ke Safe ARCENIS saat deploy, tidak perlu
   transferOwnership/acceptOwnership lagi) tanpa perlu klak-klik form di Remix.

   Alur per token:
     1. Baca lpBalance(wallet, token) di kontrak LAMA
     2. removeLiquidity(token, amount) di kontrak LAMA
     3. approve(kontrakBaru, amount) di token
     4. addLiquidity(token, amount) di kontrak BARU

   CARA PAKAI:
   1. Di .env, tambahkan baris (JANGAN pakai TESTNET_PRIVATE_KEY yang lama —
      itu wallet disposable, tidak punya LP position apapun di pool ini):

        OWNER_PRIVATE_KEY=0x...   (private key Account 16)
        TESTNET_RPC_URL=https://rpc.testnet.arc.network

   2. node migrate-liquidity.js

   3. PENTING: setelah selesai, HAPUS baris OWNER_PRIVATE_KEY dari .env.
      Jangan biarkan key ini menumpuk di file lokal lebih lama dari
      yang perlu.
   ══════════════════════════════════════════════════════════════════════════ */
require('dotenv').config();
const { ethers } = require('ethers');

const RPC_URL = process.env.TESTNET_RPC_URL || 'https://rpc.testnet.arc.network';
const RPC_FALLBACK = 'https://arc-testnet.drpc.org';
const CHAIN_ID = 5042002;

const OLD_POOL = '0x4d3f5801304E13d243ec898Bb129d96eC7B1b2d9';
const NEW_POOL = '0xe77053064D513ca55b702c9717F1570Cbab894b6';

const TOKENS = {
    USDC: '0x3600000000000000000000000000000000000000',
    USDT: '0x175CdB1D338945f0D851A741ccF787D343E57952'
};

const POOL_ABI = [
    'function lpBalance(address, address) view returns (uint256)',
    'function removeLiquidity(address _token, uint256 _amount) external',
    'function addLiquidity(address _token, uint256 _amount) external',
    'function reserves(address) view returns (uint256)'
];

const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)'
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

async function migrateToken(symbol, tokenAddress, wallet, oldPool, newPool) {
    console.log(`\n── Migrasi ${symbol} ──`);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    const decimals = await token.decimals();

    const lpAmount = await oldPool.lpBalance(wallet.address, tokenAddress);
    const currentReserve = await oldPool.reserves(tokenAddress);
    console.log(`LP balance tercatat: ${ethers.formatUnits(lpAmount, decimals)} ${symbol} (raw: ${lpAmount.toString()})`);
    console.log(`Reserve aktual di pool: ${ethers.formatUnits(currentReserve, decimals)} ${symbol} (raw: ${currentReserve.toString()})`);

    if (lpAmount === 0n) {
        console.log(`Tidak ada LP position untuk ${symbol} di pool lama. Skip.`);
        return { symbol, skipped: true };
    }

    // Reserve bisa lebih kecil dari lpBalance kalau reserve token ini pernah
    // terkuras oleh swap() — lpBalance tidak otomatis ikut disesuaikan turun.
    // Tarik yang benar-benar tersedia, bukan lpBalance penuh, supaya tidak revert.
    const amountToWithdraw = lpAmount < currentReserve ? lpAmount : currentReserve;
    if (amountToWithdraw < lpAmount) {
        console.warn(
            `⚠️  Reserve (${ethers.formatUnits(currentReserve, decimals)}) lebih kecil dari ` +
            `LP balance tercatat (${ethers.formatUnits(lpAmount, decimals)}). Ini kekurangan ` +
            `struktural — sisa ${ethers.formatUnits(lpAmount - currentReserve, decimals)} ${symbol} ` +
            `tidak bisa ditarik sampai ada LP lain menyetor token ini lagi, atau sampai bug ini ` +
            `diperbaiki di desain kontrak. Menarik yang tersedia saja: ${ethers.formatUnits(amountToWithdraw, decimals)}.`
        );
    }

    // 1. removeLiquidity dari pool lama
    console.log(`Menarik ${symbol} dari pool lama...`);
    const removeTx = await oldPool.removeLiquidity(tokenAddress, amountToWithdraw);
    const removeReceipt = await removeTx.wait();
    console.log(`removeLiquidity sukses. Gas used: ${removeReceipt.gasUsed.toString()}, tx: ${removeReceipt.hash}`);

    // 2. approve ke pool baru
    const currentAllowance = await token.allowance(wallet.address, await newPool.getAddress());
    if (currentAllowance < amountToWithdraw) {
        console.log(`Approve ${symbol} ke pool baru...`);
        const approveTx = await token.approve(await newPool.getAddress(), amountToWithdraw);
        await approveTx.wait();
    }

    // 3. addLiquidity ke pool baru
    console.log(`Menyetor ${symbol} ke pool baru...`);
    const addTx = await newPool.addLiquidity(tokenAddress, amountToWithdraw);
    const addReceipt = await addTx.wait();
    console.log(`addLiquidity sukses. Gas used: ${addReceipt.gasUsed.toString()}, tx: ${addReceipt.hash}`);

    return {
        symbol,
        amountMigrated: ethers.formatUnits(amountToWithdraw, decimals),
        shortfall: amountToWithdraw < lpAmount ? ethers.formatUnits(lpAmount - amountToWithdraw, decimals) : '0',
        removeTxHash: removeReceipt.hash,
        addTxHash: addReceipt.hash
    };
}

async function main() {
    if (!process.env.OWNER_PRIVATE_KEY) {
        throw new Error(
            'OWNER_PRIVATE_KEY belum diset di .env. Ini HARUS private key Account 16 ' +
            '(yang punya LP position di pool lama) — bukan wallet disposable yang dipakai ' +
            'untuk test-zero8-gas.js sebelumnya.'
        );
    }

    const provider = await getProvider();
    const wallet = new ethers.Wallet(process.env.OWNER_PRIVATE_KEY, provider);

    const network = await provider.getNetwork();
    console.log(`Wallet: ${wallet.address}`);
    console.log(`Chain ID: ${network.chainId}`);
    if (Number(network.chainId) !== CHAIN_ID) {
        throw new Error(`Chain ID tidak cocok! Expect ${CHAIN_ID}, dapat ${network.chainId}.`);
    }

    const oldPool = new ethers.Contract(OLD_POOL, POOL_ABI, wallet);
    const newPool = new ethers.Contract(NEW_POOL, POOL_ABI, wallet);

    const results = [];
    for (const [symbol, address] of Object.entries(TOKENS)) {
        try {
            const result = await migrateToken(symbol, address, wallet, oldPool, newPool);
            results.push(result);
        } catch (err) {
            console.error(`Migrasi ${symbol} GAGAL: ${err.reason || err.message}`);
            results.push({ symbol, failed: true, error: err.reason || err.message });
        }
    }

    console.log('\n══ RINGKASAN MIGRASI ══');
    console.log(JSON.stringify(results, null, 2));

    console.log('\n⚠️  INGAT: hapus baris OWNER_PRIVATE_KEY dari .env sekarang juga.');
}

main().catch((err) => {
    console.error('Script gagal:', err);
    process.exit(1);
});
