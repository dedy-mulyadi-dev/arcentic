/* ══════════════════════════════════════════════════════════════════════════
   add-usdc-liquidity.js
   ----------------------------------------------------------------------------
   Setor 35,000 USDC dari wallet Account 16 ke MultiPool BARU. Ini USDC yang
   ditarik manual dari pool LAMA lewat Remix (sebelum migrate-liquidity.js
   ada), yang sempat tertinggal di wallet dan belum pernah disetor lagi.

   CARA PAKAI: butuh OWNER_PRIVATE_KEY di .env (private key Account 16) —
   sama seperti waktu migrate-liquidity.js. Kalau sudah dihapus, tambahkan
   lagi sementara, HAPUS LAGI setelah selesai.
   ══════════════════════════════════════════════════════════════════════════ */
require('dotenv').config();
const { ethers } = require('ethers');

const RPC_URL = process.env.TESTNET_RPC_URL || 'https://rpc.testnet.arc.io';
const CHAIN_ID = 5042002;
const NEW_POOL = '0x4d3f5801304E13d243ec898Bb129d96eC7B1b2d9';
const USDC = '0x3600000000000000000000000000000000000000';

const POOL_ABI = ['function addLiquidity(address _token, uint256 _amount) external'];
const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function decimals() view returns (uint8)'
];

async function main() {
    if (!process.env.OWNER_PRIVATE_KEY) {
        throw new Error('OWNER_PRIVATE_KEY belum diset di .env (private key Account 16).');
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
    const wallet = new ethers.Wallet(process.env.OWNER_PRIVATE_KEY, provider);
    console.log(`Wallet: ${wallet.address}`);

    const usdc = new ethers.Contract(USDC, ERC20_ABI, wallet);
    const pool = new ethers.Contract(NEW_POOL, POOL_ABI, wallet);
    const decimals = await usdc.decimals();

    const balance = await usdc.balanceOf(wallet.address);
    console.log(`Saldo USDC wallet saat ini: ${ethers.formatUnits(balance, decimals)}`);

    const amount = ethers.parseUnits('35000', decimals);
    if (balance < amount) {
        throw new Error(`Saldo (${ethers.formatUnits(balance, decimals)}) kurang dari 35000 USDC yang mau disetor.`);
    }

    const allowance = await usdc.allowance(wallet.address, NEW_POOL);
    if (allowance < amount) {
        console.log('Approve USDC ke pool baru...');
        const approveTx = await usdc.approve(NEW_POOL, amount);
        await approveTx.wait();
    }

    console.log('Menyetor 35,000 USDC ke pool baru...');
    const tx = await pool.addLiquidity(USDC, amount);
    const receipt = await tx.wait();
    console.log(`Sukses. Gas used: ${receipt.gasUsed.toString()}, tx: ${receipt.hash}`);

    console.log('\n⚠️  INGAT: hapus baris OWNER_PRIVATE_KEY dari .env sekarang juga.');
}

main().catch((err) => {
    console.error('Script gagal:', err.reason || err.message);
    process.exit(1);
});
