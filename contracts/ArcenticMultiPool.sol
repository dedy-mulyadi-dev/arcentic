// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts@5.0.2/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts@5.0.2/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts@5.0.2/access/Ownable2Step.sol";

/// @notice CATATAN PATCH (baca sebelum deploy mainnet):
/// 1. Ownership sekarang pakai OpenZeppelin Ownable2Step (sama seperti
///    ArcenticStakingMultiToken), BUKAN address public + modifier manual.
///    `owner` lama diganti dengan `owner()` bawaan OZ — nama fungsi getter-nya
///    SAMA (owner()), jadi kompatibel kalau frontend kamu sudah manggil
///    `contract.owner()`. Yang beda: transfer ownership sekarang 2 langkah:
///      a) owner lama panggil transferOwnership(newOwner)
///      b) newOwner WAJIB panggil acceptOwnership() dari wallet-nya sendiri
///    Ini sengaja — mencegah salah ketik alamat owner baru dan kehilangan
///    kontrol kontrak selamanya (yang bisa terjadi di transferOwnership()
///    versi satu-langkah).
/// 2. TIDAK saya ubah: emergencyWithdraw() masih bisa menarik SELURUH
///    reserves, bukan cuma dana nyasar. Ini artinya kalau private key owner
///    bocor, penyerang bisa kuras semua dana LP — bukan cuma "stuck funds".
///    Saya sengaja tidak sentuh ini di patch ini karena mengubah kewenangan
///    fungsi itu butuh keputusan desain (mis. timelock, multisig, atau batasi
///    ke saldo != reserves tercatat). Tandai ini sebagai risiko terbuka.
/// 3. swap() sekarang punya parameter _minAmountOut (slippage protection).
///    ⚠️ INI BREAKING CHANGE UNTUK FRONTEND: app.js yang manggil swap() harus
///    ditambah argumen ke-4. Hitung _minAmountOut di frontend dari quote
///    yang kamu tampilkan ke user, dikurangi toleransi slippage (mis. 0.5-1%),
///    BUKAN dikirim 0 — kalau dikirim 0 maka proteksinya tidak berfungsi sama
///    sekali dan sandwich attack tetap lolos.
/// 4. TIDAK saya ubah: transfer/transferFrom pakai interface manual, bukan
///    SafeERC20. Token yang return false alih-alih revert bisa gagal diam-diam.
///    ArcenticStakingMultiToken sudah pakai SafeERC20 — pool ini belum.
contract ArcenticMultiPool is Ownable2Step {
    // Pool reserves per token
    mapping(address => uint256) public reserves;

    // LP balance per user per token (tracks how much each user deposited)
    mapping(address => mapping(address => uint256)) public lpBalance;

    constructor(address _owner) Ownable(_owner) {}

    // Add liquidity for any token
    function addLiquidity(address _token, uint256 _amount) external {
        require(_amount > 0, "Amount must be > 0");
        IERC20(_token).transferFrom(msg.sender, address(this), _amount);
        reserves[_token] += _amount;
        lpBalance[msg.sender][_token] += _amount;
    }

    // Withdraw previously deposited liquidity (up to your own LP balance)
    function removeLiquidity(address _token, uint256 _amount) external {
        require(_amount > 0, "Amount must be > 0");
        require(lpBalance[msg.sender][_token] >= _amount, "Insufficient LP balance");
        require(reserves[_token] >= _amount, "Insufficient pool reserve");

        lpBalance[msg.sender][_token] -= _amount;
        reserves[_token] -= _amount;
        IERC20(_token).transfer(msg.sender, _amount);
    }

    // Swap tokenIn -> tokenOut using constant product formula (x * y = k)
    // _minAmountOut: batas minimum yang diterima user. Kalau harga bergerak
    // (mis. front-run/sandwich) sampai amountOut jatuh di bawah ini, tx revert
    // alih-alih diam-diam mengeksekusi swap yang rugi untuk user.
    function swap(address _tokenIn, address _tokenOut, uint256 _amountIn, uint256 _minAmountOut) external returns (uint256 amountOut) {
        require(reserves[_tokenIn] > 0 && reserves[_tokenOut] > 0, "Pool liquidity insufficient");

        IERC20(_tokenIn).transferFrom(msg.sender, address(this), _amountIn);

        // Constant product: amountOut = amountIn * reserveOut / (reserveIn + amountIn)
        amountOut = (_amountIn * reserves[_tokenOut]) / (reserves[_tokenIn] + _amountIn);
        require(amountOut >= _minAmountOut, "Slippage: amountOut below minimum");

        reserves[_tokenIn] += _amountIn;
        reserves[_tokenOut] -= amountOut;

        IERC20(_tokenOut).transfer(msg.sender, amountOut);
    }

    // Emergency withdraw by owner (for any stuck funds)
    // ⚠️ Lihat catatan #2 di atas — fungsi ini masih bisa menarik seluruh
    // reserves, bukan hanya dana yang benar-benar "nyasar".
    function emergencyWithdraw(address _token, uint256 _amount) external onlyOwner {
        IERC20(_token).transfer(owner(), _amount);
    }
}
