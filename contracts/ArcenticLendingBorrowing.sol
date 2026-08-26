// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts@5.0.2/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts@5.0.2/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts@5.0.2/access/Ownable2Step.sol";

/// @notice CATATAN PATCH (baca sebelum deploy mainnet):
/// 1. Kontrak lama punya `address public owner` tapi TIDAK PERNAH DIPAKAI —
///    tidak ada modifier onlyOwner, tidak ada satupun fungsi admin. Ini bug
///    tersembunyi: tidak ada cara mengubah parameter apapun setelah deploy.
///    Sudah saya ganti ke Ownable2Step (sama seperti kontrak staking kamu)
///    supaya ada kontrol admin yang nyata.
/// 2. cirBTCPriceUSDC sekarang bisa diupdate via setCirBTCPrice(), dibatasi
///    onlyOwner, dengan sanity bound (tidak boleh 0 dan tidak boleh melompat
///    lebih dari MAX_PRICE_MOVE_BPS dalam satu kali update) supaya owner
///    yang keliru input atau key yang dicuri tidak bisa langsung set harga
///    absurd (misal ke 1) dan membuka pinjaman tak terbatas dalam satu tx.
/// 3. INI BUKAN ORACLE — ini cuma harga manual yang owner update sendiri.
///    Kalau owner lupa/telat update saat harga BTC riil bergerak jauh,
///    kontrak ini tetap salah hitung collateral value. Untuk mainnet
///    sungguhan, ganti ini dengan Chainlink price feed (atau oracle lain)
///    sebelum ada uang sungguhan masuk — ini cuma menutup lubang "tidak
///    bisa diubah sama sekali", bukan menutup lubang "butuh oracle asli".
/// 4. Liquidation mechanism sudah ditambahkan (lihat liquidate() di bawah).
///    Aturannya: collateralFactor (50%) adalah batas MAX BORROW saat buka
///    pinjaman baru. liquidationThresholdBps (75%) adalah batas BERBEDA —
///    kalau rasio pinjaman/nilai-collateral naik melewati 75% (karena harga
///    cirBTC turun, atau owner update harga turun), SIAPAPUN boleh panggil
///    liquidate() untuk melunasi sebagian/seluruh utang itu dan menerima
///    collateral senilai utang yang dilunasi + bonus 5%. Ini insentif
///    ekonomi supaya posisi under-water dibersihkan otomatis oleh pihak
///    ketiga, bukan menunggu owner bertindak manual.
///    ⚠️ Ini tetap bergantung pada cirBTCPriceUSDC yang akurat. Kalau owner
///    telat update harga turun, posisi yang sebenarnya sudah under-water
///    di harga riil tidak akan terlihat "liquidatable" oleh kontrak sampai
///    harga di-update. Oracle asli (Chainlink) menyelesaikan ini secara
///    otomatis — harga manual tidak.
/// 5. TIDAK saya ubah: transfer/transferFrom masih interface manual, bukan
///    SafeERC20 — token yang return false alih-alih revert bisa gagal diam-diam.
contract LendingBorrowing is Ownable2Step {
    IERC20 public cirBTC;
    IERC20 public usdc;

    uint256 public collateralFactor = 50; // 50%
    uint256 public cirBTCPriceUSDC = 65000 * 1e6; // $65,000 dalam USDC (6 desimal)

    /// @notice Batas maksimum perubahan harga per panggilan setCirBTCPrice(),
    ///         dalam basis points dari harga saat ini. 2000 = maksimum ±20%.
    uint256 public constant MAX_PRICE_MOVE_BPS = 2000;

    /// @notice Rasio utang/nilai-collateral (bps) di atas mana posisi bisa
    ///         dilikuidasi. Harus > collateralFactor supaya ada ruang aman
    ///         antara "batas pinjam" dan "batas liquidatable".
    uint256 public liquidationThresholdBps = 7500; // 75%

    /// @notice Bonus (bps dari collateral yang disita) yang diterima
    ///         liquidator sebagai insentif melakukan liquidate().
    uint256 public liquidationBonusBps = 500; // 5%

    event CirBTCPriceUpdated(uint256 oldPrice, uint256 newPrice);
    event LiquidationParamsUpdated(uint256 thresholdBps, uint256 bonusBps);
    event Liquidated(address indexed borrower, address indexed liquidator, uint256 debtRepaid, uint256 collateralSeized);

    struct Loan {
        uint256 amount;
        uint256 collateral;
        bool isActive;
    }

    mapping(address => uint256) public collateralBalances;
    mapping(address => Loan) public loans;

    constructor(address _owner, address _cirBTC, address _usdc) Ownable(_owner) {
        cirBTC = IERC20(_cirBTC);
        usdc = IERC20(_usdc);
    }

    /// @notice Update harga cirBTC dalam USDC (6 desimal). Dibatasi ±20% per
    ///         panggilan sebagai sanity guard — kalau harga riil bergerak
    ///         lebih jauh dari itu, panggil beberapa kali atau naikkan
    ///         MAX_PRICE_MOVE_BPS lewat redeploy (bukan lewat fungsi ini).
    function setCirBTCPrice(uint256 _newPrice) external onlyOwner {
        require(_newPrice > 0, "price = 0");
        uint256 old = cirBTCPriceUSDC;
        uint256 maxDelta = (old * MAX_PRICE_MOVE_BPS) / 10_000;
        uint256 diff = _newPrice > old ? _newPrice - old : old - _newPrice;
        require(diff <= maxDelta, "price move exceeds limit");
        cirBTCPriceUSDC = _newPrice;
        emit CirBTCPriceUpdated(old, _newPrice);
    }

    /// @notice Ubah ambang liquidation / bonus. thresholdBps HARUS lebih besar
    ///         dari collateralFactor*100 (mis. collateralFactor=50 -> minimal 5001)
    ///         supaya posisi yang baru dibuka tidak langsung liquidatable.
    function setLiquidationParams(uint256 _thresholdBps, uint256 _bonusBps) external onlyOwner {
        require(_thresholdBps > collateralFactor * 100, "threshold must exceed collateral factor");
        require(_thresholdBps <= 10_000, "threshold > 100%");
        require(_bonusBps <= 2_000, "bonus too high"); // hard cap 20% sebagai sanity guard
        liquidationThresholdBps = _thresholdBps;
        liquidationBonusBps = _bonusBps;
        emit LiquidationParamsUpdated(_thresholdBps, _bonusBps);
    }

    /// @notice Nilai collateral (dalam USDC, 6 desimal) milik `borrower` pada
    ///         harga cirBTC saat ini.
    function collateralValueOf(address borrower) public view returns (uint256) {
        return (collateralBalances[borrower] * cirBTCPriceUSDC) / 1e8;
    }

    /// @notice True kalau rasio utang/nilai-collateral borrower sudah melewati
    ///         liquidationThresholdBps — artinya posisi ini boleh dilikuidasi.
    function isLiquidatable(address borrower) public view returns (bool) {
        Loan memory l = loans[borrower];
        if (!l.isActive || l.amount == 0) return false;
        uint256 collVal = collateralValueOf(borrower);
        if (collVal == 0) return true; // utang > 0 tapi collateral 0 -> jelas under-water
        uint256 thresholdDebt = (collVal * liquidationThresholdBps) / 10_000;
        return l.amount > thresholdDebt;
    }

    /// @notice Siapapun boleh memanggil ini untuk melunasi sebagian/seluruh
    ///         utang `borrower` yang sudah liquidatable, dan sebagai gantinya
    ///         menerima collateral cirBTC senilai utang yang dilunasi + bonus.
    /// @param borrower Alamat peminjam yang posisinya under-water.
    /// @param repayAmount Jumlah USDC utang yang mau dilunasi oleh liquidator
    ///        (boleh sebagian, tidak harus melunasi seluruh utang sekaligus).
    function liquidate(address borrower, uint256 repayAmount) external {
        require(isLiquidatable(borrower), "position not liquidatable");
        Loan storage l = loans[borrower];
        require(repayAmount > 0 && repayAmount <= l.amount, "bad repay amount");

        usdc.transferFrom(msg.sender, address(this), repayAmount);

        // Konversi USDC yang dilunasi -> setara cirBTC pada harga saat ini,
        // pakai konversi yang sama (dibalik) dengan takeLoan()/collateralValueOf().
        uint256 collateralEquivalent = (repayAmount * 1e8) / cirBTCPriceUSDC;
        uint256 bonus = (collateralEquivalent * liquidationBonusBps) / 10_000;
        uint256 seize = collateralEquivalent + bonus;
        if (seize > collateralBalances[borrower]) {
            seize = collateralBalances[borrower]; // tidak bisa menyita lebih dari yang ada
        }

        collateralBalances[borrower] -= seize;
        l.amount -= repayAmount;
        l.collateral = collateralBalances[borrower];
        if (l.amount == 0) {
            l.isActive = false;
        }

        cirBTC.transfer(msg.sender, seize);
        emit Liquidated(borrower, msg.sender, repayAmount, seize);
    }

    function depositCollateral(uint256 amount) external {
        require(amount > 0, "Amount must be > 0");
        cirBTC.transferFrom(msg.sender, address(this), amount);
        collateralBalances[msg.sender] += amount;
    }

    function takeLoan(uint256 amount) external {
        require(amount > 0, "Amount must be > 0");
        uint256 collVal = (collateralBalances[msg.sender] * cirBTCPriceUSDC) / 1e8;
        uint256 maxBorrow = (collVal * collateralFactor) / 100;
        uint256 alreadyBorrowed = loans[msg.sender].isActive ? loans[msg.sender].amount : 0;
        require(alreadyBorrowed + amount <= maxBorrow, "Exceeds borrow limit");
        require(usdc.balanceOf(address(this)) >= amount, "Insufficient USDC in pool");

        loans[msg.sender].amount += amount;
        loans[msg.sender].collateral = collateralBalances[msg.sender];
        loans[msg.sender].isActive = true;
        usdc.transfer(msg.sender, amount);
    }

    function repayLoan(uint256 amount) external {
        require(loans[msg.sender].isActive, "No active loan");
        require(amount > 0, "Amount must be > 0");
        usdc.transferFrom(msg.sender, address(this), amount);
        if (amount >= loans[msg.sender].amount) {
            loans[msg.sender].amount = 0;
            loans[msg.sender].isActive = false;
        } else {
            loans[msg.sender].amount -= amount;
        }
    }

    function withdrawCollateral(uint256 amount) external {
        require(!loans[msg.sender].isActive, "Repay loan first");
        require(collateralBalances[msg.sender] >= amount, "Insufficient collateral");
        collateralBalances[msg.sender] -= amount;
        cirBTC.transfer(msg.sender, amount);
    }

    // Owner bisa top-up USDC ke pool agar ada likuiditas untuk dipinjam
    function fundPool(uint256 amount) external {
        usdc.transferFrom(msg.sender, address(this), amount);
    }
}
