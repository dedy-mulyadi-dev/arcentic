// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20 {
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

contract ArcenticMultiPool {
    // Contract owner (set at deploy time)
    address public owner;

    // Pool reserves per token
    mapping(address => uint256) public reserves;

    // LP balance per user per token (tracks how much each user deposited)
    mapping(address => mapping(address => uint256)) public lpBalance;

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

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
    function swap(address _tokenIn, address _tokenOut, uint256 _amountIn) external returns (uint256 amountOut) {
        require(reserves[_tokenIn] > 0 && reserves[_tokenOut] > 0, "Pool liquidity insufficient");

        IERC20(_tokenIn).transferFrom(msg.sender, address(this), _amountIn);

        // Constant product: amountOut = amountIn * reserveOut / (reserveIn + amountIn)
        amountOut = (_amountIn * reserves[_tokenOut]) / (reserves[_tokenIn] + _amountIn);

        reserves[_tokenIn] += _amountIn;
        reserves[_tokenOut] -= amountOut;

        IERC20(_tokenOut).transfer(msg.sender, amountOut);
    }

    // Emergency withdraw by owner (for any stuck funds)
    function emergencyWithdraw(address _token, uint256 _amount) external onlyOwner {
        IERC20(_token).transfer(owner, _amount);
    }
}
