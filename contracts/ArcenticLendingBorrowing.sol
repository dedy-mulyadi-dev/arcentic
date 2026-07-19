// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract LendingBorrowing {
    address public owner;
    IERC20 public cirBTC;
    IERC20 public usdc;

    uint256 public collateralFactor = 50; // 50%
    uint256 public cirBTCPriceUSDC = 65000 * 1e6; // $65,000 dalam USDC (6 desimal)

    struct Loan {
        uint256 amount;
        uint256 collateral;
        bool isActive;
    }

    mapping(address => uint256) public collateralBalances;
    mapping(address => Loan) public loans;

    constructor(address _cirBTC, address _usdc) {
        owner = msg.sender;
        cirBTC = IERC20(_cirBTC);
        usdc = IERC20(_usdc);
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