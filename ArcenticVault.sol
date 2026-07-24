// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts@5.0.2/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts@5.0.2/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts@5.0.2/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts@5.0.2/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts@5.0.2/utils/Pausable.sol";

/// @dev Minimal interface for the already-deployed ArcenticMultiPool contract.
///      NOTE: ArcenticMultiPool does NOT mint a transferable LP token — `lpBalance`
///      is an internal mapping keyed by whoever called addLiquidity(). Because of
///      that, this vault must itself be the depositor of record in the pool: it
///      pulls each user's principal, forwards it into the pool via addLiquidity()
///      (so it becomes real, tradable reserve liquidity), and tracks each user's
///      share/lock/reward entirely in its own storage.
interface IArcenticMultiPool {
    function addLiquidity(address _token, uint256 _amount) external;
    function removeLiquidity(address _token, uint256 _amount) external;
    function lpBalance(address user, address token) external view returns (uint256);
    function reserves(address token) external view returns (uint256);
}

/// @title ArcenticVault
/// @notice Lets users lock (stake) tokens for a fixed duration / fixed APR tier,
///         same reward mechanics as ArcenticStakingMultiToken (rewards paid in the
///         same token, pre-reserved from an owner-funded reward pool) — but instead
///         of the principal sitting idle in this contract, it is forwarded into
///         ArcenticMultiPool as real liquidity for as long as it stays locked, and
///         pulled back out again on unstake/emergencyUnstake.
/// @dev IMPORTANT SECURITY NOTES:
///      1. Staking is only possible for tokens the owner has explicitly whitelisted
///         with addToken(). Only whitelist standard, audited, non-rebasing ERC-20s —
///         same rule as ArcenticStakingMultiToken.
///      2. This vault is fully dependent on ArcenticMultiPool's own security. In
///         particular, ArcenticMultiPool.emergencyWithdraw() lets the POOL's owner
///         pull reserves out at any time. If that happens, removeLiquidity() calls
///         from this vault can fail or return less than expected, and stakers could
///         be unable to withdraw their principal. This vault cannot protect against
///         that — it is a trust assumption on whoever owns ArcenticMultiPool.
contract ArcenticVault is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant MAX_APR_BPS = 100_000; // 1000% hard ceiling, sanity guard
    uint256 public constant MAX_PENALTY_BPS = 3_000; // 30% hard ceiling on early-exit penalty

    /// @notice The ArcenticMultiPool this vault deposits/withdraws liquidity through.
    IArcenticMultiPool public immutable pool;

    /// @notice Where early-unstake penalties are sent. Defaults to the deployer.
    address public treasury;

    /// @notice Penalty (in bps of principal) charged on emergency (pre-unlock) withdrawals.
    uint256 public earlyExitPenaltyBps;

    struct Tier {
        uint256 lockDuration; // seconds
        uint256 aprBps;       // annual percentage rate, in basis points
        bool active;          // whether new stakes can be opened in this tier
    }

    struct TokenPool {
        bool supported;             // whitelisted by owner; gates new stakes/funding
        Tier[] tiers;
        uint256 totalStaked;        // principal currently staked, this token (all deposited into `pool`)
        uint256 rewardPoolBalance;  // funded but not yet reserved against any stake
        uint256 reservedRewards;    // reserved against open stakes, may be partially unpaid
    }

    struct StakeInfo {
        address token;
        uint256 tierId;
        uint256 amount;
        uint256 startTime;
        uint256 lockDuration;   // snapshot from tier at stake time (immutable per-stake)
        uint256 aprBps;         // snapshot from tier at stake time (immutable per-stake)
        uint256 claimedReward;
        uint256 reservedReward; // max reward reserved out of the reward pool for this stake
        bool withdrawn;
    }

    mapping(address => TokenPool) private pools;
    mapping(address => bool) private everAdded; // true once addToken() has been called for a token
    address[] private supportedTokenList;

    mapping(address => StakeInfo[]) public stakesOf;

    event TokenAdded(address indexed token);
    event TokenSupportedSet(address indexed token, bool supported);
    event TierAdded(address indexed token, uint256 indexed tierId, uint256 lockDuration, uint256 aprBps);
    event TierUpdated(address indexed token, uint256 indexed tierId, uint256 aprBps, bool active);
    event RewardsFunded(address indexed token, address indexed from, uint256 amount);
    event RewardsWithdrawn(address indexed token, address indexed to, uint256 amount);
    event Staked(address indexed user, uint256 indexed stakeId, address indexed token, uint256 tierId, uint256 amount, uint256 reservedReward);
    event RewardClaimed(address indexed user, uint256 indexed stakeId, address indexed token, uint256 amount);
    event Unstaked(address indexed user, uint256 indexed stakeId, address indexed token, uint256 principal, uint256 finalReward);
    event EmergencyUnstaked(address indexed user, uint256 indexed stakeId, address indexed token, uint256 principalReturned, uint256 penalty);
    event TreasuryUpdated(address indexed treasury);
    event EarlyExitPenaltyUpdated(uint256 penaltyBps);

    constructor(address _owner, address _treasury, address _pool) Ownable(_owner) {
        require(_treasury != address(0), "treasury = zero addr");
        require(_pool != address(0), "pool = zero addr");
        treasury = _treasury;
        pool = IArcenticMultiPool(_pool);
    }

    // ─────────────────────────────── Admin: tokens ───────────────────────────────

    /// @notice Whitelist a new ERC-20 token for staking. Reverts if already added.
    ///         Should normally be a token that is also supported in ArcenticMultiPool,
    ///         otherwise addLiquidity() on the pool will simply add a brand-new reserve
    ///         entry for it there.
    function addToken(address token) external onlyOwner {
        require(token != address(0), "token = zero addr");
        require(!everAdded[token], "token already added");
        everAdded[token] = true;
        pools[token].supported = true;
        supportedTokenList.push(token);
        emit TokenAdded(token);
    }

    /// @notice Toggle whether new stakes/reward funding are accepted for a token.
    ///         Existing stakes remain claimable/unstakeable regardless of this flag.
    function setTokenSupported(address token, bool supported) external onlyOwner {
        require(everAdded[token], "unknown token");
        pools[token].supported = supported;
        emit TokenSupportedSet(token, supported);
    }

    function supportedTokensLength() external view returns (uint256) {
        return supportedTokenList.length;
    }

    function supportedTokenAt(uint256 index) external view returns (address) {
        return supportedTokenList[index];
    }

    function tokenSupported(address token) external view returns (bool) {
        return pools[token].supported;
    }

    // ─────────────────────────────── Admin: tiers ───────────────────────────────

    function addTier(address token, uint256 lockDuration, uint256 aprBps) external onlyOwner {
        require(pools[token].supported, "token not supported");
        require(lockDuration > 0, "lockDuration = 0");
        require(aprBps > 0 && aprBps <= MAX_APR_BPS, "bad apr");
        pools[token].tiers.push(Tier({lockDuration: lockDuration, aprBps: aprBps, active: true}));
        emit TierAdded(token, pools[token].tiers.length - 1, lockDuration, aprBps);
    }

    /// @notice Update APR and/or active flag for a tier. Only affects *future* stakes;
    ///         existing stakes keep the APR/lock they were opened with.
    function setTier(address token, uint256 tierId, uint256 aprBps, bool active) external onlyOwner {
        require(tierId < pools[token].tiers.length, "bad tier");
        require(aprBps > 0 && aprBps <= MAX_APR_BPS, "bad apr");
        Tier storage t = pools[token].tiers[tierId];
        t.aprBps = aprBps;
        t.active = active;
        emit TierUpdated(token, tierId, aprBps, active);
    }

    function tiersLength(address token) external view returns (uint256) {
        return pools[token].tiers.length;
    }

    function tierAt(address token, uint256 tierId) external view returns (uint256 lockDuration, uint256 aprBps, bool active) {
        Tier storage t = pools[token].tiers[tierId];
        return (t.lockDuration, t.aprBps, t.active);
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "treasury = zero addr");
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    function setEarlyExitPenaltyBps(uint256 _penaltyBps) external onlyOwner {
        require(_penaltyBps <= MAX_PENALTY_BPS, "penalty too high");
        earlyExitPenaltyBps = _penaltyBps;
        emit EarlyExitPenaltyUpdated(_penaltyBps);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─────────────────────────────── Admin: reward pool ───────────────────────────────

    /// @notice Fund a token's reward pool. Anyone may top it up, but only the owner
    ///         should normally need to. Uses the actual received amount (post-transfer
    ///         balance delta) so fee-on-transfer tokens can't silently over-credit.
    function fundRewards(address token, uint256 amount) external nonReentrant {
        require(pools[token].supported, "token not supported");
        require(amount > 0, "amount = 0");
        uint256 received = _pullTokens(token, msg.sender, amount);
        pools[token].rewardPoolBalance += received;
        emit RewardsFunded(token, msg.sender, received);
    }

    /// @notice Owner can reclaim reward tokens that are sitting uncommitted (not reserved
    ///         against any open stake). Cannot touch reserved rewards or staker principal
    ///         (principal is inside ArcenticMultiPool, not this contract).
    function withdrawUnreservedRewards(address token, uint256 amount) external onlyOwner nonReentrant {
        require(amount <= pools[token].rewardPoolBalance, "exceeds unreserved");
        pools[token].rewardPoolBalance -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit RewardsWithdrawn(token, msg.sender, amount);
    }

    function rewardPoolBalanceOf(address token) external view returns (uint256) {
        return pools[token].rewardPoolBalance;
    }

    function reservedRewardsOf(address token) external view returns (uint256) {
        return pools[token].reservedRewards;
    }

    function totalStakedOf(address token) external view returns (uint256) {
        return pools[token].totalStaked;
    }

    /// @notice How much liquidity this vault currently has deposited into
    ///         ArcenticMultiPool for a given token. Should track totalStakedOf(token)
    ///         under normal operation — a persistent mismatch signals something
    ///         happened on the pool side (e.g. emergencyWithdraw by the pool owner).
    function vaultLiquidityInPool(address token) external view returns (uint256) {
        return pool.lpBalance(address(this), token);
    }

    // ─────────────────────────────── Staking ───────────────────────────────

    function stakeCountOf(address user) external view returns (uint256) {
        return stakesOf[user].length;
    }

    function stake(address token, uint256 tierId, uint256 amount) external nonReentrant whenNotPaused {
        TokenPool storage p = pools[token];
        require(p.supported, "token not supported");
        require(tierId < p.tiers.length, "bad tier");
        require(amount > 0, "amount = 0");
        Tier memory t = p.tiers[tierId];
        require(t.active, "tier inactive");

        // Pull principal from the user first, using the actual received amount so
        // fee-on-transfer tokens can't desync accounting.
        uint256 received = _pullTokens(token, msg.sender, amount);
        require(received > 0, "nothing received");

        uint256 maxReward = _rewardFor(received, t.aprBps, t.lockDuration);
        require(p.rewardPoolBalance >= maxReward, "insufficient reward pool");

        p.rewardPoolBalance -= maxReward;
        p.reservedRewards += maxReward;
        p.totalStaked += received;

        // Forward the principal into ArcenticMultiPool as real liquidity. The vault
        // (not the individual user) is the depositor of record in the pool.
        IERC20(token).forceApprove(address(pool), received);
        pool.addLiquidity(token, received);

        stakesOf[msg.sender].push(
            StakeInfo({
                token: token,
                tierId: tierId,
                amount: received,
                startTime: block.timestamp,
                lockDuration: t.lockDuration,
                aprBps: t.aprBps,
                claimedReward: 0,
                reservedReward: maxReward,
                withdrawn: false
            })
        );

        emit Staked(msg.sender, stakesOf[msg.sender].length - 1, token, tierId, received, maxReward);
    }

    /// @notice Reward accrued so far for a stake (linear, capped at the stake's lock
    ///         duration), minus whatever has already been claimed.
    function pendingReward(address user, uint256 stakeId) public view returns (uint256) {
        StakeInfo storage s = stakesOf[user][stakeId];
        if (s.withdrawn) return 0;
        uint256 elapsed = block.timestamp - s.startTime;
        if (elapsed > s.lockDuration) elapsed = s.lockDuration;
        uint256 accrued = _rewardFor(s.amount, s.aprBps, elapsed);
        if (accrued <= s.claimedReward) return 0;
        return accrued - s.claimedReward;
    }

    function isUnlocked(address user, uint256 stakeId) public view returns (bool) {
        StakeInfo storage s = stakesOf[user][stakeId];
        return block.timestamp >= s.startTime + s.lockDuration;
    }

    /// @notice Claim accrued rewards without unstaking the principal. Rewards are paid
    ///         straight out of this vault's reward pool (never touches pool liquidity).
    function claimReward(uint256 stakeId) external nonReentrant {
        StakeInfo storage s = stakesOf[msg.sender][stakeId];
        require(!s.withdrawn, "stake withdrawn");
        uint256 reward = pendingReward(msg.sender, stakeId);
        require(reward > 0, "nothing to claim");

        s.claimedReward += reward;
        pools[s.token].reservedRewards -= reward;

        IERC20(s.token).safeTransfer(msg.sender, reward);
        emit RewardClaimed(msg.sender, stakeId, s.token, reward);
    }

    /// @notice Withdraw principal + any remaining accrued reward once the lock has expired.
    ///         Pulls the principal back out of ArcenticMultiPool via removeLiquidity().
    function unstake(uint256 stakeId) external nonReentrant {
        StakeInfo storage s = stakesOf[msg.sender][stakeId];
        require(!s.withdrawn, "stake withdrawn");
        require(isUnlocked(msg.sender, stakeId), "still locked");

        uint256 reward = pendingReward(msg.sender, stakeId);
        uint256 principal = s.amount;
        TokenPool storage p = pools[s.token];

        s.withdrawn = true;
        s.claimedReward += reward;
        p.totalStaked -= principal;
        if (reward > 0) p.reservedRewards -= reward;

        // Unreserve anything left over (should normally be ~0 at full maturity, but
        // rounding / early tier changes could leave dust reserved).
        uint256 leftoverReserved = s.reservedReward > s.claimedReward
            ? s.reservedReward - s.claimedReward
            : 0;
        if (leftoverReserved > 0) {
            p.reservedRewards -= leftoverReserved;
            p.rewardPoolBalance += leftoverReserved;
        }

        // Pull principal back out of ArcenticMultiPool into this vault, then forward
        // principal + reward to the user in a single transfer.
        pool.removeLiquidity(s.token, principal);

        uint256 payout = principal + reward;
        IERC20(s.token).safeTransfer(msg.sender, payout);

        emit Unstaked(msg.sender, stakeId, s.token, principal, reward);
    }

    /// @notice Exit before the lock expires. Forfeits all accrued/reserved reward for this
    ///         stake and may incur an owner-configured penalty (in bps of principal) that
    ///         goes to the treasury. Reserved reward is returned to that token's pool.
    ///         Principal is pulled back out of ArcenticMultiPool the same way as unstake().
    function emergencyUnstake(uint256 stakeId) external nonReentrant {
        StakeInfo storage s = stakesOf[msg.sender][stakeId];
        require(!s.withdrawn, "stake withdrawn");
        require(!isUnlocked(msg.sender, stakeId), "use unstake()");

        uint256 principal = s.amount;
        uint256 forfeited = s.reservedReward - s.claimedReward;
        TokenPool storage p = pools[s.token];

        s.withdrawn = true;
        p.totalStaked -= principal;
        p.reservedRewards -= forfeited;
        p.rewardPoolBalance += forfeited;

        uint256 penalty = (principal * earlyExitPenaltyBps) / BPS_DENOMINATOR;
        uint256 returned = principal - penalty;

        pool.removeLiquidity(s.token, principal);

        if (penalty > 0) {
            IERC20(s.token).safeTransfer(treasury, penalty);
        }
        IERC20(s.token).safeTransfer(msg.sender, returned);

        emit EmergencyUnstaked(msg.sender, stakeId, s.token, returned, penalty);
    }

    // ─────────────────────────────── Internal ───────────────────────────────

    function _rewardFor(uint256 amount, uint256 aprBps, uint256 duration) internal pure returns (uint256) {
        return (amount * aprBps * duration) / (BPS_DENOMINATOR * SECONDS_PER_YEAR);
    }

    /// @dev Pulls `amount` of `token` from `from` and returns the ACTUAL amount received,
    ///      measured via balance delta. Protects internal accounting against fee-on-transfer
    ///      tokens. Does NOT protect against rebasing tokens changing balance later, or
    ///      against reentrant/callback ("ERC-777 style") tokens — such tokens must not be
    ///      whitelisted via addToken().
    function _pullTokens(address token, address from, uint256 amount) internal returns (uint256) {
        IERC20 t = IERC20(token);
        uint256 before = t.balanceOf(address(this));
        t.safeTransferFrom(from, address(this), amount);
        uint256 afterBal = t.balanceOf(address(this));
        return afterBal - before;
    }
}
