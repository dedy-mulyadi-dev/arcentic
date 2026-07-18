// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts@5.0.2/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts@5.0.2/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts@5.0.2/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts@5.0.2/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts@5.0.2/utils/Pausable.sol";

/// @title ArcenticStakingMultiToken
/// @notice True multi-token staking: the owner whitelists any number of ERC-20 tokens,
///         each with its own independent set of fixed-duration / fixed-APR lock tiers.
///         Stakers pick a token AND a tier; rewards are paid in the SAME token that was
///         staked (no cross-token exchange-rate risk) and are pre-reserved from a
///         per-token, owner-funded reward pool at stake time.
/// @dev IMPORTANT SECURITY NOTE: staking is only possible for tokens the owner has
///      explicitly whitelisted with addToken(). This is intentional — allowing
///      permissionless staking of arbitrary tokens would let anyone break pool
///      accounting with fee-on-transfer, rebasing, or reentrant (ERC-777 style)
///      tokens. Only whitelist standard, audited, non-rebasing ERC-20s.
contract ArcenticStakingMultiToken is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant MAX_APR_BPS = 100_000; // 1000% hard ceiling, sanity guard
    uint256 public constant MAX_PENALTY_BPS = 3_000; // 30% hard ceiling on early-exit penalty

    /// @notice Where early-unstake penalties are sent. Defaults to the deployer.
    address public treasury;

    /// @notice Penalty (in bps of principal) charged on emergency (pre-unlock) withdrawals.
    /// @dev Applies uniformly across all tokens for simplicity/predictability.
    uint256 public earlyExitPenaltyBps;

    struct Tier {
        uint256 lockDuration; // seconds
        uint256 aprBps;       // annual percentage rate, in basis points
        bool active;          // whether new stakes can be opened in this tier
    }

    struct TokenPool {
        bool supported;          // whitelisted by owner; gates new stakes/funding
        Tier[] tiers;
        uint256 totalStaked;        // principal currently staked, this token, always 1:1 backed
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

    constructor(address _owner) Ownable(_owner) {
        treasury = _owner;
    }

    // ─────────────────────────────── Admin: tokens ───────────────────────────────

    /// @notice Whitelist a new ERC-20 token for staking. Reverts if already added.
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

    /// @notice Number of tokens ever added via addToken(). Some may currently have
    ///         supported == false — check tokenSupported() before offering new stakes.
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
    ///         against any open stake). Cannot touch reserved rewards or staker principal.
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

    // ─────────────────────────────── Staking ───────────────────────────────

    function stakeCountOf(address user) external view returns (uint256) {
        return stakesOf[user].length;
    }

    function stake(address token, uint256 tierId, uint256 amount) external nonReentrant whenNotPaused {
        TokenPool storage pool = pools[token];
        require(pool.supported, "token not supported");
        require(tierId < pool.tiers.length, "bad tier");
        require(amount > 0, "amount = 0");
        Tier memory t = pool.tiers[tierId];
        require(t.active, "tier inactive");

        // Pull tokens first and use the actual received amount for all accounting,
        // so fee-on-transfer tokens can't desync totalStaked from real contract balance.
        uint256 received = _pullTokens(token, msg.sender, amount);
        require(received > 0, "nothing received");

        uint256 maxReward = _rewardFor(received, t.aprBps, t.lockDuration);
        require(pool.rewardPoolBalance >= maxReward, "insufficient reward pool");

        pool.rewardPoolBalance -= maxReward;
        pool.reservedRewards += maxReward;
        pool.totalStaked += received;

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

    /// @notice Claim accrued rewards without unstaking the principal.
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
    function unstake(uint256 stakeId) external nonReentrant {
        StakeInfo storage s = stakesOf[msg.sender][stakeId];
        require(!s.withdrawn, "stake withdrawn");
        require(isUnlocked(msg.sender, stakeId), "still locked");

        uint256 reward = pendingReward(msg.sender, stakeId);
        uint256 principal = s.amount;
        TokenPool storage pool = pools[s.token];

        s.withdrawn = true;
        s.claimedReward += reward;
        pool.totalStaked -= principal;
        if (reward > 0) pool.reservedRewards -= reward;

        // Unreserve anything left over (should normally be ~0 at full maturity, but
        // rounding / early tier changes could leave dust reserved).
        uint256 leftoverReserved = s.reservedReward > s.claimedReward
            ? s.reservedReward - s.claimedReward
            : 0;
        if (leftoverReserved > 0) {
            pool.reservedRewards -= leftoverReserved;
            pool.rewardPoolBalance += leftoverReserved;
        }

        uint256 payout = principal + reward;
        IERC20(s.token).safeTransfer(msg.sender, payout);

        emit Unstaked(msg.sender, stakeId, s.token, principal, reward);
    }

    /// @notice Exit before the lock expires. Forfeits all accrued/reserved reward for this
    ///         stake and may incur an owner-configured penalty (in bps of principal) that
    ///         goes to the treasury. Reserved reward is returned to that token's pool.
    function emergencyUnstake(uint256 stakeId) external nonReentrant {
        StakeInfo storage s = stakesOf[msg.sender][stakeId];
        require(!s.withdrawn, "stake withdrawn");
        require(!isUnlocked(msg.sender, stakeId), "use unstake()");

        uint256 principal = s.amount;
        uint256 forfeited = s.reservedReward - s.claimedReward;
        TokenPool storage pool = pools[s.token];

        s.withdrawn = true;
        pool.totalStaked -= principal;
        pool.reservedRewards -= forfeited;
        pool.rewardPoolBalance += forfeited;

        uint256 penalty = (principal * earlyExitPenaltyBps) / BPS_DENOMINATOR;
        uint256 returned = principal - penalty;

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
