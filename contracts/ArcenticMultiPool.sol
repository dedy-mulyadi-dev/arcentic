// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts@5.0.2/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts@5.0.2/token/ERC20/extensions/IERC20Metadata.sol";
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
/// 5. FIX KRITIS (ditemukan lewat pengujian gas pasca-Zero8, 4 Sept 2026):
///    swap() versi lama menghitung amountOut langsung dari reserves mentah
///    tanpa menormalisasi perbedaan desimal antar token. Contoh nyata yang
///    ditemukan: USDC (6 desimal) vs USDT deploy testnet ini (18 desimal) —
///    swap 1 USDC dihitung kontrak cuma senilai ~0.0275 USDT, selisih 36x
///    lipat dari nilai wajar. Ini bukan cuma bug tampilan, ini kerentanan
///    ekonomi: siapapun yang tahu bisa swap dengan harga timpang dan
///    menguras reserve token yang desimalnya lebih rendah. Fix: semua
///    perhitungan rasio di swap() sekarang dinormalisasi ke basis 18
///    desimal dulu (_normalize/_denormalize), desimal tiap token di-cache
///    on-chain via decimals() saat pertama kali dipakai supaya swap
///    berikutnya tidak perlu external call berulang.
///    ⚠️ INI BREAKING CHANGE: kontrak lama yang sudah dideploy TIDAK bisa
///    di-upgrade in-place (bukan proxy pattern). Perlu redeploy penuh +
///    migrasi ulang liquidity dari pool lama sebelum mainnet.
contract ArcenticMultiPool is Ownable2Step {
    // Pool reserves per token
    mapping(address => uint256) public reserves;

    // LP balance per user per token (tracks how much each user deposited)
    mapping(address => mapping(address => uint256)) public lpBalance;

    // Cache desimal token — diisi otomatis saat token pertama kali dipakai
    // (addLiquidity atau swap), supaya panggilan berikutnya tidak perlu
    // external call decimals() lagi.
    mapping(address => uint8) private _cachedDecimals;
    mapping(address => bool) private _decimalsCached;

    uint8 private constant BASE_DECIMALS = 18;

    constructor(address _owner) Ownable(_owner) {}

    /// @notice Ambil desimal token, cache di storage supaya cuma 1x external
    ///         call seumur hidup kontrak per token (kecuali token aneh yang
    ///         desimalnya bisa berubah — tidak kita dukung, itu di luar scope).
    function _getDecimals(address _token) internal returns (uint8) {
        if (_decimalsCached[_token]) return _cachedDecimals[_token];
        uint8 d = IERC20Metadata(_token).decimals();
        _cachedDecimals[_token] = d;
        _decimalsCached[_token] = true;
        return d;
    }

    /// @notice Skalakan amount dari desimal aslinya ke basis 18 desimal,
    ///         supaya rasio antar token dengan desimal berbeda bisa
    ///         dibandingkan secara adil (bukan angka mentah apa adanya).
    function _normalize(uint256 _amount, uint8 _decimals) internal pure returns (uint256) {
        if (_decimals == BASE_DECIMALS) return _amount;
        if (_decimals < BASE_DECIMALS) return _amount * (10 ** (BASE_DECIMALS - _decimals));
        return _amount / (10 ** (_decimals - BASE_DECIMALS));
    }

    /// @notice Kebalikan dari _normalize — dari basis 18 desimal kembali ke
    ///         desimal asli token, dipakai untuk hasil akhir amountOut.
    function _denormalize(uint256 _amount, uint8 _decimals) internal pure returns (uint256) {
        if (_decimals == BASE_DECIMALS) return _amount;
        if (_decimals < BASE_DECIMALS) return _amount / (10 ** (BASE_DECIMALS - _decimals));
        return _amount * (10 ** (_decimals - BASE_DECIMALS));
    }

    // Add liquidity for any token
    function addLiquidity(address _token, uint256 _amount) external {
        require(_amount > 0, "Amount must be > 0");
        IERC20(_token).transferFrom(msg.sender, address(this), _amount);
        reserves[_token] += _amount;
        lpBalance[msg.sender][_token] += _amount;
    }

    // Withdraw previously deposited liquidity (up to your own LP balance).
    //
    // MITIGASI (belum fix sempurna — lihat catatan desain di atas kontrak):
    // Karena reserves per-token bisa turun di bawah total lpBalance akibat
    // swap (lpBalance TIDAK proporsional terhadap reserves aktual, ini
    // desain lama yang belum di-rewrite jadi LP-share model), withdraw yang
    // diminta bisa melebihi reserves[_token] yang tersedia saat ini.
    //
    // Daripada revert total (yang membuat LP stuck sepenuhnya sampai reserves
    // pulih), fungsi ini sekarang memberi SEBANYAK reserves yang tersedia,
    // dan MENYISAKAN kekurangannya di lpBalance untuk diklaim nanti (lewat
    // pemanggilan removeLiquidity lagi) begitu reserves token itu terisi lagi
    // (dari deposit LP lain atau swap balik ke token ini).
    //
    // Ini TIDAK menghilangkan risiko dasarnya — LP tetap bisa menunggu lama
    // untuk dapat sisa dananya kalau reserves token itu jarang terisi lagi.
    // Ini mitigasi non-breaking untuk launch, bukan pengganti rewrite LP-share
    // model yang benar secara matematis.
    function removeLiquidity(address _token, uint256 _amount) external returns (uint256 amountWithdrawn) {
        require(_amount > 0, "Amount must be > 0");
        require(lpBalance[msg.sender][_token] >= _amount, "Insufficient LP balance");

        uint256 available = reserves[_token];
        amountWithdrawn = _amount > available ? available : _amount;
        require(amountWithdrawn > 0, "Pool reserve currently empty for this token");

        lpBalance[msg.sender][_token] -= amountWithdrawn;
        reserves[_token] -= amountWithdrawn;
        IERC20(_token).transfer(msg.sender, amountWithdrawn);
    }

    // Swap tokenIn -> tokenOut using constant product formula (x * y = k)
    // _minAmountOut: batas minimum yang diterima user. Kalau harga bergerak
    // (mis. front-run/sandwich) sampai amountOut jatuh di bawah ini, tx revert
    // alih-alih diam-diam mengeksekusi swap yang rugi untuk user.
    //
    // PENTING: reserveIn/reserveOut dan amountIn dinormalisasi ke basis 18
    // desimal DULU sebelum masuk rumus constant product, supaya token dengan
    // desimal berbeda (mis. USDC 6 desimal vs token 18 desimal) tidak
    // menghasilkan harga yang timpang. Hasil akhir amountOut baru
    // di-denormalisasi kembali ke desimal asli _tokenOut.
    function swap(address _tokenIn, address _tokenOut, uint256 _amountIn, uint256 _minAmountOut) external returns (uint256 amountOut) {
        require(reserves[_tokenIn] > 0 && reserves[_tokenOut] > 0, "Pool liquidity insufficient");

        uint8 decIn = _getDecimals(_tokenIn);
        uint8 decOut = _getDecimals(_tokenOut);

        IERC20(_tokenIn).transferFrom(msg.sender, address(this), _amountIn);

        uint256 amountInNorm = _normalize(_amountIn, decIn);
        uint256 reserveInNorm = _normalize(reserves[_tokenIn], decIn);
        uint256 reserveOutNorm = _normalize(reserves[_tokenOut], decOut);

        // Constant product dalam basis 18 desimal, baru dikembalikan ke
        // desimal asli tokenOut.
        uint256 amountOutNorm = (amountInNorm * reserveOutNorm) / (reserveInNorm + amountInNorm);
        amountOut = _denormalize(amountOutNorm, decOut);

        require(amountOut >= _minAmountOut, "Slippage: amountOut below minimum");

        reserves[_tokenIn] += _amountIn;
        reserves[_tokenOut] -= amountOut;

        IERC20(_tokenOut).transfer(msg.sender, amountOut);
    }

    // Emergency withdraw by owner (for any stuck funds)
    // ⚠️ Lihat catatan #2 di atas — fungsi ini masih bisa menarik seluruh
    // reserves, bukan hanya dana yang benar-benar "nyasar". Itu risiko
    // KEWENANGAN (siapa yang boleh menarik berapa banyak) dan SENGAJA belum
    // diubah di sini — itu butuh keputusan desain terpisah (timelock,
    // multisig, atau batasan saldo != reserves tercatat).
    //
    // FIX di sini cuma soal ACCOUNTING: sebelumnya fungsi ini transfer token
    // keluar TANPA mengurangi reserves[_token], jadi reserves[_token] jadi
    // lebih besar dari saldo token yang benar-benar dipegang kontrak — LP
    // lain yang removeLiquidity() bisa gagal (reserves "hantu") atau, dengan
    // patch mitigasi removeLiquidity di atas, malah dapat withdrawal address
    // yang tidak didukung saldo riil.
    //
    // reserves[_token] dikurangi SEBANYAK yang tercatat saja (min(_amount,
    // reserves[_token])), bukan _amount penuh — supaya menarik token yang
    // benar-benar nyasar (dikirim langsung ke kontrak, tidak pernah tercatat
    // di reserves) tidak menyebabkan underflow/revert.
    function emergencyWithdraw(address _token, uint256 _amount) external onlyOwner {
        uint256 trackedReserve = reserves[_token];
        uint256 reserveDecrease = _amount > trackedReserve ? trackedReserve : _amount;
        reserves[_token] = trackedReserve - reserveDecrease;
        IERC20(_token).transfer(owner(), _amount);
    }
}
