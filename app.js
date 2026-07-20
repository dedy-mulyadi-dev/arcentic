    /* SECURITY: token name/symbol and other on-chain metadata are read directly
       from arbitrary contracts (anyone can deploy an ERC-20 with name() /
       symbol() returning "<img src=x onerror=...>"). Any such value going into
       innerHTML MUST be escaped first - never interpolate it raw. */
    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function toggleMobileNav() {
        const el = document.getElementById('mobileNav');
        if (el) el.classList.toggle('hidden');
    }

    const ARC_CHAIN = {
        chainId: '0x4CEF52',
        chainName: 'Arc Testnet',
        // Multiple independent public RPC endpoints for better resilience
        // If the primary one hiccups (returns an HTTP 4xx/5xx) the wallet can
        // fail over to the next available endpoint.
        rpcUrls: [
            'https://rpc.testnet.arc.network',
            'https://arc-testnet.drpc.org'
        ],
        nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
        blockExplorerUrls: ['https://testnet.arcscan.app/']
    };

    const ETHEREUM_SEPOLIA_CHAIN = {
        chainId: '0xaa36a7',
        chainName: 'Ethereum Sepolia',
        rpcUrls: [
            'https://ethereum-sepolia-rpc.publicnode.com',
            'https://sepolia.drpc.org',
            'https://rpc.sepolia.org',
            'https://rpc.ankr.com/eth_sepolia',
            'https://ethereum-sepolia.blockpi.network/v1/rpc/public'
        ],
        nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
        blockExplorerUrls: ['https://sepolia.etherscan.io/']
    };

    /* ══════════════════════════════════════════════════
       CCTP CONFIGURATION
       Cross-Chain Transfer Protocol for bridging USDC
    ══════════════════════════════════════════════════ */
    const CCTP_CONFIG = {
        // Domain IDs from Circle CCTP documentation
        domains: {
            ETHEREUM_SEPOLIA: 0,
            ARC_TESTNET: 26
        },
        // Contract addresses for Ethereum Sepolia (properly checksummed)
        ethereumSepolia: {
            usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
            tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
            messageTransmitter: '0x91566bbf0e2A8c08cE886B7351da2B5C0ce9EB44'
        },
        // Contract addresses for Arc Testnet (verified against docs.arc.io/arc/references/contract-addresses)
        arcTestnet: {
            usdc: '0x3600000000000000000000000000000000000000', // Native USDC ERC-20 interface on Arc (6 decimals)
            tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
            messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275'
        },
        // Circle Attestation API (Iris) — testnet sandbox base for GET /v2/messages/{sourceDomain}
        attestationApi: 'https://iris-api-sandbox.circle.com/v2/messages'
    };

    // CCTP Contract ABIs (simplified for key functions)
    const TOKEN_MESSENGER_ABI = [
        'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) external',
        'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData) external',
        'function handleReceiveFinalizedMessage(bytes32 messageHeader, bytes32 messageBody) external'
    ];

    const MESSAGE_TRANSMITTER_ABI = [
        'function receiveMessage(bytes message, bytes attestation) external returns (bool)',
        'function sendMessage(uint32 destinationDomain, bytes32 recipient, bytes32 destinationCaller, bytes messageBody) external returns (bytes32)'
    ];

    /* ══════════════════════════════════════════════════
       UNISWAP V3 CONFIGURATION (Ethereum Sepolia only)
       Arc Testnet's native gas token IS USDC, so there is
       nothing to swap there — only the Sepolia leg ever
       needs an ETH<->USDC conversion. Addresses below are
       Uniswap's official Sepolia testnet deployment, and
       the pool fee (0.05%) is the deepest-liquidity USDC/WETH
       pool on that network.
    ══════════════════════════════════════════════════ */
    const UNISWAP_CONFIG = {
        ethereumSepolia: {
            swapRouter02: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
            quoterV2: '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3',
            weth: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
            poolFee: 500 // 0.05%
        }
    };

    // Sentinel recipient understood by SwapRouter02's Constants.sol —
    // means "leave the output tokens sitting in the router itself" so a
    // following call in the same multicall (e.g. unwrapWETH9) can act on them.
    const UNI_ADDRESS_THIS = '0x00000000000000000000000000000000000002';

    const SWAP_ROUTER_02_ABI = [
        'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)',
        'function multicall(bytes[] data) external payable returns (bytes[] results)',
        'function unwrapWETH9(uint256 amountMinimum, address recipient) external payable',
        'function refundETH() external payable'
    ];

    const QUOTER_V2_ABI = [
        'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'
    ];

    // Quotes how much `amountOut` you'd get swapping `amountIn` of tokenIn ->
    // tokenOut on the Sepolia USDC/WETH pool. Uses callStatic (an eth_call,
    // no tx/gas) against the QuoterV2 contract. Returns a BigNumber.
    async function getSwapQuote(tokenIn, tokenOut, amountIn) {
        return await callWithChainFallback('ethereumSepolia', async (provider) => {
            const quoter = new ethers.Contract(UNISWAP_CONFIG.ethereumSepolia.quoterV2, QUOTER_V2_ABI, provider);
            const result = await quoter.callStatic.quoteExactInputSingle({
                tokenIn,
                tokenOut,
                amountIn,
                fee: UNISWAP_CONFIG.ethereumSepolia.poolFee,
                sqrtPriceLimitX96: 0
            });
            return result.amountOut;
        });
    }

    // Applies a slippage tolerance (in %) to a quoted amount, rounding down.
    function applySlippage(amount, slippagePct) {
        const bps = Math.round((100 - slippagePct) * 100); // e.g. 3% -> 9700
        return amount.mul(bps).div(10000);
    }

    /* ══════════════════════════════════════════════════
       PENDING BRIDGE PERSISTENCE
       If the attestation poll times out, the burn has ALREADY happened
       on-chain — only the mint step is left. Previously, clicking
       "Bridge USDC" again re-ran approve+burn from scratch, silently
       burning the user's USDC a second time. We now persist the burn
       tx hash right after it confirms, so a retry resumes straight at
       the attestation/mint step instead of burning again.
    ══════════════════════════════════════════════════ */
    const PENDING_BRIDGE_KEY = 'arcentic_pending_bridge';

    function pendingBridgeStorageKey(account, sourceChain, destChain) {
        return `${PENDING_BRIDGE_KEY}_${(account || '').toLowerCase()}_${sourceChain}_${destChain}`;
    }

    function getPendingBridge(account, sourceChain, destChain) {
        try {
            const raw = localStorage.getItem(pendingBridgeStorageKey(account, sourceChain, destChain));
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function savePendingBridge(account, sourceChain, destChain, data) {
        try {
            localStorage.setItem(pendingBridgeStorageKey(account, sourceChain, destChain), JSON.stringify(data));
        } catch (e) { /* storage unavailable — resume just won't be possible */ }
    }

    function clearPendingBridge(account, sourceChain, destChain) {
        try {
            localStorage.removeItem(pendingBridgeStorageKey(account, sourceChain, destChain));
        } catch (e) {}
    }

    /* ══════════════════════════════════════════════════
       RPC RESILIENCE HELPERS
       The public Arc Testnet RPC occasionally returns a transient
       "HTTP client error" (4xx) on an individual request even while the
       network itself is healthy. withRpcRetry() retries any RPC/contract
       call a few times with a short backoff before giving up, so a single
       flaky response doesn't fail an entire Supply/Withdraw/Swap action.
    ══════════════════════════════════════════════════ */
    function isTransientRpcError(err) {
        const msg = ((err && (err.message || err.reason)) || '').toLowerCase();
        return msg.includes('http client error') ||
               msg.includes('http server error') ||
               msg.includes('missing response') ||
               msg.includes('timeout') ||
               msg.includes('network error') ||
               msg.includes('failed to fetch') ||
               msg.includes('rate limit') ||
               msg.includes('connection reset') ||
               msg.includes('econnrefused') ||
               msg.includes('enotfound') ||
               msg.includes('etimedout') ||
               msg.includes('network unreachable') ||
               msg.includes('temporary failure') ||
               msg.includes('502') ||
               msg.includes('503') ||
               msg.includes('504') ||
               msg.includes('429') ||
               err?.code === 'NETWORK_ERROR' ||
               err?.code === 'TIMEOUT' ||
               err?.code === -32603 || // generic internal JSON-RPC error
               err?.code === -32602 || // invalid params (sometimes transient)
               err?.code === -32000; // server error
    }

    async function withRpcRetry(fn, { retries = 5, delayMs = 1000, onRetry } = {}) {
        let lastErr;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await fn();
            } catch (err) {
                lastErr = err;
                // Don't retry user rejections or genuine contract reverts — only
                // retry errors that look like a transient RPC/network hiccup.
                if (err?.code === 4001 || err?.code === 'ACTION_REJECTED' || !isTransientRpcError(err)) {
                    throw err;
                }
                if (attempt < retries) {
                    if (onRetry) onRetry(attempt + 1, retries);
                    await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
                    continue;
                }
            }
        }
        throw lastErr;
    }

    /* Turn a raw ethers/wallet error into a short, user-facing message.
       Transient RPC failures get an actionable hint instead of the raw
       "RPC endpoint returned HTTP client error." string. */
    function friendlyTxError(err) {
        if (isTransientRpcError(err)) {
            return 'The network RPC is temporarily unreachable. Please wait a moment and try again — if it keeps happening, try switching to a backup RPC in your wallet\'s network settings.';
        }
        return err.reason || err.message || 'Unknown error';
    }

    const connectBtn = document.getElementById('connectBtn');
    const modal      = document.getElementById('disconnectModal');
    const modalAddr  = document.getElementById('modalAddress');
    const modalBal   = document.getElementById('modalBalance');

    let isConnected    = false;
    let currentAccount = null;
    let currentBalance = '0';

    /* ── Admin gating ──
       IMPORTANT: this only controls whether the Admin nav item/panel is
       *shown* in this browser tab. It is a UI convenience, not real access
       control — anyone can open devtools and call showAdmin() directly, or
       just edit this constant in a saved copy of the page. It does NOT
       stop another wallet from reaching admin-only functionality.
       Real protection has to come from the smart contract itself: any
       on-chain admin action this panel triggers must be guarded by an
       onlyOwner-style modifier on the contract side, so the transaction
       reverts for every wallet except the real owner regardless of what
       the frontend does or doesn't show. Treat this constant as "hide the
       button from everyone else", not "only I can do this".
    */
    const ADMIN_WALLET = '0x86435cad0B9a46A67fD0756BdA7cFa992417ef1f';

    function isAdminWallet(addr) {
        return !!addr && addr.toLowerCase() === ADMIN_WALLET.toLowerCase();
    }

    function updateAdminVisibility() {
        const show = isConnected && isAdminWallet(currentAccount);
        const btn  = document.getElementById('navAdmin');
        const btnM = document.getElementById('navAdminMobile');
        if (btn)  btn.style.display  = show ? '' : 'none';
        if (btnM) btnM.style.display = show ? '' : 'none';
        // If the account changed away from the admin wallet while the panel
        // was open (e.g. user switched accounts in MetaMask), boot them out.
        const view = document.getElementById('adminView');
        if (!show && view && view.classList.contains('open')) showHome();
    }

    /* ── Helpers ── */
    function shortAddr(a) { return a.slice(0,6) + '...' + a.slice(-4); }

    function fmtBal(ether) {
        const n = parseFloat(ether);
        if (n === 0) return '0';
        if (n >= 1000) return n.toLocaleString(undefined, {maximumFractionDigits: 2});
        if (n >= 1)    return n.toFixed(4);
        return n.toPrecision(4);
    }

    async function fetchBalance(account) {
        const provider = new ethers.providers.Web3Provider(window.ethereum);
        const raw = await provider.getBalance(account);
        return ethers.utils.formatEther(raw);
    }

    /* ── View switching ── */
    function hideAllOverlays() {
        ['portfolioView','swapView','bridgeView','poolsView','eijiView','lendView','stakeView','adminView','tradingHubView','spotTradeView'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.remove('open');
        });
        document.body.style.overflow = '';
        stopSpotTradePolling();
    }

    function setNavActive(id) {
        ['navHome','navPortfolio','navEiji','navLend','navStake','navAdmin','navTrading'].forEach(n => {
            const el = document.getElementById(n);
            if (!el) return;
            el.classList.remove('glass','nav-active');
        });
        const active = document.getElementById(id);
        if (active) active.classList.add('glass','nav-active');
    }

    function showHome() {
        hideAllOverlays();
        setNavActive('navHome');
    }

    function showPortfolio() {
        hideAllOverlays();
        document.getElementById('portfolioView').classList.add('open');
        document.body.style.overflow = 'hidden';
        setNavActive('navPortfolio');
        if (isConnected) renderPortfolioData(currentAccount, currentBalance);
    }

    function showTradingHub() {
        hideAllOverlays();
        document.getElementById('tradingHubView').classList.add('open');
        document.body.style.overflow = 'hidden';
        setNavActive('navTrading');
    }

    function showSwap() {
        hideAllOverlays();
        document.getElementById('swapView').classList.add('open');
        document.body.style.overflow = 'hidden';
        setNavActive('navTrading');
        updateSwapBalances();
    }

    function showBridge() {
        hideAllOverlays();
        document.getElementById('bridgeView').classList.add('open');
        document.body.style.overflow = 'hidden';
        setNavActive('navTrading');
        setBridgeSourceToken(bridgeSourceToken, true);
        setBridgeDestToken(bridgeDestToken, true);
        updateBridgeBalances();
    }

    /* ── Portfolio rendering ── */
    function renderPortfolioData(account, balEther) {
        const display = fmtBal(balEther);
        document.getElementById('pfAddr').innerText     = account;
        document.getElementById('pfBal').innerText      = display + ' USDC';
        document.getElementById('pfBalToken').innerText = fmtBal(balEther) + ' USDC';
        document.getElementById('pfBarMax').innerText   = fmtBal(balEther) + ' USDC';
        const pct = Math.min(parseFloat(balEther) / 100 * 100, 100);
        document.getElementById('pfBarFill').style.width = Math.max(pct, 2) + '%';
        document.getElementById('pfExplorer').href = `https://testnet.arcscan.app/address/${account}`;

        document.getElementById('pfLocked').classList.add('hidden');
        document.getElementById('pfConnected').classList.remove('hidden');
        document.getElementById('pfRefreshBtn').classList.remove('hidden');

        // Fetch live balances for all ARC testnet tokens
        fetchAllTokenBalances(account);
    }

    async function fetchAllTokenBalances(account) {
        const tokenDefs = [
            { id: 'pfBalEURC',   tok: TOKENS.find(t => t.sym === 'EURC'),   sym: 'EURC'   },
            { id: 'pfBalUSDT',   tok: TOKENS.find(t => t.sym === 'USDT'),   sym: 'USDT'   },
            { id: 'pfBalCENTIC', tok: TOKENS.find(t => t.sym === 'CENTIC'), sym: 'CENTIC' },
        ];
        await Promise.all(tokenDefs.map(async ({ id, tok, sym }) => {
            if (!tok) return;
            const el = document.getElementById(id);
            if (el) el.innerText = '…';
            try {
                const bal = await fetchTokenBalance(tok, account);
                if (el) el.innerText = bal + ' ' + sym;
            } catch {
                if (el) el.innerText = '0.0000 ' + sym;
            }
        }));
    }

    function clearPortfolioData() {
        document.getElementById('pfLocked').classList.remove('hidden');
        document.getElementById('pfConnected').classList.add('hidden');
        document.getElementById('pfRefreshBtn').classList.add('hidden');
        ['pfBalEURC','pfBalUSDT','pfBalCENTIC'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerText = '—';
        });
    }

    async function refreshPortfolioData() {
        if (!currentAccount) return;
        const btn = document.getElementById('pfRefreshBtn');
        btn.innerText = '⟳ Refreshing…'; btn.style.opacity = '.6';
        try {
            const bal = await fetchBalance(currentAccount);
            currentBalance = bal;
            renderPortfolioData(currentAccount, bal);
        } catch(e) { console.error(e); }
        btn.innerText = '⟳ Refresh'; btn.style.opacity = '1';
    }

    /* ══════════════════════════════════════════════════
       CONTRACT ADDRESSES
    ══════════════════════════════════════════════════ */
    const CONTRACT_ADDRS = {
        ArcenticMultiPool : '0x1975f275E8b2F6974246e952a4636Cfc675d43cb',
        CENTIC            : '0xC55D995d096A5c0832c1ee6918C481f502DCBcB7',
        USDC              : '0x3600000000000000000000000000000000000000',
        EURC              : '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
        USDT              : '0x175CdB1D338945f0D851A741ccF787D343E57952',
        cirBTC            : '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
        LendingBorrowing  : '0x15e803e1Bac195896B15561337aA97cd0ffBcD58',
        // TODO: fill in after running scripts/deploy.js from the
        // arcentic-staking project (ArcenticStakingMultiToken.sol)
        ArcenticStaking   : '0x473d6b0a414d6E72Cc40A040dC38d9d0AC635D5d',
    };

    /* ArcenticStakingMultiToken ABI — true multi-token staking: any whitelisted
       ERC-20 can be staked, each with its own independent lock tiers. */
    const STAKING_ABI = [
        'function supportedTokensLength() view returns (uint256)',
        'function supportedTokenAt(uint256) view returns (address)',
        'function tokenSupported(address token) view returns (bool)',
        'function tiersLength(address token) view returns (uint256)',
        'function tierAt(address token, uint256 tierId) view returns (uint256 lockDuration, uint256 aprBps, bool active)',
        'function stake(address token, uint256 tierId, uint256 amount)',
        'function claimReward(uint256 stakeId)',
        'function unstake(uint256 stakeId)',
        'function emergencyUnstake(uint256 stakeId)',
        'function stakeCountOf(address user) view returns (uint256)',
        'function stakesOf(address, uint256) view returns (address token, uint256 tierId, uint256 amount, uint256 startTime, uint256 lockDuration, uint256 aprBps, uint256 claimedReward, uint256 reservedReward, bool withdrawn)',
        'function pendingReward(address user, uint256 stakeId) view returns (uint256)',
        'function isUnlocked(address user, uint256 stakeId) view returns (bool)',
        'function totalStakedOf(address token) view returns (uint256)',
        'function rewardPoolBalanceOf(address token) view returns (uint256)',
        'function BPS_DENOMINATOR() view returns (uint256)',
        // ── Admin (onlyOwner on-chain — see loadAdminOverview()/adminSendTx() below) ──
        'function owner() view returns (address)',
        'function paused() view returns (bool)',
        'function treasury() view returns (address)',
        'function earlyExitPenaltyBps() view returns (uint256)',
        'function reservedRewardsOf(address token) view returns (uint256)',
        'function MAX_APR_BPS() view returns (uint256)',
        'function MAX_PENALTY_BPS() view returns (uint256)',
        'function addToken(address token)',
        'function setTokenSupported(address token, bool supported)',
        'function addTier(address token, uint256 lockDuration, uint256 aprBps)',
        'function setTier(address token, uint256 tierId, uint256 aprBps, bool active)',
        'function setTreasury(address _treasury)',
        'function setEarlyExitPenaltyBps(uint256 _penaltyBps)',
        'function pause()',
        'function unpause()',
        'function fundRewards(address token, uint256 amount)',
        'function withdrawUnreservedRewards(address token, uint256 amount)',
    ];

    /* ══════════════════════════════════════════════════
       STAKE TAB — ArcenticStakingMultiToken wiring
       Real multi-token staking: pick any owner-whitelisted ERC-20, then a
       fixed lock tier for that token. Rewards paid in the staked token itself.
    ══════════════════════════════════════════════════ */
    let stakeTokens = [];          // [{addr, sym, decimals, icon}] — on-chain supported tokens
    let selectedStakeToken = null; // address of the currently selected token
    let stakeTiers = [];            // [{id, lockDuration, aprBps, active}] for selectedStakeToken
    let selectedTierId = null;
    const stakeTokenMetaCache = {}; // lowercased addr -> {sym, decimals, icon}

    function stakingConfigured() {
        return CONTRACT_ADDRS.ArcenticStaking &&
               CONTRACT_ADDRS.ArcenticStaking !== '0x0000000000000000000000000000000000000000';
    }

    /* Local-only preview list shown in the token dropdown while the staking
       contract isn't deployed yet, so the UI can still be tested end-to-end
       instead of rendering an empty picker. Marked with preview:true so the
       rest of the flow knows not to hit the chain for these. */
    const STAKE_PREVIEW_SYMS = ['USDC', 'EURC', 'USDT', 'CENTIC'];
    function previewStakeTokens() {
        return TOKENS
            .filter(t => STAKE_PREVIEW_SYMS.includes(t.sym))
            .map(t => ({ addr: t.addr, sym: t.sym, decimals: t.decimals, icon: t.icon, name: t.name, preview: true }));
    }

    /* Sample lock tiers matching the Tier struct in ArcenticStakingMultiToken.sol
       (lockDuration in seconds, aprBps in basis points). These are NOT read from
       chain — just placeholders so the tier cards + APR/reward math can be
       exercised in the UI before the owner calls addTier() for real. */
    const STAKE_PREVIEW_TIERS = [
        { id: 0, lockDuration: 30  * 86400, aprBps: 400,  active: true },  // 30d  @ 4%
        { id: 1, lockDuration: 90  * 86400, aprBps: 900,  active: true },  // 90d  @ 9%
        { id: 2, lockDuration: 180 * 86400, aprBps: 1500, active: true }, // 180d @ 15%
    ];
    function previewStakeTiers() {
        return STAKE_PREVIEW_TIERS.map(t => ({ ...t, preview: true }));
    }

    function fmtDuration(seconds) {
        const days = Math.round(seconds / 86400);
        if (days % 30 === 0 && days >= 30) return (days / 30) + 'mo';
        return days + 'd';
    }

    function fmtApr(aprBps) {
        return (aprBps / 100).toFixed(aprBps % 100 === 0 ? 0 : 2) + '%';
    }

    function currentStakeTokenMeta() {
        return stakeTokens.find(t => t.addr === selectedStakeToken) || { sym: '', decimals: 18 };
    }

    /* Resolve symbol/decimals/icon for a staking token: prefer the local TOKENS
       registry (has nice icons), fall back to an on-chain ERC-20 read for tokens
       the owner whitelisted that aren't in that list. Cached either way. */
    async function getStakeTokenMeta(addr, provider) {
        const key = addr.toLowerCase();
        if (stakeTokenMetaCache[key]) return stakeTokenMetaCache[key];
        const local = TOKENS.find(t => t.addr && t.addr.toLowerCase() === key);
        if (local) {
            const meta = { sym: local.sym, decimals: local.decimals, icon: local.icon };
            stakeTokenMetaCache[key] = meta;
            return meta;
        }
        try {
            const erc20 = new ethers.Contract(addr, ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'], provider);
            const [sym, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
            const meta = { sym, decimals, icon: '' };
            stakeTokenMetaCache[key] = meta;
            return meta;
        } catch (err) {
            console.error('getStakeTokenMeta error for', addr, err);
            const meta = { sym: addr.slice(0, 6) + '…', decimals: 18, icon: '' };
            stakeTokenMetaCache[key] = meta;
            return meta;
        }
    }

    /* ── Admin panel ──
       showAdmin() re-checks isAdminWallet() itself (not just relying on the
       nav button being hidden) so that calling it directly from the console
       with a non-admin wallet connected still gets refused. Again: this
       blocks *this UI* from opening for other people, it is not what makes
       any underlying admin action safe — that has to be enforced by the
       contract's own onlyOwner check. */
    async function showAdmin() {
        if (!isConnected) {
            showToast('warning','Wallet Not Connected','Connect the admin wallet first.');
            return;
        }
        if (!isAdminWallet(currentAccount)) {
            showToast('error','Access Denied','This wallet is not authorized to view the admin panel.');
            return;
        }
        hideAllOverlays();
        document.getElementById('adminView').classList.add('open');
        document.body.style.overflow = 'hidden';
        setNavActive('navAdmin');
        await loadAdminOverview();
    }

    /* ── Admin: send a real onlyOwner transaction ──
       This is where the actual protection lives: `staking[fnName](...)` below
       is sent from the CONNECTED WALLET's signer. If that wallet isn't the
       contract's real owner(), the transaction reverts on-chain with
       "OwnableUnauthorizedAccount" — regardless of what ADMIN_WALLET says in
       this file. The isAdminWallet() check here is just to avoid wasting the
       user's gas on a doomed tx / show a clearer error before they even sign. */
    async function adminSendTx(fnName, args, { successTitle, successMsg, confirmMsg } = {}) {
        if (!isAdminWallet(currentAccount)) {
            showToast('error','Access Denied','This wallet is not authorized to send admin transactions.');
            return false;
        }
        if (confirmMsg && !window.confirm(confirmMsg)) return false;

        let toast = showToast('pending', successTitle || fnName, 'Waiting for wallet confirmation…');
        try {
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const signer = provider.getSigner();
            const staking = new ethers.Contract(CONTRACT_ADDRS.ArcenticStaking, STAKING_ABI, signer);
            const onRpcRetry = (n, max) => updateToast(toast, 'pending', successTitle || fnName, `RPC hiccup — retrying (${n}/${max})…`);

            const tx = await withRpcRetry(() => staking[fnName](...args), { onRetry: onRpcRetry });
            updateToast(toast, 'pending', successTitle || fnName, 'Confirming on-chain…');
            await withRpcRetry(() => tx.wait(), { onRetry: onRpcRetry });

            updateToast(toast, 'success', successTitle || 'Done', successMsg || 'Transaction confirmed.', 6000);
            await loadAdminOverview();
            return true;
        } catch (err) {
            console.error(`adminSendTx(${fnName}) error:`, err);
            updateToast(toast, 'error', 'Transaction Failed', friendlyTxError(err), 8000);
            return false;
        }
    }

    // Small helpers for the admin form inputs
    function adminTokenAddrInput(id)  { return (document.getElementById(id).value || '').trim(); }
    function adminPercentToBps(id)    { return Math.round(parseFloat(document.getElementById(id).value || '0') * 100); }
    function adminDaysToSeconds(id)   { return Math.round(parseFloat(document.getElementById(id).value || '0') * 86400); }

    async function adminAddToken() {
        const token = adminTokenAddrInput('adminTokenAddr');
        if (!ethers.utils.isAddress(token)) { showToast('error','Invalid Address','Enter a valid token contract address.'); return; }
        await adminSendTx('addToken', [token], { successTitle: 'Token Whitelisted', successMsg: token + ' can now be configured for staking.' });
    }

    async function adminSetTokenSupported(supported) {
        const token = adminTokenAddrInput('adminSupportTokenAddr');
        if (!ethers.utils.isAddress(token)) { showToast('error','Invalid Address','Enter a valid token contract address.'); return; }
        await adminSendTx('setTokenSupported', [token, supported],
            { successTitle: supported ? 'Token Enabled' : 'Token Disabled',
              successMsg: `${token} ${supported ? 'now accepts' : 'no longer accepts'} new stakes/funding.` });
    }

    // MAX_APR_BPS is a Solidity `constant` (bytecode-fixed, same for every
    // deployment of this exact contract) — safe to cache client-side after one
    // read, same reasoning as MAX_PENALTY_BPS. Unlike collateralFactor/price in
    // the lending contract, this can't legitimately differ per-deployment, so
    // there's no drift risk in caching it.
    let cachedMaxAprBps = null;
    async function getMaxAprBps() {
        if (cachedMaxAprBps !== null) return cachedMaxAprBps;
        try {
            const staking = new ethers.Contract(CONTRACT_ADDRS.ArcenticStaking, STAKING_ABI, readOnlyProvider());
            cachedMaxAprBps = (await staking.MAX_APR_BPS()).toNumber();
        } catch (e) {
            console.error('getMaxAprBps error (skipping client-side upper-bound check):', e);
        }
        return cachedMaxAprBps;
    }

    async function adminAddTier() {
        const token = adminTokenAddrInput('adminTierTokenAddr');
        const days  = adminDaysToSeconds('adminTierDays');
        const bps   = adminPercentToBps('adminTierApr');
        if (!ethers.utils.isAddress(token)) { showToast('error','Invalid Address','Enter a valid token contract address.'); return; }
        if (days <= 0) { showToast('error','Invalid Duration','Lock duration must be greater than 0.'); return; }
        if (bps <= 0)  { showToast('error','Invalid APR','APR must be greater than 0%.'); return; }
        const maxBps = await getMaxAprBps();
        if (maxBps !== null && bps > maxBps) { showToast('error','APR Too High',`APR must be ${(maxBps/100).toFixed(0)}% or less.`); return; }
        await adminSendTx('addTier', [token, days, bps], { successTitle: 'Tier Added', successMsg: `New lock tier added for ${token}.` });
    }

    async function adminSetTier(active) {
        const token  = adminTokenAddrInput('adminEditTierTokenAddr');
        const tierId = parseInt(document.getElementById('adminEditTierId').value || '-1', 10);
        const bps    = adminPercentToBps('adminEditTierApr');
        if (!ethers.utils.isAddress(token)) { showToast('error','Invalid Address','Enter a valid token contract address.'); return; }
        if (isNaN(tierId) || tierId < 0) { showToast('error','Invalid Tier ID','Enter the tier index to edit.'); return; }
        if (bps <= 0) { showToast('error','Invalid APR','APR must be greater than 0%.'); return; }
        const maxBps = await getMaxAprBps();
        if (maxBps !== null && bps > maxBps) { showToast('error','APR Too High',`APR must be ${(maxBps/100).toFixed(0)}% or less.`); return; }
        await adminSendTx('setTier', [token, tierId, bps, active], { successTitle: 'Tier Updated', successMsg: `Tier #${tierId} for ${token} updated.` });
    }

    /* ── Quick setup: whitelist + enable a known token in two real txs ──
       Just a shortcut around addToken()/setTokenSupported() above so the
       admin doesn't have to paste the same address into two inputs. If
       addToken() reverts because the token is already whitelisted, that
       shows up as a normal failed-tx toast and setTokenSupported() still
       runs — no state is faked either way. */
    async function adminQuickWhitelistEnable() {
        const sel = document.getElementById('adminQuickToken');
        const token = sel.value;
        const sym = sel.options[sel.selectedIndex].text;
        if (!ethers.utils.isAddress(token)) { showToast('error','Invalid Token','Pick a token first.'); return; }
        if (!window.confirm(`Send 2 transactions to whitelist and enable ${sym} for staking?`)) return;

        await adminSendTx('addToken', [token], { successTitle: `${sym} Whitelisted`, successMsg: `${sym} added to supported tokens (or already was — check the toast).` });
        await adminSendTx('setTokenSupported', [token, true], { successTitle: `${sym} Enabled`, successMsg: `${sym} now accepts new stakes/funding.` });
    }

    /* ── Copy tiers: read source token's real on-chain tiers, replicate onto
       target token via addTier(). Never invents tier numbers — reads
       tiersLength()/tierAt() from the contract first, shows the admin what
       it found, and only sends transactions after they confirm. ── */
    async function adminCopyTiers() {
        const srcSel  = document.getElementById('adminCopyTiersSrc');
        const destSel = document.getElementById('adminCopyTiersDest');
        const srcToken  = srcSel.value;
        const destToken = destSel.value;
        const srcSym  = srcSel.options[srcSel.selectedIndex].text;
        const destSym = destSel.options[destSel.selectedIndex].text;

        if (srcToken.toLowerCase() === destToken.toLowerCase()) {
            showToast('error','Same Token','Pick two different tokens — source and target are the same.');
            return;
        }

        let tiers = [];
        try {
            const staking = new ethers.Contract(CONTRACT_ADDRS.ArcenticStaking, STAKING_ABI, readOnlyProvider());
            const len = (await staking.tiersLength(srcToken)).toNumber();
            if (len === 0) { showToast('error','No Tiers Found', `${srcSym} has no tiers on-chain yet — add some in "Add a new tier" first.`); return; }
            const rawTiers = await Promise.all(Array.from({ length: len }, (_, i) => staking.tierAt(srcToken, i)));
            tiers = rawTiers.map(t => ({ lockDuration: t.lockDuration.toNumber(), aprBps: t.aprBps.toNumber(), active: t.active }));
        } catch (err) {
            console.error('adminCopyTiers read error:', err);
            showToast('error','Read Failed', friendlyTxError(err), 8000);
            return;
        }

        const summary = tiers.map(t => `${fmtDuration(t.lockDuration)} @ ${fmtApr(t.aprBps)}${t.active ? '' : ' (inactive)'}`).join(', ');
        if (!window.confirm(`Found ${tiers.length} tier(s) on ${srcSym}: ${summary}.\n\nAdd matching tiers to ${destSym}? You'll sign ${tiers.length} transaction(s) — inactive tiers on the source are copied as active by default; adjust them after via "Edit an existing tier" if needed.`)) return;

        // adminSendTx() resolves to false (not a thrown error) when a tx fails or is
        // rejected — track that per tier instead of assuming every send succeeded,
        // otherwise a partial/total failure would still end in a "Tiers Copied!"
        // success toast.
        let succeeded = 0;
        for (const t of tiers) {
            const ok = await adminSendTx('addTier', [destToken, t.lockDuration, t.aprBps],
                { successTitle: `Tier Added (${destSym})`, successMsg: `${fmtDuration(t.lockDuration)} @ ${fmtApr(t.aprBps)} tier added for ${destSym}, matching ${srcSym}.` });
            if (ok) succeeded++;
        }
        if (succeeded === tiers.length) {
            showToast('success', 'Tiers Copied', `${destSym} now has the same ${tiers.length} tier(s) as ${srcSym}.`, 6000);
        } else if (succeeded > 0) {
            showToast('warning', 'Tiers Partially Copied', `${succeeded} of ${tiers.length} tier(s) copied to ${destSym}. Check the failed transaction(s) above and retry if needed.`, 8000);
        } else {
            showToast('error', 'Tier Copy Failed', `None of the ${tiers.length} tier(s) were copied to ${destSym}.`, 8000);
        }
    }

    async function adminFundRewards() {
        const token = adminTokenAddrInput('adminFundTokenAddr');
        const meta  = stakeTokenMetaCache[token.toLowerCase()];
        const decimals = meta ? meta.decimals : 18;
        const amtStr = document.getElementById('adminFundAmount').value;
        if (!ethers.utils.isAddress(token)) { showToast('error','Invalid Address','Enter a valid token contract address.'); return; }
        if (!amtStr || parseFloat(amtStr) <= 0) { showToast('error','Invalid Amount','Enter an amount to fund.'); return; }
        // Previously there was no feedback at all during allowance-check/approve —
        // the admin just saw nothing happen until the fundRewards prompt popped up,
        // which felt like the click did nothing. Now a toast tracks every step.
        let toast = showToast('pending', 'Funding Rewards', 'Checking token allowance…');
        try {
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const signer = provider.getSigner();
            const amtWei = ethers.utils.parseUnits(parseFloat(amtStr).toFixed(decimals), decimals);
            const onRpcRetry = (n, max) => updateToast(toast, 'pending', 'Funding Rewards', `RPC hiccup — retrying (${n}/${max})…`);
            const tokenContract = new ethers.Contract(token, ERC20_ABI, signer);
            const allowance = await withRpcRetry(() => tokenContract.allowance(currentAccount, CONTRACT_ADDRS.ArcenticStaking), { onRetry: onRpcRetry });
            if (allowance.lt(amtWei)) {
                updateToast(toast, 'pending', 'Funding Rewards', 'Requesting spend approval…');
                const approveTx = await withRpcRetry(() => tokenContract.approve(CONTRACT_ADDRS.ArcenticStaking, ethers.constants.MaxUint256), { onRetry: onRpcRetry });
                updateToast(toast, 'pending', 'Funding Rewards', 'Confirming approval on-chain…');
                await withRpcRetry(() => approveTx.wait(), { onRetry: onRpcRetry });
            }
            removeToast(toast); // adminSendTx() below creates its own pending toast for the fundRewards call itself
            await adminSendTx('fundRewards', [token, amtWei], { successTitle: 'Reward Pool Funded', successMsg: `Funded ${amtStr} tokens into the reward pool.` });
        } catch (err) {
            console.error('adminFundRewards error:', err);
            updateToast(toast, 'error', 'Funding Failed', friendlyTxError(err), 8000);
        }
    }

    async function adminWithdrawUnreserved() {
        const token = adminTokenAddrInput('adminWithdrawTokenAddr');
        const meta  = stakeTokenMetaCache[token.toLowerCase()];
        const decimals = meta ? meta.decimals : 18;
        const amtStr = document.getElementById('adminWithdrawAmount').value;
        if (!ethers.utils.isAddress(token)) { showToast('error','Invalid Address','Enter a valid token contract address.'); return; }
        if (!amtStr || parseFloat(amtStr) <= 0) { showToast('error','Invalid Amount','Enter an amount to withdraw.'); return; }
        const amtWei = ethers.utils.parseUnits(parseFloat(amtStr).toFixed(decimals), decimals);
        await adminSendTx('withdrawUnreservedRewards', [token, amtWei],
            { successTitle: 'Withdrawn', successMsg: `Withdrew ${amtStr} unreserved reward tokens.`,
              confirmMsg: 'Withdraw unreserved reward tokens to your wallet? This never touches staker principal or already-reserved rewards.' });
    }

    /* ── LendingBorrowing: fundPool() ──
       NOTE: unlike adminSendTx() above (which targets ArcenticStaking's real
       onlyOwner functions), fundPool() on LendingBorrowing.sol has NO access
       control in the contract at all — every wallet, not just the owner, can
       call it. Keeping this button behind isAdminWallet() only hides it from
       the nav for non-admin visitors of this page; it doesn't and can't make
       the call owner-only on-chain. If that needs to be locked down, an
       onlyOwner modifier has to be added to fundPool() in the contract and
       redeployed. */
    async function adminFundLendingPool() {
        if (!isConnected) { showToast('error','Wallet Not Connected','Connect your wallet first.'); return; }
        const amtStr = document.getElementById('adminLendFundAmount').value;
        if (!amtStr || parseFloat(amtStr) <= 0) { showToast('error','Invalid Amount','Enter an amount to fund.'); return; }

        let toast = showToast('pending','Funding Pool','Waiting for wallet confirmation…');
        try {
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const signer = provider.getSigner();
            const amtWei = ethers.utils.parseUnits(parseFloat(amtStr).toFixed(USDC_DECIMALS), USDC_DECIMALS);
            const onRpcRetry = (n, max) => updateToast(toast, 'pending', 'Funding Pool', `RPC hiccup — retrying (${n}/${max})…`);

            const usdcContract = new ethers.Contract(CONTRACT_ADDRS.USDC, ERC20_ABI, signer);
            const allowance = await withRpcRetry(() => usdcContract.allowance(currentAccount, CONTRACT_ADDRS.LendingBorrowing), { onRetry: onRpcRetry });
            if (allowance.lt(amtWei)) {
                updateToast(toast, 'pending', 'Funding Pool', 'Approving USDC…');
                const approveTx = await withRpcRetry(() => usdcContract.approve(CONTRACT_ADDRS.LendingBorrowing, ethers.constants.MaxUint256), { onRetry: onRpcRetry });
                await withRpcRetry(() => approveTx.wait(), { onRetry: onRpcRetry });
            }

            updateToast(toast, 'pending', 'Funding Pool', 'Waiting for wallet confirmation…');
            const lend = new ethers.Contract(CONTRACT_ADDRS.LendingBorrowing, LEND_ABI, signer);
            const tx = await withRpcRetry(() => lend.fundPool(amtWei), { onRetry: onRpcRetry });
            updateToast(toast, 'pending', 'Funding Pool', 'Confirming on-chain…');
            await withRpcRetry(() => tx.wait(), { onRetry: onRpcRetry });

            updateToast(toast, 'success', 'Pool Funded', `Funded ${amtStr} USDC into the lending pool.`, 6000);
            document.getElementById('adminLendFundAmount').value = '';
            await loadAdminOverview();
        } catch (err) {
            console.error('adminFundLendingPool error:', err);
            updateToast(toast, 'error', 'Funding Failed', friendlyTxError(err), 8000);
        }
    }

    async function adminSetTreasury() {
        const addr = adminTokenAddrInput('adminTreasuryAddr');
        if (!ethers.utils.isAddress(addr)) { showToast('error','Invalid Address','Enter a valid wallet address.'); return; }
        await adminSendTx('setTreasury', [addr], { successTitle: 'Treasury Updated', successMsg: `Early-exit penalties now go to ${addr}.` });
    }

    async function adminSetPenalty() {
        const bps = adminPercentToBps('adminPenaltyPct');
        if (bps < 0 || bps > 3000) { showToast('error','Out of Range','Penalty must be between 0% and 30%.'); return; }
        await adminSendTx('setEarlyExitPenaltyBps', [bps], { successTitle: 'Penalty Updated', successMsg: `Early-exit penalty set to ${(bps/100).toFixed(2)}%.` });
    }

    async function adminTogglePause(pause) {
        await adminSendTx(pause ? 'pause' : 'unpause', [],
            { successTitle: pause ? 'Staking Paused' : 'Staking Unpaused',
              successMsg: pause ? 'New stakes are now blocked.' : 'New stakes are open again.',
              confirmMsg: pause ? 'Pause all new staking? Existing stakes remain claimable/unstakeable.' : null });
    }

    let adminActiveTab = 'status';

    function adminShowTab(tab) {
        adminActiveTab = tab;
        document.querySelectorAll('.admin-tab-panel').forEach(p => p.classList.remove('admin-tab-panel-active'));
        const panel = document.getElementById('adminTab-' + tab);
        if (panel) panel.classList.add('admin-tab-panel-active');
        document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('admin-tab-active'));
        const btn = document.getElementById('adminTabBtn-' + tab);
        if (btn) {
            btn.classList.add('admin-tab-active');
            btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
    }

    // Monotonically increasing token identifying the most recent loadAdminOverview()
    // call. Needed because nothing else prevents an OLDER, slower call from
    // overwriting adminContent after a NEWER call already resolved — this happens
    // in practice when the admin double-clicks Refresh, or switches wallets in
    // MetaMask while a fetch for the previous account is still in flight (each of
    // showAdmin() / adminSendTx() / the accountsChanged handler can independently
    // trigger loadAdminOverview()). Every call captures its own token and checks it
    // right before writing to the DOM; if a newer call has started in the meantime,
    // this call's result is silently discarded instead of rendering stale data.
    let adminOverviewReqId = 0;

    async function loadAdminOverview() {
        // Defense in depth: bail if somehow called while not the admin wallet.
        if (!isAdminWallet(currentAccount)) { showHome(); return; }

        const myReqId = ++adminOverviewReqId;
        const accountAtStart = currentAccount;

        const el = document.getElementById('adminContent');
        el.innerHTML = '<p class="text-gray-500 text-sm text-center py-10">Loading admin overview…</p>';

        let tvl = null, tokenRows = '', onChainOwner = null, isPaused = null, treasuryAddr = null, penaltyBps = null;
        let lendOwner = null, lendCollFactor = null, lendPrice = null, lendPoolUsdc = null;

        // Status on-chain, TVL, LendingBorrowing status, dan status per-token
        // (whitelisted/enabled/tier count) semuanya independen satu sama lain —
        // jalankan bersamaan (Promise.allSettled) alih-alih berurutan supaya
        // panel admin tidak menunggu berkali-kali lipat waktu round-trip RPC.
        const [statusResult, tvlResult, lendResult, tokenStatusResult] = await Promise.allSettled([
            (async () => {
                const provider = readOnlyProvider();
                const staking = new ethers.Contract(CONTRACT_ADDRS.ArcenticStaking, STAKING_ABI, provider);
                return Promise.all([
                    staking.owner(), staking.paused(), staking.treasury(), staking.earlyExitPenaltyBps()
                ]);
            })(),
            fetchOnChainTVL(),
            (async () => {
                const provider = readOnlyProvider();
                const lend = new ethers.Contract(CONTRACT_ADDRS.LendingBorrowing, LEND_ABI, provider);
                const usdc = new ethers.Contract(CONTRACT_ADDRS.USDC, ERC20_ABI, provider);
                const [owner, factor, price, poolBal] = await Promise.all([
                    lend.owner(), lend.collateralFactor(), lend.cirBTCPriceUSDC(),
                    usdc.balanceOf(CONTRACT_ADDRS.LendingBorrowing)
                ]);
                return {
                    owner,
                    factor: factor.toNumber(),
                    price: parseFloat(ethers.utils.formatUnits(price, USDC_DECIMALS)),
                    poolBal: parseFloat(ethers.utils.formatUnits(poolBal, USDC_DECIMALS)),
                };
            })(),
            (async () => {
                const staking = new ethers.Contract(CONTRACT_ADDRS.ArcenticStaking, STAKING_ABI, readOnlyProvider());
                return Promise.all(TOKENS.map(async (t) => {
                    try {
                        const [supported, tierCount] = await Promise.all([
                            staking.tokenSupported(t.addr),
                            staking.tiersLength(t.addr)
                        ]);
                        return { ...t, supported, tierCount: tierCount.toNumber() };
                    } catch (err) {
                        return { ...t, supported: null, tierCount: null };
                    }
                }));
            })()
        ]);

        if (statusResult.status === 'fulfilled') {
            [onChainOwner, isPaused, treasuryAddr, penaltyBps] = statusResult.value;
        } else {
            console.error('admin on-chain status error:', statusResult.reason);
        }

        if (tvlResult.status === 'fulfilled') {
            tvl = tvlResult.value;
        } else {
            console.error('admin TVL error:', tvlResult.reason);
        }

        if (lendResult.status === 'fulfilled') {
            lendOwner = lendResult.value.owner;
            lendCollFactor = lendResult.value.factor;
            lendPrice = lendResult.value.price;
            lendPoolUsdc = lendResult.value.poolBal;
        } else {
            console.error('admin lending status error:', lendResult.reason);
        }

        // Live on-chain status per known token (tokenSupported / tiersLength) so
        // the admin can see at a glance what still needs setup, instead of a
        // plain address list — this reads real contract state, nothing implied.
        if (tokenStatusResult.status === 'fulfilled') {
            tokenRows = tokenStatusResult.value.map(t => {
                const statusBadge = t.supported === null
                    ? '<span class="text-gray-500 text-xs">status unavailable</span>'
                    : t.supported
                        ? '<span class="text-xs" style="color:#4ade80;">● whitelisted &amp; enabled</span>'
                        : '<span class="text-xs" style="color:#f59e0b;">○ not enabled yet</span>';
                const tierBadge = t.tierCount === null ? '' : `<span class="text-gray-500 text-xs">${t.tierCount} tier${t.tierCount === 1 ? '' : 's'}</span>`;
                return `
                <div class="token-row">
                    <span>${t.sym}${t.name ? ' — ' + t.name : ''}</span>
                    <span class="flex items-center gap-3 flex-wrap justify-end">
                        ${statusBadge}${tierBadge}
                        <span class="text-gray-500 text-xs font-mono">${t.addr}</span>
                    </span>
                </div>`;
            }).join('');
        } else {
            console.error('admin token list error:', tokenStatusResult.reason);
            tokenRows = TOKENS.map(t => `
                <div class="token-row">
                    <span>${t.sym}${t.name ? ' — ' + t.name : ''}</span>
                    <span class="text-gray-500 text-xs font-mono">${t.addr}</span>
                </div>`).join('');
        }

        const contractRows = Object.entries(CONTRACT_ADDRS).map(([name, addr]) => `
            <div class="token-row">
                <span>${name}</span>
                <span class="text-gray-500 text-xs font-mono">${addr}</span>
            </div>`).join('');

        // Stale-response guard: if a newer loadAdminOverview() call started while
        // we were awaiting RPC/API responses above, or the connected account
        // changed under us, don't overwrite the panel with this (now outdated) data.
        if (myReqId !== adminOverviewReqId || currentAccount !== accountAtStart) {
            console.warn('loadAdminOverview: discarding stale result (superseded by a newer call)');
            return;
        }

        const ownerMatches = onChainOwner && isAdminWallet(onChainOwner);
        const ownerWarning = onChainOwner && !ownerMatches
            ? `<div class="mt-3 text-xs px-3 py-2 rounded-lg" style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#fca5a5;">
                 ⚠ On-chain owner() is <span class="font-mono">${onChainOwner}</span> — this does NOT match the ADMIN_WALLET configured in this page.
                 Admin transactions will revert unless sent from the real owner wallet.
               </div>` : '';

        el.innerHTML = `
            <div class="flex gap-2 overflow-x-auto pb-1 mb-6 admin-tabs-nav" id="adminTabsNav">
                <button id="adminTabBtn-status" onclick="adminShowTab('status')" class="admin-tab-btn">📊 Status</button>
                <button id="adminTabBtn-tokens" onclick="adminShowTab('tokens')" class="admin-tab-btn">🪙 Tokens</button>
                <button id="adminTabBtn-tiers" onclick="adminShowTab('tiers')" class="admin-tab-btn">🔒 Lock Tiers</button>
                <button id="adminTabBtn-rewards" onclick="adminShowTab('rewards')" class="admin-tab-btn">💰 Reward Pool</button>
                <button id="adminTabBtn-lending" onclick="adminShowTab('lending')" class="admin-tab-btn">🏦 Lending</button>
                <button id="adminTabBtn-settings" onclick="adminShowTab('settings')" class="admin-tab-btn">⚙️ Settings</button>
                <button id="adminTabBtn-danger" onclick="adminShowTab('danger')" class="admin-tab-btn admin-tab-danger">⚠️ Danger Zone</button>
            </div>

            <div id="adminTab-status" class="admin-tab-panel">
                <div class="glass rounded-3xl p-5 sm:p-8 mb-6">
                    <div class="flex items-center gap-3 mb-1">
                        <span style="width:10px;height:10px;border-radius:50%;background:${ownerMatches ? '#22c55e' : (onChainOwner ? '#ef4444' : '#eab308')};display:inline-block;"></span>
                        <h3 class="text-lg font-black">${ownerMatches ? 'Admin wallet verified on-chain' : 'On-chain owner check'}</h3>
                    </div>
                    <p class="text-gray-500 text-xs font-mono">Connected: ${currentAccount}</p>
                    <p class="text-gray-500 text-xs font-mono">Contract owner(): ${onChainOwner || '—'}</p>
                    ${ownerWarning}
                </div>

                <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <div class="stat-chip">
                        <div class="text-gray-400 text-xs mb-1">Protocol TVL</div>
                        <div class="text-xl font-black">${tvl !== null ? '$' + tvl.toLocaleString(undefined,{maximumFractionDigits:2}) : '—'}</div>
                    </div>
                    <div class="stat-chip">
                        <div class="text-gray-400 text-xs mb-1">Staking status</div>
                        <div class="text-xl font-black">${isPaused === null ? '—' : (isPaused ? '⏸ Paused' : '▶ Live')}</div>
                    </div>
                    <div class="stat-chip">
                        <div class="text-gray-400 text-xs mb-1">Early-exit penalty</div>
                        <div class="text-xl font-black">${penaltyBps === null ? '—' : (penaltyBps.toNumber()/100).toFixed(2) + '%'}</div>
                    </div>
                    <div class="stat-chip">
                        <div class="text-gray-400 text-xs mb-1">Treasury</div>
                        <div class="text-xs font-mono break-all">${treasuryAddr || '—'}</div>
                    </div>
                </div>
            </div>

            <div id="adminTab-tokens" class="admin-tab-panel">
                <div class="glass rounded-3xl p-5 sm:p-8 mb-6">
                    <h3 class="text-lg font-black mb-2">Token Config (known tokens)</h3>
                    <div>${tokenRows || '<p class="text-gray-500 text-sm">No tokens configured.</p>'}</div>
                </div>

                <!-- ── Admin Actions — every button below calls a real onlyOwner
                       function on ArcenticStakingMultiToken via the connected
                       wallet's signer. The transaction reverts on-chain if the
                       signer isn't the actual owner(), no matter what this UI shows. ── -->
                <div class="glass rounded-3xl p-5 sm:p-8">
                    <h3 class="text-lg font-black mb-4">Tokens</h3>
                    <div class="grid sm:grid-cols-2 gap-6">
                        <div>
                            <p class="text-xs text-gray-400 mb-2">Whitelist a new token</p>
                            <input id="adminTokenAddr" type="text" placeholder="0x… token address" class="w-full mb-2 px-3 py-2 rounded-lg text-sm" style="background:rgba(255,255,255,.04);border:1px solid rgba(92,120,255,.2);color:#fff;">
                            <button onclick="adminAddToken()" class="token-select-btn tok-active w-full">Add Token</button>
                        </div>
                        <div>
                            <p class="text-xs text-gray-400 mb-2">Enable / disable a token</p>
                            <input id="adminSupportTokenAddr" type="text" placeholder="0x… token address" class="w-full mb-2 px-3 py-2 rounded-lg text-sm" style="background:rgba(255,255,255,.04);border:1px solid rgba(92,120,255,.2);color:#fff;">
                            <div class="flex gap-2">
                                <button onclick="adminSetTokenSupported(true)" class="token-select-btn flex-1">Enable</button>
                                <button onclick="adminSetTokenSupported(false)" class="token-select-btn flex-1">Disable</button>
                            </div>
                        </div>
                    </div>
                    <div class="mt-6 pt-6" style="border-top:1px solid rgba(255,255,255,.08);">
                        <p class="text-xs text-gray-400 mb-2">Quick setup from a known token — sends addToken() then setTokenSupported(token, true) as two real transactions, so you don't have to copy/paste addresses.</p>
                        <div class="flex flex-col sm:flex-row gap-2">
                            <select id="adminQuickToken" class="admin-select w-full sm:flex-1 px-3 py-2 rounded-lg text-sm">
                                ${TOKENS.map(t => `<option value="${t.addr}">${t.sym}${t.name ? ' — ' + t.name : ''}</option>`).join('')}
                            </select>
                            <button onclick="adminQuickWhitelistEnable()" class="token-select-btn tok-active sm:w-56">Whitelist + Enable</button>
                        </div>
                    </div>
                </div>
            </div>

            <div id="adminTab-tiers" class="admin-tab-panel">
                <div class="glass rounded-3xl p-5 sm:p-8">
                    <h3 class="text-lg font-black mb-4">Lock Tiers</h3>
                    <div class="grid sm:grid-cols-2 gap-6">
                        <div>
                            <p class="text-xs text-gray-400 mb-2">Add a new tier</p>
                            <input id="adminTierTokenAddr" type="text" placeholder="0x… token address" class="w-full mb-2 px-3 py-2 rounded-lg text-sm" style="background:rgba(255,255,255,.04);border:1px solid rgba(92,120,255,.2);color:#fff;">
                            <div class="flex gap-2 mb-2">
                                <input id="adminTierDays" type="number" placeholder="Lock days" class="w-1/2 px-3 py-2 rounded-lg text-sm" style="background:rgba(255,255,255,.04);border:1px solid rgba(92,120,255,.2);color:#fff;">
                                <input id="adminTierApr" type="number" placeholder="APR %" class="w-1/2 px-3 py-2 rounded-lg text-sm" style="background:rgba(255,255,255,.04);border:1px solid rgba(92,120,255,.2);color:#fff;">
                            </div>
                            <button onclick="adminAddTier()" class="token-select-btn tok-active w-full">Add Tier</button>
                        </div>
                        <div>
                            <p class="text-xs text-gray-400 mb-2">Edit an existing tier</p>
                            <input id="adminEditTierTokenAddr" type="text" placeholder="0x… token address" class="w-full mb-2 px-3 py-2 rounded-lg text-sm" style="background:rgba(255,255,255,.04);border:1px solid rgba(92,120,255,.2);color:#fff;">
                            <div class="flex gap-2 mb-2">
                                <input id="adminEditTierId" type="number" placeholder="Tier ID" class="w-1/2 px-3 py-2 rounded-lg text-sm" style="background:rgba(255,255,255,.04);border:1px solid rgba(92,120,255,.2);color:#fff;">
                                <input id="adminEditTierApr" type="number" placeholder="New APR %" class="w-1/2 px-3 py-2 rounded-lg text-sm" style="background:rgba(255,255,255,.04);border:1px solid rgba(92,120,255,.2);color:#fff;">
                            </div>
                            <div class="flex gap-2">
                                <button onclick="adminSetTier(true)" class="token-select-btn flex-1">Save (Active)</button>
                                <button onclick="adminSetTier(false)" class="token-select-btn flex-1">Save (Inactive)</button>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="glass rounded-3xl p-5 sm:p-8 mt-6">
                    <h3 class="text-lg font-black mb-1">Copy tiers from another token</h3>
                    <p class="text-xs text-gray-400 mb-4">Reads the source token's tiers directly from the contract (tiersLength / tierAt) and replicates each one onto the target token via real addTier() calls — e.g. give USDC/EURC/USDT the same lock tiers CENTIC currently has, whatever those actually are on-chain right now.</p>
                    <div class="grid sm:grid-cols-2 gap-6">
                        <div>
                            <p class="text-xs text-gray-400 mb-2">Source token (read tiers from)</p>
                            <select id="adminCopyTiersSrc" class="admin-select w-full px-3 py-2 rounded-lg text-sm">
                                ${TOKENS.map(t => `<option value="${t.addr}">${t.sym}${t.name ? ' — ' + t.name : ''}</option>`).join('')}
                            </select>
                        </div>
                        <div>
                            <p class="text-xs text-gray-400 mb-2">Target token (add tiers to)</p>
                            <select id="adminCopyTiersDest" class="admin-select w-full px-3 py-2 rounded-lg text-sm">
                                ${TOKENS.map(t => `<option value="${t.addr}">${t.sym}${t.name ? ' — ' + t.name : ''}</option>`).join('')}
                            </select>
                        </div>
                    </div>
                    <button onclick="adminCopyTiers()" class="token-select-btn tok-active w-full mt-4">Preview &amp; Copy Tiers</button>
                </div>
            </div>
                <div class="glass rounded-3xl p-5 sm:p-8">
                    <h3 class="text-lg font-black mb-4">Reward Pool</h3>
                    <div class="grid sm:grid-cols-2 gap-6">
                        <div>
                            <p class="text-xs text-gray-400 mb-2">Fund reward pool</p>
                            <input id="adminFundTokenAddr" type="text" placeholder="0x… token address" class="w-full mb-2 px-3 py-2 rounded-lg text-sm" style="background:rgba(255,255,255,.04);border:1px solid rgba(92,120,255,.2);color:#fff;">
                            <input id="adminFundAmount" type="number" placeholder="Amount" class="w-full mb-2 px-3 py-2 rounded-lg text-sm" style="background:rgba(255,255,255,.04);border:1px solid rgba(92,120,255,.2);color:#fff;">
                            <button onclick="adminFundRewards()" class="token-select-btn tok-active w-full">Fund</button>
                        </div>
                        <div>
                            <p class="text-xs text-gray-400 mb-2">Withdraw unreserved rewards</p>
                            <input id="adminWithdrawTokenAddr" type="text" placeholder="0x… token address" class="w-full mb-2 px-3 py-2 rounded-lg text-sm" style="background:rgba(255,255,255,.04);border:1px solid rgba(92,120,255,.2);color:#fff;">
                            <input id="adminWithdrawAmount" type="number" placeholder="Amount" class="w-full mb-2 px-3 py-2 rounded-lg text-sm" style="background:rgba(255,255,255,.04);border:1px solid rgba(92,120,255,.2);color:#fff;">
                            <button onclick="adminWithdrawUnreserved()" class="token-select-btn w-full">Withdraw</button>
                        </div>
                    </div>
                </div>
            </div>

            <div id="adminTab-lending" class="admin-tab-panel">
                <div class="glass rounded-3xl p-5 sm:p-8 mb-6">
                    <h3 class="text-lg font-black mb-1">LendingBorrowing status</h3>
                    <p class="text-gray-500 text-xs font-mono">Contract owner(): ${lendOwner || '—'}</p>
                    <div class="grid sm:grid-cols-3 gap-4 mt-4">
                        <div class="stat-chip">
                            <div class="text-gray-400 text-xs mb-1">Collateral factor</div>
                            <div class="text-xl font-black">${lendCollFactor === null ? '—' : lendCollFactor + '%'}</div>
                        </div>
                        <div class="stat-chip">
                            <div class="text-gray-400 text-xs mb-1">cirBTC price (USDC)</div>
                            <div class="text-xl font-black">${lendPrice === null ? '—' : '$' + lendPrice.toLocaleString()}</div>
                        </div>
                        <div class="stat-chip">
                            <div class="text-gray-400 text-xs mb-1">Pool USDC liquidity</div>
                            <div class="text-xl font-black">${lendPoolUsdc === null ? '—' : lendPoolUsdc.toLocaleString(undefined,{maximumFractionDigits:2})}</div>
                        </div>
                    </div>
                    <div class="mt-3 text-xs px-3 py-2 rounded-lg" style="background:rgba(234,179,8,.1);border:1px solid rgba(234,179,8,.3);color:#fde68a;">
                        ⚠ Heads up: <code>collateralFactor</code> and <code>cirBTCPriceUSDC</code> are fixed at deploy time —
                        the deployed contract has no setter function for either, so they can't be changed from this panel (or at all) right now.
                        <code>fundPool()</code> also has no <code>onlyOwner</code> guard in the contract — any wallet can call it, not just the owner.
                    </div>
                </div>

                <div class="glass rounded-3xl p-5 sm:p-8">
                    <h3 class="text-lg font-black mb-4">Fund lending pool</h3>
                    <p class="text-xs text-gray-400 mb-2">Top up USDC liquidity so users have something to borrow against their cirBTC collateral.</p>
                    <input id="adminLendFundAmount" type="number" placeholder="Amount (USDC)" class="w-full mb-2 px-3 py-2 rounded-lg text-sm" style="background:rgba(255,255,255,.04);border:1px solid rgba(92,120,255,.2);color:#fff;">
                    <button onclick="adminFundLendingPool()" class="token-select-btn tok-active w-full">Fund Pool</button>
                </div>
            </div>

            <div id="adminTab-settings" class="admin-tab-panel">
                <div class="glass rounded-3xl p-5 sm:p-8 mb-6">
                    <h3 class="text-lg font-black mb-4">Protocol Settings</h3>
                    <div class="grid sm:grid-cols-2 gap-6">
                        <div>
                            <p class="text-xs text-gray-400 mb-2">Treasury address</p>
                            <input id="adminTreasuryAddr" type="text" placeholder="0x… new treasury" class="w-full mb-2 px-3 py-2 rounded-lg text-sm" style="background:rgba(255,255,255,.04);border:1px solid rgba(92,120,255,.2);color:#fff;">
                            <button onclick="adminSetTreasury()" class="token-select-btn w-full">Update Treasury</button>
                        </div>
                        <div>
                            <p class="text-xs text-gray-400 mb-2">Early-exit penalty (0–30%)</p>
                            <input id="adminPenaltyPct" type="number" placeholder="Penalty %" class="w-full mb-2 px-3 py-2 rounded-lg text-sm" style="background:rgba(255,255,255,.04);border:1px solid rgba(92,120,255,.2);color:#fff;">
                            <button onclick="adminSetPenalty()" class="token-select-btn w-full">Update Penalty</button>
                        </div>
                    </div>
                </div>

                <div class="glass rounded-3xl p-5 sm:p-8">
                    <h3 class="text-lg font-black mb-2">Contract Addresses</h3>
                    <div>${contractRows}</div>
                </div>
            </div>

            <div id="adminTab-danger" class="admin-tab-panel">
                <div class="glass rounded-3xl p-5 sm:p-8" style="border-color:rgba(239,68,68,.3);">
                    <h3 class="text-lg font-black mb-2" style="color:#fca5a5;">⚠ Danger Zone</h3>
                    <p class="text-gray-400 text-xs mb-4">Pausing blocks new stakes protocol-wide. Existing stakes remain claimable/unstakeable — this does not touch staker principal.</p>
                    <div class="flex gap-2">
                        <button onclick="adminTogglePause(true)" class="token-select-btn flex-1">⏸ Pause Staking</button>
                        <button onclick="adminTogglePause(false)" class="token-select-btn flex-1">▶ Unpause Staking</button>
                    </div>
                </div>
            </div>
        `;
        adminShowTab(adminActiveTab);
    }

    async function showStake() {

        hideAllOverlays();
        document.getElementById('stakeView').classList.add('open');
        document.body.style.overflow = 'hidden';
        setNavActive('navStake');

        if (!stakingConfigured()) {
            stakeTokens = previewStakeTokens();
            selectedStakeToken = stakeTokens.length > 0 ? stakeTokens[0].addr : null;
            renderStakeTokenPicker();
            stakeTiers = previewStakeTiers();
            selectedTierId = stakeTiers.length > 0 ? stakeTiers[0].id : null;
            renderTierGrid();
            const note = document.getElementById('stakeTokenNote');
            note.innerText = 'Preview only — staking contract not deployed yet. Tiers/APR shown are sample values. Deploy ArcenticStakingMultiToken.sol, call addTier(), and update CONTRACT_ADDRS.ArcenticStaking to go live.';
            note.classList.remove('hidden');
            document.querySelectorAll('.stake-token-unit').forEach(el => el.innerText = selectedStakeToken ? currentStakeTokenMeta().sym : '—');
            updateStakePreview();
            document.getElementById('btnStake').innerText = 'Not deployed yet';
            document.getElementById('btnStake').disabled = true;
            return;
        }
        document.getElementById('stakeTokenNote').classList.add('hidden');

        await loadStakeTokens();
        // These three don't depend on each other (only on selectedStakeToken,
        // which loadStakeTokens already set) — run them together instead of
        // waiting on each one in turn.
        const tasks = [loadStakeTiersForSelected(), refreshStakeStats()];
        if (isConnected) tasks.push(loadMyStakes());
        await Promise.all(tasks);
        updateStakeButtonLabel();
    }

    /* Load every token the owner has whitelisted (and still has staking enabled) */
    async function loadStakeTokens() {
        try {
            const provider = readOnlyProvider() || (window.ethereum ? new ethers.providers.Web3Provider(window.ethereum) : null);
            if (!provider) throw new Error('No RPC provider available');
            const staking = new ethers.Contract(CONTRACT_ADDRS.ArcenticStaking, STAKING_ABI, provider);
            const count = (await staking.supportedTokensLength()).toNumber();

            // Fetch every token's address, support flag, and metadata concurrently
            // instead of one at a time — with several whitelisted tokens this was
            // N sequential RPC round-trips, which is what made opening Stake feel slow.
            const addrs = await Promise.all(Array.from({ length: count }, (_, i) => staking.supportedTokenAt(i)));
            const entries = await Promise.all(addrs.map(async (addr) => {
                const isSupported = await staking.tokenSupported(addr);
                if (!isSupported) return null; // owner paused new stakes for this token
                const meta = await getStakeTokenMeta(addr, provider);
                return { addr, ...meta };
            }));
            stakeTokens = entries.filter(Boolean);
            if (!selectedStakeToken || !stakeTokens.some(t => t.addr === selectedStakeToken)) {
                selectedStakeToken = stakeTokens.length > 0 ? stakeTokens[0].addr : null;
            }
            renderStakeTokenPicker();
        } catch (err) {
            console.error('loadStakeTokens error:', err);
            const sel = document.getElementById('stakeTokenPicker');
            sel.innerHTML = `<option value="">Couldn't load tokens: ${err.message || err}</option>`;
            sel.disabled = true;
        }
    }

    function renderStakeTokenPicker() {
        const sel = document.getElementById('stakeTokenPicker');
        if (stakeTokens.length === 0) {
            sel.innerHTML = '<option value="">No tokens whitelisted for staking yet.</option>';
            sel.disabled = true;
            return;
        }
        sel.disabled = false;
        sel.innerHTML = stakeTokens.map(tok => {
            const label = escapeHtml(tok.sym + (tok.name ? ' — ' + tok.name : '') + (tok.preview ? ' (preview)' : ''));
            const selected = tok.addr === selectedStakeToken ? ' selected' : '';
            return `<option value="${tok.addr}"${selected}>${label}</option>`;
        }).join('');
    }

    async function selectStakeToken(addr) {
        if (selectedStakeToken === addr) return;
        selectedStakeToken = addr;
        selectedTierId = null;
        document.getElementById('stakeAmount').value = '';
        renderStakeTokenPicker();
        document.querySelectorAll('.stake-token-unit').forEach(el => el.innerText = currentStakeTokenMeta().sym || '—');

        if (!stakingConfigured()) {
            // Preview mode: no live contract to query, just reflect the pick in the UI.
            stakeTiers = previewStakeTiers();
            selectedTierId = stakeTiers.length > 0 ? stakeTiers[0].id : null;
            renderTierGrid();
            updateStakePreview();
            return;
        }

        // Same as showStake(): these are independent of each other, so run
        // them together instead of one after another — this is the delay
        // you feel every time you pick a different token in the dropdown.
        const tasks = [loadStakeTiersForSelected(), refreshStakeStats()];
        if (isConnected) tasks.push(loadMyStakes());
        await Promise.all(tasks);
        updateStakePreview();
        updateStakeButtonLabel();
    }

    async function loadStakeTiersForSelected() {
        if (!selectedStakeToken) {
            stakeTiers = [];
            renderTierGrid();
            return;
        }
        try {
            const provider = readOnlyProvider() || (window.ethereum ? new ethers.providers.Web3Provider(window.ethereum) : null);
            if (!provider) throw new Error('No RPC provider available');
            const staking = new ethers.Contract(CONTRACT_ADDRS.ArcenticStaking, STAKING_ABI, provider);
            const count = (await staking.tiersLength(selectedStakeToken)).toNumber();
            const tiers = await Promise.all(
                Array.from({ length: count }, async (_, i) => {
                    const t = await staking.tierAt(selectedStakeToken, i);
                    return { id: i, lockDuration: t.lockDuration.toNumber(), aprBps: t.aprBps.toNumber(), active: t.active };
                })
            );
            stakeTiers = tiers;
            const firstActive = tiers.find(t => t.active);
            selectedTierId = firstActive ? firstActive.id : null;
            renderTierGrid();
        } catch (err) {
            console.error('loadStakeTiersForSelected error:', err);
            const rateLimited = err && (err.code === -32005 ||
                (err.error && err.error.code === -32005) ||
                /rate limit/i.test(err.message || ''));
            const label = rateLimited
                ? "RPC is rate-limited right now — please retry in a moment."
                : `Couldn't load tiers: ${err.message || err}`;
            document.getElementById('stakeTierGrid').innerHTML =
                `<div class="text-center col-span-3">
                    <p class="text-red-400 text-sm mb-2">${label}</p>
                    <button onclick="loadStakeTiersForSelected()" class="text-xs px-3 py-1.5 rounded-lg" style="background:rgba(92,120,255,.15);border:1px solid rgba(92,120,255,.3);color:#fff;">Retry</button>
                </div>`;
        }
    }

    function renderTierGrid() {
        const grid = document.getElementById('stakeTierGrid');
        grid.innerHTML = '';
        if (stakeTiers.length === 0) {
            grid.innerHTML = '<p class="text-gray-500 text-sm text-center col-span-3">No tiers configured yet.</p>';
            return;
        }
        stakeTiers.forEach(t => {
            const card = document.createElement('div');
            card.className = 'tier-card' + (t.id === selectedTierId ? ' tier-active' : '') + (!t.active ? ' opacity-40 pointer-events-none' : '');
            card.innerHTML = `
                <div class="text-2xl font-black">${fmtDuration(t.lockDuration)}</div>
                <div class="text-green-400 font-bold text-sm mt-1">${fmtApr(t.aprBps)} APR</div>
                <div class="text-gray-500 text-xs mt-1">${t.preview ? 'Preview' : (t.active ? 'Open' : 'Closed')}</div>
            `;
            card.onclick = () => { selectedTierId = t.id; renderTierGrid(); updateStakePreview(); };
            grid.appendChild(card);
        });
    }

    async function refreshStakeStats() {
        try {
            document.querySelectorAll('.stake-token-unit').forEach(el => el.innerText = '—');
            if (!selectedStakeToken) {
                document.getElementById('stakeTotalStaked').innerText = '—';
                document.getElementById('stakeTokenBal').innerText = '—';
                return;
            }
            const meta = currentStakeTokenMeta();
            document.querySelectorAll('.stake-token-unit').forEach(el => el.innerText = meta.sym || '—');
            document.getElementById('stakeAmountLabel').innerText = (meta.sym || 'Token') + ' Amount';

            const provider = readOnlyProvider() || (window.ethereum ? new ethers.providers.Web3Provider(window.ethereum) : null);
            if (!provider) return;
            const staking = new ethers.Contract(CONTRACT_ADDRS.ArcenticStaking, STAKING_ABI, provider);
            const total = await staking.totalStakedOf(selectedStakeToken);
            document.getElementById('stakeTotalStaked').innerText = fmtBal(ethers.utils.formatUnits(total, meta.decimals));

            if (isConnected) {
                const erc20 = new ethers.Contract(selectedStakeToken, ERC20_ABI, provider);
                const bal = await erc20.balanceOf(currentAccount);
                document.getElementById('stakeTokenBal').innerText = fmtBal(ethers.utils.formatUnits(bal, meta.decimals));
            } else {
                document.getElementById('stakeTokenBal').innerText = '—';
                document.getElementById('stakeYourStaked').innerText = '—';
                document.getElementById('stakeYourClaimable').innerText = '—';
            }
        } catch (err) {
            console.error('refreshStakeStats error:', err);
        }
    }

    function setStakeMax() {
        const balText = document.getElementById('stakeTokenBal').innerText;
        if (balText && balText !== '—') {
            document.getElementById('stakeAmount').value = balText.replace(/,/g, '');
            updateStakePreview();
        }
    }

    function updateStakePreview() {
        const amtStr = document.getElementById('stakeAmount').value;
        const tier = stakeTiers.find(t => t.id === selectedTierId);
        const meta = currentStakeTokenMeta();
        const unlockEl = document.getElementById('stakePreviewUnlock');
        const rewardEl = document.getElementById('stakePreviewReward');
        if (!tier || !amtStr || isNaN(parseFloat(amtStr)) || parseFloat(amtStr) <= 0) {
            unlockEl.innerText = '—';
            rewardEl.innerText = '—';
            return;
        }
        const unlockDate = new Date(Date.now() + tier.lockDuration * 1000);
        unlockEl.innerText = unlockDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        const amt = parseFloat(amtStr);
        const reward = (amt * tier.aprBps * tier.lockDuration) / (10000 * 365 * 86400);
        rewardEl.innerText = fmtBal(reward.toString()) + ' ' + (meta.sym || '');
    }

    function updateStakeButtonLabel() {
        const btn = document.getElementById('btnStake');
        if (!stakingConfigured()) return;
        const meta = currentStakeTokenMeta();
        btn.innerText = isConnected ? ('Stake ' + (meta.sym || '')) : 'Connect Wallet';
    }

    async function doStake() {
        if (!window.ethereum) { alert('Install a wallet like MetaMask first.'); return; }
        if (!isConnected) { await connectWallet(); updateStakeButtonLabel(); return; }
        if (!stakingConfigured()) return;

        const status = document.getElementById('stakeStatus');
        const btn = document.getElementById('btnStake');
        const setStatus = (msg, hide = false) => { status.innerText = msg; status.classList.toggle('hidden', hide); };

        if (!selectedStakeToken) { setStatus('Pick a token first.'); return; }
        const tier = stakeTiers.find(t => t.id === selectedTierId);
        if (!tier) { setStatus('Pick a lock tier first.'); return; }
        const amtStr = document.getElementById('stakeAmount').value;
        if (!amtStr || parseFloat(amtStr) <= 0) { setStatus('Enter an amount to stake.'); return; }

        const meta = currentStakeTokenMeta();
        btn.disabled = true;
        btn.style.opacity = '.6';
        let toast = null;
        try {
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const signer = provider.getSigner();
            const amtWei = ethers.utils.parseUnits(parseFloat(amtStr).toFixed(meta.decimals), meta.decimals);
            const onRpcRetry = (n, max) => setStatus(`⏳ RPC hiccup — retrying (${n}/${max})…`);

            setStatus(`⏳ Step 1/2 — Approving ${meta.sym} spend…`);
            toast = showToast('pending', `Approving ${meta.sym}`, 'Requesting spend approval…');
            const tokenContract = new ethers.Contract(selectedStakeToken, ERC20_ABI, signer);
            const allowance = await withRpcRetry(
                () => tokenContract.allowance(currentAccount, CONTRACT_ADDRS.ArcenticStaking),
                { onRetry: onRpcRetry }
            );
            if (allowance.lt(amtWei)) {
                const approveTx = await withRpcRetry(
                    () => tokenContract.approve(CONTRACT_ADDRS.ArcenticStaking, ethers.constants.MaxUint256),
                    { onRetry: onRpcRetry }
                );
                updateToast(toast, 'pending', 'Waiting for Approval', 'Confirming approval on-chain…');
                setStatus('⏳ Step 1/2 — Waiting for approval confirmation…');
                await withRpcRetry(() => approveTx.wait(), { onRetry: onRpcRetry });
            }

            setStatus('⏳ Step 2/2 — Sending stake transaction…');
            updateToast(toast, 'pending', 'Staking', `Staking ${amtStr} ${meta.sym} for ${fmtDuration(tier.lockDuration)}…`);
            const staking = new ethers.Contract(CONTRACT_ADDRS.ArcenticStaking, STAKING_ABI, signer);
            const tx = await withRpcRetry(() => staking.stake(selectedStakeToken, tier.id, amtWei), { onRetry: onRpcRetry });
            await withRpcRetry(() => tx.wait(), { onRetry: onRpcRetry });

            updateToast(toast, 'success', 'Staked!', `Locked ${amtStr} ${meta.sym} for ${fmtDuration(tier.lockDuration)}.`, 6000);
            setStatus('✅ Staked successfully.');
            document.getElementById('stakeAmount').value = '';
            updateStakePreview();
            await refreshStakeStats();
            await loadMyStakes();
        } catch (err) {
            console.error('doStake error:', err);
            const msg = (err && err.reason) || (err && err.message) || String(err);
            setStatus('❌ ' + msg);
            if (toast) updateToast(toast, 'error', 'Stake Failed', msg, 6000);
            else showToast('error', 'Stake Failed', msg, 6000);
        } finally {
            btn.disabled = false;
            btn.style.opacity = '1';
        }
    }

    /* Lists ALL of the user's stakes across every token they've ever staked (each
       row shows its own token symbol). The "Your Staked"/"Claimable" stat pills at
       the top only total the currently-selected token, to match "Total Staked". */
    async function loadMyStakes() {
        const list = document.getElementById('myStakesList');
        if (!isConnected || !stakingConfigured()) {
            list.innerHTML = '<p class="text-gray-500 text-sm text-center py-6">Connect your wallet to see your stakes.</p>';
            return;
        }
        list.innerHTML = '<p class="text-gray-500 text-sm text-center py-6">Loading…</p>';
        try {
            const provider = readOnlyProvider() || new ethers.providers.Web3Provider(window.ethereum);
            const staking = new ethers.Contract(CONTRACT_ADDRS.ArcenticStaking, STAKING_ABI, provider);
            const count = (await staking.stakeCountOf(currentAccount)).toNumber();

            const selMeta = currentStakeTokenMeta();
            if (count === 0) {
                list.innerHTML = '<p class="text-gray-500 text-sm text-center py-6">No stakes yet — open one above.</p>';
                document.getElementById('stakeYourStaked').innerText = '0';
                document.getElementById('stakeYourClaimable').innerText = '0';
                return;
            }

            let selTotalStaked = ethers.BigNumber.from(0);
            let selTotalClaimable = ethers.BigNumber.from(0);
            list.innerHTML = '';
            let rendered = 0;

            // Fetch every stake's raw data concurrently, figure out which ones
            // are still active, then fetch reward/unlock/meta for those
            // concurrently too — this used to be up to 4 sequential RPC calls
            // PER stake, which is what made "My Stakes" slow to render for
            // wallets with several open positions. Order is preserved so the
            // list renders in the same index order as before.
            const idxs = Array.from({ length: count }, (_, i) => i);
            const rawStakes = await Promise.all(idxs.map(i => staking.stakesOf(currentAccount, i)));
            const activeIdxs = idxs.filter(i => !rawStakes[i].withdrawn);
            const details = await Promise.all(activeIdxs.map(async (i) => {
                const s = rawStakes[i];
                const [pending, unlocked, meta] = await Promise.all([
                    staking.pendingReward(currentAccount, i),
                    staking.isUnlocked(currentAccount, i),
                    getStakeTokenMeta(s.token, provider)
                ]);
                return { i, s, pending, unlocked, meta };
            }));

            for (const { i, s, pending, unlocked, meta } of details) {
                if (selectedStakeToken && s.token.toLowerCase() === selectedStakeToken.toLowerCase()) {
                    selTotalStaked = selTotalStaked.add(s.amount);
                    selTotalClaimable = selTotalClaimable.add(pending);
                }

                const unlockDate = new Date((s.startTime.toNumber() + s.lockDuration.toNumber()) * 1000);
                const row = document.createElement('div');
                row.className = 'stake-row';
                row.innerHTML = `
                    <div>
                        <div class="font-bold">${fmtBal(ethers.utils.formatUnits(s.amount, meta.decimals))} ${escapeHtml(meta.sym)}</div>
                        <div class="text-xs text-gray-400 mt-0.5">${fmtApr(s.aprBps)} APR &middot; ${unlocked ? 'Unlocked' : 'Unlocks ' + unlockDate.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' })}</div>
                        <div class="text-xs text-green-400 mt-0.5">Claimable: ${fmtBal(ethers.utils.formatUnits(pending, meta.decimals))} ${escapeHtml(meta.sym)}</div>
                    </div>
                    <div class="flex gap-2 flex-wrap">
                        <button class="glass px-3 py-2 rounded-xl text-xs hover:border-white/30 transition" onclick="doClaimReward(${i})">Claim</button>
                        ${unlocked
                            ? `<button class="glass px-3 py-2 rounded-xl text-xs hover:border-white/30 transition" onclick="doUnstake(${i})">Unstake</button>`
                            : `<button class="glass px-3 py-2 rounded-xl text-xs hover:border-white/30 transition text-red-400" onclick="doEmergencyUnstake(${i})">Exit early</button>`}
                    </div>
                `;
                list.appendChild(row);
                rendered++;
            }

            document.getElementById('stakeYourStaked').innerText = fmtBal(ethers.utils.formatUnits(selTotalStaked, selMeta.decimals || 18));
            document.getElementById('stakeYourClaimable').innerText = fmtBal(ethers.utils.formatUnits(selTotalClaimable, selMeta.decimals || 18));

            if (rendered === 0) {
                list.innerHTML = '<p class="text-gray-500 text-sm text-center py-6">No active stakes — open one above.</p>';
            }
        } catch (err) {
            console.error('loadMyStakes error:', err);
            list.innerHTML = `<p class="text-red-400 text-sm text-center py-6">Couldn't load stakes: ${err.message || err}</p>`;
        }
    }

    async function doClaimReward(stakeId) {
        await runStakeAction(
            (staking) => staking.claimReward(stakeId),
            'Claiming Reward', 'Reward claimed!'
        );
    }

    async function doUnstake(stakeId) {
        await runStakeAction(
            (staking) => staking.unstake(stakeId),
            'Unstaking', 'Unstaked — principal + reward returned.'
        );
    }

    async function doEmergencyUnstake(stakeId) {
        if (!confirm('Exiting before the lock ends forfeits this stake\'s accrued reward, and may incur an early-exit penalty. Continue?')) return;
        await runStakeAction(
            (staking) => staking.emergencyUnstake(stakeId),
            'Exiting Early', 'Exited — principal returned (reward forfeited).'
        );
    }

    async function runStakeAction(txFn, pendingLabel, successLabel) {
        if (!window.ethereum || !isConnected) { alert('Connect your wallet first.'); return; }
        let toast = showToast('pending', pendingLabel, 'Sending transaction…');
        try {
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const signer = provider.getSigner();
            const staking = new ethers.Contract(CONTRACT_ADDRS.ArcenticStaking, STAKING_ABI, signer);
            const onRpcRetry = (n, max) => updateToast(toast, 'pending', pendingLabel, `RPC hiccup — retrying (${n}/${max})…`);
            const tx = await withRpcRetry(() => txFn(staking), { onRetry: onRpcRetry });
            updateToast(toast, 'pending', pendingLabel, 'Waiting for confirmation…');
            await withRpcRetry(() => tx.wait(), { onRetry: onRpcRetry });
            updateToast(toast, 'success', 'Success', successLabel, 6000);
            await refreshStakeStats();
            await loadMyStakes();
        } catch (err) {
            console.error('runStakeAction error:', err);
            const msg = (err && err.reason) || (err && err.message) || String(err);
            updateToast(toast, 'error', 'Transaction Failed', msg, 6000);
        }
    }

    /* Minimal ERC-20 ABI (approve + balanceOf + decimals) */
    const ERC20_ABI = [
        'function approve(address spender, uint256 amount) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)',
        'function balanceOf(address account) view returns (uint256)',
        'function decimals() view returns (uint8)',
    ];

    /* ArcenticMultiPool ABI — swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut) */
    /* ArcenticMultiPool — verified ABI */
    const POOL_ABI = [
        'function swap(address _tokenIn, address _tokenOut, uint256 _amountIn) returns (uint256 amountOut)',
        'function reserves(address) view returns (uint256)',
        'function addLiquidity(address _token, uint256 _amount)',
        'function removeLiquidity(address _token, uint256 _amount)',
        'function lpBalance(address user, address token) view returns (uint256)',
    ];

    /* ── Swap logic ── */
    const TOKENS = [
        { sym:'USDC',   icon:'<img src=\"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiMyNzc1Q0EiLz48cGF0aCBkPSJNMjAuMDIyIDE4LjEyNGMwLTIuMTI0LTEuMjgtMi44NTItMy44NC0zLjE1Ni0xLjgyOC0uMjM0LTIuMTk0LS43MDItMi4xOTQtMS41MTggMC0uODE2LjU0Ni0xLjM2MiAxLjYzMi0xLjM2MiAuOTc1IDAgMS41MjEuMzUxIDEuNzk0IDEuMjE4YS4zOS4zOSAwIDAgMCAuMzY0LjI3M2guODMyYS4zNjQuMzY0IDAgMCAwIC4zNjQtLjM5Yy0uMjM0LTEuNDMtMS4xNy0yLjMtMi42MTItMi41MzRWOS44NzJhLjM5LjM5IDAgMCAwLS4zOS0uMzloLS43OGEuMzkuMzkgMCAwIDAtLjM5LjM5di43OGMtMS41Ni4yNzMtMi41NzQgMS4zMjYtMi41NzQgMi43MyAwIDIuMDQ2IDEuMjQ4IDIuOCAzLjgwOCAzLjEwNCAxLjcxNi4yNzMgMi4yMS42NjMgMi4yMSAxLjU5NnMtLjc4IDEuNTYtMS45NSAxLjU2Yy0xLjUzIDAtMi4wNjctLjY2My0yLjI2Mi0xLjU2YS4zOS4zOSAwIDAgMC0uMzktLjMxMmgtLjg1OGEuMzkuMzkgMCAwIDAtLjM5LjM5Yy4xOTUgMS42MzggMS4zMjYgMi44IDMuMDQyIDMuMDd2LjgyYS4zOS4zOSAwIDAgMCAuMzkuMzloLjc4YS4zOS4zOSAwIDAgMCAuMzktLjM5di0uODJjMS43MTYtLjMxMiAyLjczLTEuNCAyLjczLTIuODg2eiIgZmlsbD0iI2ZmZiIvPjxwYXRoIGQ9Ik0xNiA0QzkuMzczIDQgNCA5LjM3MyA0IDE2czUuMzczIDEyIDEyIDEyIDEyLTUuMzczIDEyLTEyUzIyLjYyNyA0IDE2IDR6bTAgMjEuNzVjLTUuMzg1IDAtOS43NS00LjM2NS05Ljc1LTkuNzVTMTAuNjE1IDYuMjUgMTYgNi4yNSAyNS43NSAxMC42MTUgMjUuNzUgMTYgMjEuMzg1IDI1Ljc1IDE2IDI1Ljc1eiIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==\" style=\"width:22px;height:22px;border-radius:50%;vertical-align:middle;\" alt=\"\">',   addr: CONTRACT_ADDRS.USDC,   decimals:6,  rate:1,       name:'USD Coin'    },
        { sym:'EURC',   icon:'<img src=\"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiMxQTlFNkQiLz48dGV4dCB4PSIxNiIgeT0iMjEiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtZmFtaWx5PSJBcmlhbCxzYW5zLXNlcmlmIiBmb250LXNpemU9IjE2IiBmb250LXdlaWdodD0iYm9sZCIgZmlsbD0iI2ZmZiI+4oKsPC90ZXh0PjxwYXRoIGQ9Ik0xNiA0QzkuMzczIDQgNCA5LjM3MyA0IDE2czUuMzczIDEyIDEyIDEyIDEyLTUuMzczIDEyLTEyUzIyLjYyNyA0IDE2IDR6bTAgMjEuNzVjLTUuMzg1IDAtOS43NS00LjM2NS05Ljc1LTkuNzVTMTAuNjE1IDYuMjUgMTYgNi4yNSAyNS43NSAxMC42MTUgMjUuNzUgMTYgMjEuMzg1IDI1Ljc1IDE2IDI1Ljc1eiIgZmlsbD0iI2ZmZiIgb3BhY2l0eT0iLjYiLz48L3N2Zz4=\" style=\"width:22px;height:22px;border-radius:50%;vertical-align:middle;\" alt=\"\">',   addr: CONTRACT_ADDRS.EURC,   decimals:6,  rate:0.9290,  name:'Euro Coin'   },
        { sym:'USDT',   icon:'<img src=\"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiMyNkExN0IiLz48cGF0aCBkPSJNMTcuOTIyIDE3LjM4M3YtLjAwMmMtLjExLjAwOC0uNjc3LjA0Mi0xLjk0Mi4wNDItMS4wMSAwLTEuNzIxLS4wMy0xLjk3MS0uMDQydi4wMDNjLTMuODg4LS4xNzEtNi43OS0uODQ4LTYuNzktMS42NjYgMC0uODE2IDIuOTAyLTEuNDk0IDYuNzktMS42Njh2Mi42NTVjLjI1NC4wMTguOTgyLjA2MSAxLjk4OC4wNjEgMS4yMDcgMCAxLjgxMi0uMDUgMS45MjUtLjA2di0yLjY1NGMzLjg4LjE3MyA2Ljc3NS44NTIgNi43NzUgMS42NjYgMCAuODE2LTIuODk1IDEuNDkzLTYuNzc1IDEuNjY1em0wLTMuNjAzdi0yLjM3OGg1LjQxNFY4LjVIOC42NjR2Mi45MDJoNS40MTR2Mi4zNzdjLTQuNC4yMDItNy43MDggMS4wNzQtNy43MDggMi4xMjcgMCAxLjA1MiAzLjMwOCAxLjkyMyA3LjcwOCAyLjEyNnY3LjYwN2gzLjg0NHYtNy42MDhjNC4zOTEtLjIwMiA3LjY5Mi0xLjA3MyA3LjY5Mi0yLjEyNSAwLTEuMDUyLTMuMzAxLTEuOTI0LTcuNjkyLTIuMTI2eiIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==\" style=\"width:22px;height:22px;border-radius:50%;vertical-align:middle;\" alt=\"\">',   addr: CONTRACT_ADDRS.USDT,   decimals:6,  rate:0.9998,  name:'Tether USD'  },
        { sym:'CENTIC', icon:'<img src=\"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+CiAgPGRlZnM+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImFyYy1nIiB4MT0iMCUiIHkxPSIwJSIgeDI9IjEwMCUiIHkyPSIxMDAlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzM0NzhmZiIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjUwJSIgc3RvcC1jb2xvcj0iIzhiNWNmNiIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiNkNjZiZmYiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgPC9kZWZzPgogIDxjaXJjbGUgY3g9IjE2IiBjeT0iMTYiIHI9IjE1IiBmaWxsPSIjMDcwYzIzIi8+CiAgPGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTQuMjUiIGZpbGw9Im5vbmUiIHN0cm9rZT0idXJsKCNhcmMtZykiIHN0cm9rZS13aWR0aD0iMS41Ii8+CiAgPHBhdGggZD0iTTE2IDcuNSBMMjIuNSAyMi41IEwxOC43IDIyLjUgTDE2IDE1LjggTDEzLjMgMjIuNSBMOS41IDIyLjUgWiIgZmlsbD0idXJsKCNhcmMtZykiLz4KICA8cGF0aCBkPSJNOS41IDIwLjMgQzEyIDE3LjggMjAgMTcuOCAyMi41IDIwLjMiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2U2ZDlmZiIgc3Ryb2tlLXdpZHRoPSIxLjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K\" style=\"width:22px;height:22px;border-radius:50%;vertical-align:middle;\" alt=\"\">', addr: CONTRACT_ADDRS.CENTIC, decimals:18, rate:0.0012,  name:'Arcentic'    },
    ];

    let swapFrom = 0, swapTo = 1; // indices into TOKENS
    let tokenMenuTarget = null;   // 'from' | 'to'
    let tokenBalances = {};       // cache: sym → formatted string
    let resolvedDecimals = {};    // cache: addr → decimals fetched from chain

    /* resolve decimals — uses on-chain value as source of truth, falls back to TOKENS entry */
    async function getDecimals(tok) {
        if (resolvedDecimals[tok.addr] !== undefined) return resolvedDecimals[tok.addr];
        try {
            const provider = readOnlyProvider() || new ethers.providers.Web3Provider(window.ethereum);
            const erc20 = new ethers.Contract(tok.addr, ERC20_ABI, provider);
            const dec = await erc20.decimals();
            resolvedDecimals[tok.addr] = dec;
            return dec;
        } catch {
            resolvedDecimals[tok.addr] = tok.decimals;
            return tok.decimals;
        }
    }

    /* fetch on-chain ERC-20 balance */
    async function fetchTokenBalance(tok, account) {
        try {
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const erc20 = new ethers.Contract(tok.addr, ERC20_ABI, provider);
            const dec = await getDecimals(tok);
            const raw = await erc20.balanceOf(account);
            return fmtBal(ethers.utils.formatUnits(raw, dec));
        } catch { return '0.0000'; }
    }

    async function refreshSwapBalances() {
        if (!isConnected) {
            document.getElementById('swapFromBal').innerText = 'Balance: —';
            document.getElementById('swapToBal').innerText   = 'Balance: —';
            return;
        }
        const fromTok = TOKENS[swapFrom];
        const toTok   = TOKENS[swapTo];
        const [bFrom, bTo] = await Promise.all([
            fetchTokenBalance(fromTok, currentAccount),
            fetchTokenBalance(toTok,   currentAccount),
        ]);
        tokenBalances[fromTok.sym] = bFrom;
        tokenBalances[toTok.sym]   = bTo;
        document.getElementById('swapFromBal').innerText = 'Balance: ' + bFrom;
        document.getElementById('swapToBal').innerText   = 'Balance: ' + bTo;
    }

    function updateSwapBalances() {
        if (!isConnected) {
            document.getElementById('swapFromBal').innerText = 'Balance: —';
            document.getElementById('swapToBal').innerText   = 'Balance: —';
            return;
        }
        // Show cached first, then refresh async
        const f = TOKENS[swapFrom], t = TOKENS[swapTo];
        document.getElementById('swapFromBal').innerText = 'Balance: ' + (tokenBalances[f.sym] || '…');
        document.getElementById('swapToBal').innerText   = 'Balance: ' + (tokenBalances[t.sym] || '…');
        refreshSwapBalances();
    }

    async function getQuote() {
        const amtIn = parseFloat(document.getElementById('swapFromAmt').value) || 0;
        if (!amtIn) { document.getElementById('swapToAmt').value = ''; return; }

        const fromTok = TOKENS[swapFrom];
        const toTok   = TOKENS[swapTo];

        // Use reserves to compute price: amountOut = amountIn * reserveOut / reserveIn
        // (constant-product approximation, good for small amounts relative to pool size)
        if (isConnected && window.ethereum) {
            try {
                const provider = new ethers.providers.Web3Provider(window.ethereum);
                const pool = new ethers.Contract(CONTRACT_ADDRS.ArcenticMultiPool, POOL_ABI, provider);
                const decFrom = await getDecimals(fromTok);
                const decTo   = await getDecimals(toTok);
                const [resInRaw, resOutRaw] = await Promise.all([
                    pool.reserves(fromTok.addr),
                    pool.reserves(toTok.addr),
                ]);
                const resIn  = parseFloat(ethers.utils.formatUnits(resInRaw,  decFrom));
                const resOut = parseFloat(ethers.utils.formatUnits(resOutRaw, decTo));
                if (resIn > 0 && resOut > 0) {
                    const amtOut = amtIn * resOut / resIn;
                    document.getElementById('swapToAmt').value = amtOut.toFixed(6);
                    const rate = (resOut / resIn).toFixed(6);
                    document.getElementById('swapRate').innerText = `1 ${fromTok.sym} ≈ ${rate} ${toTok.sym}`;
                    return;
                }
            } catch { /* fall through to static fallback */ }
        }

        // Fallback: static rate
        const rate = toTok.rate / fromTok.rate;
        document.getElementById('swapToAmt').value = (amtIn * rate).toFixed(6);
        document.getElementById('swapRate').innerText = `1 ${fromTok.sym} ≈ ${rate.toFixed(6)} ${toTok.sym}`;
    }

    function calcSwapOut() { getQuote(); }

    /* ══════════════════════════════════════════════════
       SPOT TRADING — candlestick chart + AMM order book
       Harga & depth dihitung LANGSUNG dari reserves pool
       (ArcenticMultiPool) yang sama dengan Swap — jujur,
       tidak ada data yang dikarang. Candle disimpan lokal
       (localStorage) dari sampel harga live selama app
       dibuka; order eksekusi memakai jalur approve+swap
       yang sama seperti fitur Swap.
    ══════════════════════════════════════════════════ */
    const SPOT_PAIRS = [
        { base: 3, quote: 0 }, // CENTIC / USDC
        { base: 3, quote: 1 }, // CENTIC / EURC
        { base: 1, quote: 0 }, // EURC / USDC
        { base: 2, quote: 0 }, // USDT / USDC
    ];
    let spotPairIdx = 0;
    let spotSide = 'buy';
    let spotOrderType = 'market';
    let spotPollTimer = null;
    let spotLimitTimer = null;
    let spotLastMidPrice = null;

    function spotPair() {
        const p = SPOT_PAIRS[spotPairIdx];
        return { base: TOKENS[p.base], quote: TOKENS[p.quote] };
    }

    function spotCandleKey() {
        const p = spotPair();
        return 'arcentic_candles_' + p.base.sym + '_' + p.quote.sym;
    }

    function loadSpotCandles() {
        try { return JSON.parse(localStorage.getItem(spotCandleKey())) || []; }
        catch { return []; }
    }
    function saveSpotCandles(candles) {
        try { localStorage.setItem(spotCandleKey(), JSON.stringify(candles.slice(-120))); } catch {}
    }

    function populateSpotPairSelect() {
        const sel = document.getElementById('spotPairSelect');
        if (!sel) return;
        sel.innerHTML = SPOT_PAIRS.map((p, i) => {
            const b = TOKENS[p.base], q = TOKENS[p.quote];
            return `<option value="${i}">${b.sym} / ${q.sym}</option>`;
        }).join('');
        sel.value = spotPairIdx;
    }

    function setSpotPair(idxStr) {
        spotPairIdx = parseInt(idxStr, 10) || 0;
        spotLastMidPrice = null; // reset so % change isn't computed across two different pairs
        const p = spotPair();
        document.getElementById('spotPairLabel').innerText = `${p.base.sym} / ${p.quote.sym}`;
        document.getElementById('spotAmountLabel').innerText = `Jumlah (${spotSide === 'buy' ? p.quote.sym : p.base.sym})`;
        updateSpotSubmitLabel();
        updateSpotBalance();
        renderSpotChart();
        pollSpotMarket();
    }

    function setSpotSide(side) {
        spotSide = side;
        document.getElementById('spotTabBuy').className = 'spot-tab-btn' + (side === 'buy' ? ' spot-tab-active-buy' : '');
        document.getElementById('spotTabSell').className = 'spot-tab-btn' + (side === 'sell' ? ' spot-tab-active-sell' : '');
        const p = spotPair();
        document.getElementById('spotAmountLabel').innerText = `Jumlah (${side === 'buy' ? p.quote.sym : p.base.sym})`;
        document.getElementById('spotEstimateLabel').innerText = side === 'buy' ? `Estimasi ${p.base.sym} diterima` : `Estimasi ${p.quote.sym} diterima`;
        updateSpotSubmitLabel();
        updateSpotBalance();
        updateSpotEstimate();
    }

    function setSpotOrderType(type) {
        spotOrderType = type;
        document.getElementById('spotTypeMarket').classList.toggle('spot-order-tab-active', type === 'market');
        document.getElementById('spotTypeLimit').classList.toggle('spot-order-tab-active', type === 'limit');
        document.getElementById('spotLimitPriceWrap').classList.toggle('hidden', type !== 'limit');
        updateSpotSubmitLabel();
    }

    function updateSpotSubmitLabel() {
        const p = spotPair();
        const btn = document.getElementById('spotSubmitBtn');
        if (!btn) return;
        const action = spotOrderType === 'limit' ? 'Place Limit' : (spotSide === 'buy' ? 'Buy' : 'Sell');
        btn.innerText = `${action} ${p.base.sym}`;
        btn.style.background = spotSide === 'buy'
            ? 'linear-gradient(135deg,#22c55e,#16a34a)'
            : 'linear-gradient(135deg,#ef4444,#dc2626)';
    }

    async function setSpotAmountPct(pct) {
        if (!isConnected) { showToast('warning','Wallet Not Connected','Connect wallet dulu untuk memakai Max/%.'); return; }
        const p = spotPair();
        const tok = spotSide === 'buy' ? p.quote : p.base;
        const bal = await fetchTokenBalance(tok, currentAccount);
        const val = parseFloat(bal) * pct;
        document.getElementById('spotAmount').value = val > 0 ? val.toFixed(6) : '';
        updateSpotEstimate();
    }

    /* Show the wallet balance of the token being spent (quote when buying,
       base when selling) next to the amount input. */
    async function updateSpotBalance() {
        const el = document.getElementById('spotBalance');
        if (!el) return;
        const p = spotPair();
        const tok = spotSide === 'buy' ? p.quote : p.base;
        if (!isConnected || !currentAccount) { el.innerText = 'Balance: —'; return; }
        try {
            const bal = await fetchTokenBalance(tok, currentAccount);
            el.innerText = `Balance: ${bal} ${tok.sym}`;
        } catch { el.innerText = 'Balance: —'; }
        updateSpotGasEstimate();
    }

    async function updateSpotGasEstimate() {
        const el = document.getElementById('spotFeeDisplay');
        if (!el) return;
        if (!isConnected || !currentAccount) { el.innerText = 'Gas: —'; return; }
        try {
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const gasPrice = await provider.getGasPrice();
            const gasPriceGwei = parseFloat(ethers.utils.formatUnits(gasPrice, 'gwei'));
            const estimatedGas = 150000; // Typical swap gas limit
            const gasCostEth = (gasPriceGwei * estimatedGas) / 1e9;
            el.innerText = `Gas: ~${gasCostEth.toFixed(4)} ETH`;
        } catch { el.innerText = 'Gas: —'; }
    }

    /* Live mid price from pool reserves (base priced in quote) */
    async function fetchSpotMidPrice() {
        const p = spotPair();
        try {
            const provider = readOnlyProvider() || (window.ethereum && new ethers.providers.Web3Provider(window.ethereum));
            if (!provider) return null;
            const pool = new ethers.Contract(CONTRACT_ADDRS.ArcenticMultiPool, POOL_ABI, provider);
            const decBase  = await getDecimals(p.base);
            const decQuote = await getDecimals(p.quote);
            const [resBaseRaw, resQuoteRaw] = await Promise.all([
                pool.reserves(p.base.addr),
                pool.reserves(p.quote.addr),
            ]);
            const resBase  = parseFloat(ethers.utils.formatUnits(resBaseRaw, decBase));
            const resQuote = parseFloat(ethers.utils.formatUnits(resQuoteRaw, decQuote));
            if (resBase <= 0 || resQuote <= 0) return null;
            return { price: resQuote / resBase, resBase, resQuote };
        } catch { return null; }
    }

    function spotFmtPrice(n) {
        if (n === null || n === undefined || isNaN(n)) return '—';
        return n < 1 ? n.toFixed(6) : n.toFixed(4);
    }

    async function pollSpotMarket() {
        const data = await fetchSpotMidPrice();
        const p = spotPair();
        if (!data) {
            document.getElementById('spotLastPrice').innerText = '—';
            document.getElementById('spotMidPrice').innerText = 'Pool belum ada likuiditas';
            document.getElementById('spotAsks').innerHTML = '';
            document.getElementById('spotBids').innerHTML = '';
            return;
        }
        const prevMid = spotLastMidPrice;
        spotLastMidPrice = data.price;

        document.getElementById('spotLastPrice').innerText = spotFmtPrice(data.price) + ' ' + p.quote.sym;
        document.getElementById('spotMidPrice').innerText = spotFmtPrice(data.price) + ' ' + p.quote.sym;

        const changeEl = document.getElementById('spotPriceChange');
        if (prevMid) {
            const pct = ((data.price - prevMid) / prevMid) * 100;
            changeEl.innerText = (pct >= 0 ? '▲ ' : '▼ ') + Math.abs(pct).toFixed(3) + '%';
            changeEl.style.color = pct >= 0 ? '#4ade80' : '#f87171';
        } else {
            changeEl.innerText = 'Sesi live dimulai';
            changeEl.style.color = '#9ca3af';
        }

        renderSpotOrderBook(data.resBase, data.resQuote);
        recordSpotCandle(data.price);
        updateSpotEstimate();
        checkSpotLimitOrders(data.price);
    }

    /* Synthetic AMM depth — bukan order book on-chain, murni turunan
       konstanta x*y=k pada beberapa ukuran trade untuk menggambarkan
       price impact, ditampilkan gaya order book. */
    function computeAmmDepth(resBase, resQuote) {
        const sizes = [0.005, 0.01, 0.025, 0.05, 0.1]; // % dari reserve
        const asks = []; // beli base pakai quote -> harga DI ATAS mid (yang dibayar pembeli)
        const bids = []; // jual base -> dapat quote -> harga DI BAWAH mid (yang diterima penjual)
        sizes.forEach(pct => {
            // ask: buy base with quote; price impact pushes price up (> mid)
            const amtQuote = resQuote * pct;
            const baseOut = resBase - (resBase * resQuote) / (resQuote + amtQuote);
            asks.push({ price: amtQuote / baseOut, amount: baseOut });

            // bid: sell base for quote; price impact pushes price down (< mid)
            const amtBase = resBase * pct;
            const quoteOut = resQuote - (resBase * resQuote) / (resBase + amtBase);
            bids.push({ price: quoteOut / amtBase, amount: amtBase });
        });
        return { asks, bids };
    }

    function renderSpotOrderBook(resBase, resQuote) {
        const { asks, bids } = computeAmmDepth(resBase, resQuote);
        const maxAmt = Math.max(...asks.map(a=>a.amount), ...bids.map(b=>b.amount), 0.000001);
        const asksHtml = asks.slice().reverse().map(a => `
            <div class="ob-row ask"><div class="ob-bar" style="width:${(a.amount/maxAmt*100).toFixed(1)}%"></div>
                <span class="ob-ask-price">${spotFmtPrice(a.price)}</span><span>${a.amount.toFixed(3)}</span></div>`).join('');
        const bidsHtml = bids.map(b => `
            <div class="ob-row bid"><div class="ob-bar" style="width:${(b.amount/maxAmt*100).toFixed(1)}%"></div>
                <span class="ob-bid-price">${spotFmtPrice(b.price)}</span><span>${b.amount.toFixed(3)}</span></div>`).join('');
        document.getElementById('spotAsks').innerHTML = asksHtml;
        document.getElementById('spotBids').innerHTML = bidsHtml;
    }

    /* Candle recording — 1 candle = 1 menit, dibangun dari sampel harga
       live selagi tab terbuka (bukan histori penuh dari indexer). */
    function recordSpotCandle(price) {
        const candles = loadSpotCandles();
        const bucket = Math.floor(Date.now() / 60000) * 60000;
        let last = candles[candles.length - 1];
        if (!last || last.t !== bucket) {
            candles.push({ t: bucket, o: price, h: price, l: price, c: price });
        } else {
            last.h = Math.max(last.h, price);
            last.l = Math.min(last.l, price);
            last.c = price;
        }
        saveSpotCandles(candles);
        renderSpotChart();
    }

    function renderSpotChart() {
        const canvas = document.getElementById('spotCandleCanvas');
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(rect.width, 300), h = 340;
        canvas.width = w * dpr; canvas.height = h * dpr;
        canvas.style.height = h + 'px';
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr,0,0,dpr,0,0);
        ctx.clearRect(0,0,w,h);

        const candles = loadSpotCandles();
        document.getElementById('spotCandleCount').innerText = candles.length + ' candle';
        if (candles.length === 0) {
            ctx.fillStyle = 'rgba(255,255,255,.35)';
            ctx.font = '13px Inter, sans-serif';
            ctx.fillText('Menunggu sampel harga pertama…', 16, h/2);
            return;
        }

        const pad = { l: 8, r: 55, t: 14, b: 14 };
        const plotW = w - pad.l - pad.r, plotH = h - pad.t - pad.b;
        const highs = candles.map(c=>c.h), lows = candles.map(c=>c.l);
        let maxP = Math.max(...highs), minP = Math.min(...lows);
        if (maxP === minP) { maxP *= 1.001; minP *= 0.999; }
        const range = maxP - minP;
        const yFor = p => pad.t + plotH - ((p - minP) / range) * plotH;

        // gridlines + price labels
        ctx.strokeStyle = 'rgba(255,255,255,.06)';
        ctx.fillStyle = 'rgba(255,255,255,.35)';
        ctx.font = '10px Inter, sans-serif';
        for (let i=0;i<=4;i++) {
            const yy = pad.t + (plotH/4)*i;
            ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w-pad.r, yy); ctx.stroke();
            const pv = maxP - (range/4)*i;
            ctx.fillText(spotFmtPrice(pv), w-pad.r+6, yy+3);
        }

        const n = candles.length;
        const slot = plotW / Math.max(n, 30);
        const bodyW = Math.max(Math.min(slot*0.6, 14), 2);

        candles.forEach((c, i) => {
            const x = pad.l + plotW - (n - 1 - i) * slot - slot/2;
            const up = c.c >= c.o;
            ctx.strokeStyle = ctx.fillStyle = up ? '#22c55e' : '#ef4444';
            ctx.beginPath();
            ctx.moveTo(x, yFor(c.h)); ctx.lineTo(x, yFor(c.l)); ctx.stroke();
            const yO = yFor(c.o), yC = yFor(c.c);
            const top = Math.min(yO,yC), bh = Math.max(Math.abs(yC-yO), 1.5);
            ctx.fillRect(x - bodyW/2, top, bodyW, bh);
        });
    }

    async function updateSpotEstimate() {
        const amt = parseFloat(document.getElementById('spotAmount').value) || 0;
        const p = spotPair();
        const estEl = document.getElementById('spotEstimateValue');
        if (!amt || !spotLastMidPrice) { estEl.innerText = '—'; return; }
        if (spotOrderType === 'limit') {
            const lp = parseFloat(document.getElementById('spotLimitPrice').value) || spotLastMidPrice;
            const est = spotSide === 'buy' ? amt / lp : amt * lp;
            estEl.innerText = est.toFixed(6) + ' ' + (spotSide === 'buy' ? p.base.sym : p.quote.sym);
            return;
        }
        const est = spotSide === 'buy' ? amt / spotLastMidPrice : amt * spotLastMidPrice;
        estEl.innerText = est.toFixed(6) + ' ' + (spotSide === 'buy' ? p.base.sym : p.quote.sym);
    }

    /* Submit — market langsung eksekusi lewat jalur Swap yang sudah ada;
       limit disimpan & dicek berkala selama tab terbuka. */
    async function submitSpotOrder() {
        if (!isConnected) { showToast('warning','Wallet Not Connected','Connect wallet dulu sebelum trading.'); return; }
        const submitBtn = document.getElementById('spotSubmitBtn');
        if (submitBtn && submitBtn.disabled) return; // guard against double-submit
        const amt = parseFloat(document.getElementById('spotAmount').value);
        if (!amt || amt <= 0) { showToast('warning','Jumlah Tidak Valid','Masukkan jumlah yang valid.'); return; }
        const p = spotPair();

        if (spotOrderType === 'limit') {
            const lp = parseFloat(document.getElementById('spotLimitPrice').value);
            if (!lp || lp <= 0) { showToast('warning','Harga Limit Tidak Valid','Masukkan harga limit yang valid.'); return; }
            addSpotLimitOrder({ pairIdx: spotPairIdx, side: spotSide, amount: amt, limitPrice: lp, createdAt: Date.now() });
            showToast('info','Limit Order Dipasang', `${spotSide.toUpperCase()} ${p.base.sym} saat harga ${spotSide === 'buy' ? '≤' : '≥'} ${lp} ${p.quote.sym}. Tab harus tetap terbuka.`);
            document.getElementById('spotAmount').value = '';
            return;
        }

        // Market order → set field2 swap view lalu jalankan executeSwap() yang sudah teruji.
        // executeSwap() disables/re-enables its own button (swapExecuteBtn), which is a
        // different element from spotSubmitBtn, so this button needs its own guard too —
        // otherwise repeated clicks here queue up multiple concurrent swap attempts.
        if (submitBtn) submitBtn.disabled = true;
        try {
            if (spotSide === 'buy') { swapFrom = SPOT_PAIRS[spotPairIdx].quote; swapTo = SPOT_PAIRS[spotPairIdx].base; }
            else                    { swapFrom = SPOT_PAIRS[spotPairIdx].base;  swapTo = SPOT_PAIRS[spotPairIdx].quote; }
            document.getElementById('swapFromAmt').value = amt;
            await getQuote();
            await executeSwap();
            document.getElementById('spotAmount').value = '';
            updateSpotEstimate();
            updateSpotBalance();
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    }

    /* ── Limit orders (client-side, disclosed as such) ── */
    function loadSpotLimitOrders() {
        try { return JSON.parse(localStorage.getItem('arcentic_limit_orders')) || []; }
        catch { return []; }
    }
    function saveSpotLimitOrders(orders) {
        try { localStorage.setItem('arcentic_limit_orders', JSON.stringify(orders)); } catch {}
    }
    function addSpotLimitOrder(order) {
        const orders = loadSpotLimitOrders();
        order.id = 'lo_' + Date.now() + '_' + Math.floor(Math.random()*1000);
        orders.push(order);
        saveSpotLimitOrders(orders);
        renderSpotLimitOrders();
    }
    function cancelSpotLimitOrder(id) {
        saveSpotLimitOrders(loadSpotLimitOrders().filter(o => o.id !== id));
        renderSpotLimitOrders();
    }
    function renderSpotLimitOrders() {
        const el = document.getElementById('spotLimitOrdersList');
        if (!el) return;
        const orders = loadSpotLimitOrders();
        if (orders.length === 0) { el.innerHTML = '<p class="text-gray-500 text-xs">Belum ada limit order.</p>'; return; }
        el.innerHTML = orders.map(o => {
            const pair = SPOT_PAIRS[o.pairIdx];
            const base = TOKENS[pair.base], quote = TOKENS[pair.quote];
            return `<div class="limit-order-row">
                <div><span class="font-bold ${o.side==='buy'?'text-green-400':'text-red-400'}">${o.side.toUpperCase()}</span>
                    ${o.amount} ${o.side==='buy'?quote.sym:base.sym} @ ${o.limitPrice} ${quote.sym}/${base.sym}</div>
                <button onclick="cancelSpotLimitOrder('${o.id}')" class="glass px-3 py-1 rounded-lg text-xs hover:border-white/30">Batalkan</button>
            </div>`;
        }).join('');
    }

    let spotLimitExecuting = false;
    async function checkSpotLimitOrders(currentPrice) {
        if (spotLimitExecuting) return;
        const orders = loadSpotLimitOrders();
        if (orders.length === 0) return;
        for (const o of orders) {
            if (o.pairIdx !== spotPairIdx) continue; // hanya cek pair yang lagi ditampilkan
            const hit = o.side === 'buy' ? currentPrice <= o.limitPrice : currentPrice >= o.limitPrice;
            if (!hit) continue;
            if (!isConnected) continue;
            spotLimitExecuting = true;
            try {
                const pair = SPOT_PAIRS[o.pairIdx];
                if (o.side === 'buy') { swapFrom = pair.quote; swapTo = pair.base; }
                else                  { swapFrom = pair.base;  swapTo = pair.quote; }
                document.getElementById('swapFromAmt').value = o.amount;
                await getQuote();
                showToast('info','Limit Order Terpicu', `Harga tercapai (${spotFmtPrice(currentPrice)}) — mengeksekusi ${o.side} ${o.amount}…`);
                await executeSwap();
                cancelSpotLimitOrder(o.id);
            } catch (e) {
                console.error('Limit order execution failed:', e);
            }
            spotLimitExecuting = false;
            break; // satu order per siklus supaya tidak numpuk approve/tx
        }
    }

    function showSpotTrade() {
        hideAllOverlays();
        document.getElementById('spotTradeView').classList.add('open');
        document.body.style.overflow = 'hidden';
        setNavActive('navTrading');
        populateSpotPairSelect();
        setSpotSide(spotSide);
        setSpotOrderType(spotOrderType);
        updateSpotBalance();
        renderSpotChart();
        renderSpotLimitOrders();
        pollSpotMarket();
        if (spotPollTimer) clearInterval(spotPollTimer);
        spotPollTimer = setInterval(pollSpotMarket, 8000);
    }

    function stopSpotTradePolling() {
        if (spotPollTimer) { clearInterval(spotPollTimer); spotPollTimer = null; }
    }
    window.addEventListener('resize', () => {
        const view = document.getElementById('spotTradeView');
        if (view && view.classList.contains('open')) renderSpotChart();
    });


    function renderSwapTokens() {
        const f = TOKENS[swapFrom], t = TOKENS[swapTo];
        document.getElementById('swapFromIcon').innerHTML = f.icon;
        document.getElementById('swapFromSym').innerText  = f.sym;
        document.getElementById('swapToIcon').innerHTML   = t.icon;
        document.getElementById('swapToSym').innerText    = t.sym;
        // Update rate display with static fallback
        const rate = (t.rate / f.rate).toFixed(6);
        document.getElementById('swapRate').innerText = `1 ${f.sym} ≈ ${rate} ${t.sym}`;
        getQuote();
        updateSwapBalances();
    }

    function flipSwap() {
        // Swap the indices
        [swapFrom, swapTo] = [swapTo, swapFrom];
        // Move the "you pay" amount to input and clear output
        const prevOut = document.getElementById('swapToAmt').value;
        document.getElementById('swapFromAmt').value = prevOut || '';
        document.getElementById('swapToAmt').value   = '';
        // Animate the arrow button
        const arrow = document.querySelector('.swap-arrow-btn');
        arrow.style.transition = 'transform 0.3s ease';
        arrow.style.transform = 'rotate(180deg)';
        setTimeout(() => { arrow.style.transform = 'rotate(0deg)'; }, 300);
        renderSwapTokens();
    }

    /* ── Custom token icon (used for tokens imported by contract address) ── */
    function genTokenIcon(sym) {
        const colors = ['#3478ff','#8b5cf6','#d66bff','#22c55e','#eab308','#ef4444','#06b6d4','#f97316'];
        let hash = 0;
        for (const ch of (sym || '?')) hash += ch.charCodeAt(0);
        const c = colors[hash % colors.length];
        const letter = escapeHtml((sym && sym[0] ? sym[0] : '?').toUpperCase());
        return `<div style="width:22px;height:22px;border-radius:50%;background:${c};display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;vertical-align:middle;">${letter}</div>`;
    }

    function isAddressLike(str) {
        return /^0x[a-fA-F0-9]{40}$/.test((str || '').trim());
    }

    function toggleTokenMenu(target) {
        const menu = document.getElementById('tokenMenu');
        if (tokenMenuTarget === target && !menu.classList.contains('hidden')) {
            menu.classList.add('hidden'); tokenMenuTarget = null; return;
        }
        tokenMenuTarget = target;
        const searchInput = document.getElementById('tokenSearchInput');
        if (searchInput) searchInput.value = '';
        renderTokenMenuList('');
        menu.classList.remove('hidden');
        if (searchInput) setTimeout(() => searchInput.focus(), 50);
    }

    function filterTokenMenu() {
        const val = document.getElementById('tokenSearchInput').value;
        renderTokenMenuList(val);
    }

    function renderTokenMenuList(filter) {
        filter = (filter || '').trim();
        const target = tokenMenuTarget;
        const menu = document.getElementById('tokenMenu');
        const list = document.getElementById('tokenMenuList');
        const importArea = document.getElementById('tokenImportArea');
        list.innerHTML = '';
        importArea.classList.add('hidden');
        importArea.innerHTML = '';

        const other = target === 'from' ? swapTo : swapFrom;
        const q = filter.toLowerCase();
        const matches = [];
        TOKENS.forEach((tk, i) => {
            if (i === other) return;
            if (!q) { matches.push(i); return; }
            if (tk.sym.toLowerCase().includes(q)
                || (tk.name && tk.name.toLowerCase().includes(q))
                || tk.addr.toLowerCase() === q) matches.push(i);
        });

        matches.forEach(i => {
            const tk = TOKENS[i];
            const btn = document.createElement('button');
            btn.className = 'flex items-center gap-3 px-4 py-2 rounded-xl hover:bg-white/5 transition w-full text-left';
            const isCurrent = (target === 'from' ? swapFrom : swapTo) === i;
            const tag = tk.custom ? '<span class="text-[10px] text-gray-500 ml-1">Imported</span>' : '';
            btn.innerHTML = `<span style="font-size:1.3rem">${tk.icon}</span><span class="flex flex-col"><span class="font-semibold leading-tight">${escapeHtml(tk.sym)}${tag}</span>${tk.name ? `<span class="text-[11px] text-gray-500 leading-tight">${escapeHtml(tk.name)}</span>` : ''}</span>${isCurrent ? '<span class="ml-auto text-xs text-cyan-400">Selected</span>' : ''}`;
            btn.onclick = () => {
                if (target === 'from') swapFrom = i; else swapTo = i;
                menu.classList.add('hidden'); tokenMenuTarget = null;
                renderSwapTokens();
            };
            list.appendChild(btn);
        });

        if (matches.length === 0 && q && !isAddressLike(q)) {
            const empty = document.createElement('p');
            empty.className = 'text-xs text-gray-500 px-2 py-3 text-center';
            empty.innerText = 'No tokens found.';
            list.appendChild(empty);
        }

        // Offer to import a token the user pasted a contract address for
        if (isAddressLike(filter)) {
            const already = TOKENS.some(t => t.addr.toLowerCase() === filter.toLowerCase());
            if (already) {
                importArea.classList.remove('hidden');
                importArea.innerHTML = `<p class="text-xs text-gray-400 px-1">This token is already in your list above.</p>`;
            } else {
                importArea.classList.remove('hidden');
                importArea.innerHTML = `
                    <p class="text-xs text-gray-400 mb-2">Token not in your list — import it from its contract?</p>
                    <button id="importTokenBtn" class="w-full text-sm font-semibold py-2.5 rounded-xl gradient">+ Import Token</button>
                `;
                document.getElementById('importTokenBtn').onclick = () => importTokenByAddress(filter, target);
            }
        }
    }

    /* Reads name/symbol/decimals straight from the ERC-20 contract and adds it to TOKENS */
    async function importTokenByAddress(address, target) {
        address = address.trim();
        const importArea = document.getElementById('tokenImportArea');
        importArea.innerHTML = `<p class="text-xs text-gray-400 px-1">⏳ Reading token contract…</p>`;
        try {
            const provider = readOnlyProvider() || (window.ethereum ? new ethers.providers.Web3Provider(window.ethereum) : null);
            if (!provider) throw new Error('No wallet provider available to read token data. Connect a wallet or install one to import custom tokens.');
            const erc20 = new ethers.Contract(address, [
                'function name() view returns (string)',
                'function symbol() view returns (string)',
                'function decimals() view returns (uint8)',
            ], provider);
            const [name, symbol, decimals] = await Promise.all([
                erc20.name().catch(() => 'Unknown Token'),
                erc20.symbol().catch(() => '???'),
                erc20.decimals().catch(() => 18),
            ]);
            const newTok = { sym: symbol, name, addr: address, decimals, rate: 0, icon: genTokenIcon(symbol), custom: true };
            TOKENS.push(newTok);
            showToast('success', 'Token Imported', `${symbol} (${name}) was added to your token list.`);

            const idx = TOKENS.length - 1;
            if (target === 'from') swapFrom = idx; else swapTo = idx;
            document.getElementById('tokenMenu').classList.add('hidden');
            tokenMenuTarget = null;
            renderSwapTokens();
        } catch (err) {
            importArea.innerHTML = `<p class="text-xs text-red-400 px-1">❌ Couldn't read that contract. Double-check the address and network.</p>`;
            showToast('error', 'Import Failed', err.reason || err.message || 'Could not read an ERC-20 contract at that address.');
        }
    }

    // Close token menu when clicking outside
    document.addEventListener('click', e => {
        const menu = document.getElementById('tokenMenu');
        if (!menu.classList.contains('hidden')) {
            const fromBtn = document.getElementById('swapFromBtn');
            const toBtn   = document.getElementById('swapToBtn');
            if (!menu.contains(e.target) && e.target !== fromBtn && e.target !== toBtn
                && !fromBtn.contains(e.target) && !toBtn.contains(e.target)) {
                menu.classList.add('hidden');
                tokenMenuTarget = null;
            }
        }
    });

    async function executeSwap() {
        if (!isConnected) { showToast('warning','Wallet Not Connected','Please connect your wallet before swapping.'); return; }
        const onArcNetwork = await ensureArcNetwork();
        if (!onArcNetwork) return;
        const amtStr = document.getElementById('swapFromAmt').value;
        const amt    = parseFloat(amtStr);
        if (!amt || amt <= 0) { showToast('warning','Invalid Amount','Please enter a valid amount to swap.'); return; }

        const fromTok = TOKENS[swapFrom];
        const toTok   = TOKENS[swapTo];
        const status  = document.getElementById('swapStatus');
        const execBtn = document.getElementById('swapExecuteBtn');

        const setStatus = (msg, hide=false) => {
            status.innerText = msg;
            status.classList.toggle('hidden', hide);
        };

        execBtn.disabled = true;
        execBtn.style.opacity = '.6';

        let swapToast = null;
        try {
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const signer   = provider.getSigner();
            const decFrom   = await getDecimals(fromTok);
            const decTo     = await getDecimals(toTok);
            const safeAmtStr = parseFloat(amtStr).toFixed(decFrom);
            const amtInWei   = ethers.utils.parseUnits(safeAmtStr, decFrom);

            // Step 1: approve
            setStatus('⏳ Step 1/2 — Approving token spend…');
            swapToast = showToast('pending','Approving Token',`Requesting spend approval for ${fromTok.sym}…`);
            const onRpcRetry = (n, max) => setStatus(`⏳ RPC hiccup — retrying (${n}/${max})…`);
            const erc20 = new ethers.Contract(fromTok.addr, ERC20_ABI, signer);
            const allowance = await withRpcRetry(
                () => erc20.allowance(currentAccount, CONTRACT_ADDRS.ArcenticMultiPool),
                { onRetry: onRpcRetry }
            );
            if (allowance.lt(amtInWei)) {
                const approveTx = await withRpcRetry(
                    () => erc20.approve(CONTRACT_ADDRS.ArcenticMultiPool, ethers.constants.MaxUint256),
                    { onRetry: onRpcRetry }
                );
                updateToast(swapToast,'pending','Waiting for Approval',`Confirming approval on-chain…`);
                setStatus('⏳ Step 1/2 — Waiting for approval confirmation…');
                await withRpcRetry(() => approveTx.wait(), { onRetry: onRpcRetry });
            }

            // Step 2: swap
            setStatus('⏳ Step 2/2 — Sending swap transaction…');
            updateToast(swapToast,'pending','Sending Swap',`Swapping ${amt} ${fromTok.sym} → ${toTok.sym}…`);
            const pool = new ethers.Contract(CONTRACT_ADDRS.ArcenticMultiPool, POOL_ABI, signer);
            const swapTx = await withRpcRetry(
                () => pool.swap(fromTok.addr, toTok.addr, amtInWei),
                { onRetry: onRpcRetry }
            );
            setStatus('⏳ Waiting for swap confirmation…');
            updateToast(swapToast,'pending','Confirming Swap','Waiting for block confirmation…');
            const receipt = await withRpcRetry(() => swapTx.wait(), { onRetry: onRpcRetry });

            const shortTx = receipt.transactionHash.slice(0,10) + '…';
            setStatus(`✅ Swap confirmed! Tx: ${shortTx}`);
            updateToast(swapToast,'success','Swap Successful! 🎉',`${amt} ${fromTok.sym} → ${toTok.sym} confirmed. Tx: ${shortTx}`);
            document.getElementById('swapFromAmt').value = '';
            document.getElementById('swapToAmt').value   = '';
            tokenBalances = {};
            refreshSwapBalances();

        } catch(err) {
            console.error('Swap error:', err);
            if (err.code === 4001 || err.code === 'ACTION_REJECTED') {
                setStatus('❌ Transaction rejected by user.');
                if (swapToast) updateToast(swapToast,'error','Swap Cancelled','You rejected the transaction in your wallet.');
                else showToast('error','Swap Cancelled','You rejected the transaction in your wallet.');
            } else {
                const reason = friendlyTxError(err);
                setStatus('❌ Swap failed: ' + reason);
                // swapToast may still be null if the failure happened before it was
                // created (e.g. fetching token decimals failed) — fall back to a
                // fresh toast instead of silently dropping the error.
                if (swapToast) updateToast(swapToast,'error','Swap Failed',reason);
                else showToast('error','Swap Failed',reason);
            }
        } finally {
            execBtn.disabled = false;
            execBtn.style.opacity = '1';
        }
    }

    /* ═══════════════════════════ BRIDGE FUNCTIONS ═══════════════════════════ */
    // Remembers which RPC URL last worked for each chain so we try that one
    // first next time, instead of always starting from index 0.
    const _lastGoodRpcIndex = {};

    function getChainRpcUrls(chainName) {
        if (chainName === 'ethereumSepolia') return ETHEREUM_SEPOLIA_CHAIN.rpcUrls;
        if (chainName === 'arcTestnet') return ARC_CHAIN.rpcUrls;
        return null;
    }

    // Runs callFn(provider) against each configured RPC URL in turn, moving to
    // the next URL only if the REAL call fails (no separate health-check ping,
    // so this adds zero extra requests when the first URL just works).
    async function callWithChainFallback(chainName, callFn) {
        const rpcUrls = getChainRpcUrls(chainName);
        if (!rpcUrls) {
            // Unknown chain name — fall back to the wallet's injected provider
            return await callFn(new ethers.providers.Web3Provider(window.ethereum));
        }

        const startIdx = _lastGoodRpcIndex[chainName] || 0;
        const order = [...rpcUrls.slice(startIdx), ...rpcUrls.slice(0, startIdx)];

        let lastErr;
        for (const url of order) {
            try {
                const provider = new ethers.providers.JsonRpcProvider(url);
                const result = await callFn(provider);
                _lastGoodRpcIndex[chainName] = rpcUrls.indexOf(url);
                return result;
            } catch (err) {
                lastErr = err;
                console.warn(`RPC ${url} failed for ${chainName}, trying next…`, err.message || err);
            }
        }
        throw lastErr || new Error(`All RPC endpoints failed for ${chainName}`);
    }

    // Incremented every time updateBridgeBalances runs. If the user flips the
    // From/To selects (or hits ⇄) while a slow RPC retry is still in flight,
    // the older call's results would otherwise land AFTER the newer call's
    // and silently overwrite the correct display with stale data — this
    // guard makes an in-flight call bail out once a newer one has started.
    let _bridgeBalRequestId = 0;

    // Which token each leg is denominated in. Only meaningful on the
    // Ethereum Sepolia side — Arc Testnet's native/only relevant asset is
    // USDC itself, so it's always forced to 'USDC'.
    let bridgeSourceToken = 'USDC';
    let bridgeDestToken = 'USDC';

    // skipRefresh=true is used internally (e.g. from updateBridgeBalances)
    // to update state/UI without re-triggering a balance refresh loop.
    function updateBridgeButtonLabel() {
        const btn = document.getElementById('bridgeExecuteBtn');
        if (!btn) return;
        btn.textContent = (bridgeSourceToken === 'ETH' || bridgeDestToken === 'ETH')
            ? `Bridge ${bridgeSourceToken} → ${bridgeDestToken}`
            : 'Bridge USDC';
    }

    function setBridgeSourceToken(token, skipRefresh) {
        bridgeSourceToken = token;
        document.getElementById('bridgeSrcTokBtn_USDC').classList.toggle('tok-active', token === 'USDC');
        document.getElementById('bridgeSrcTokBtn_ETH').classList.toggle('tok-active', token === 'ETH');
        document.getElementById('bridgeSourceUnit').innerText = token;
        updateBridgeButtonLabel();
        if (!skipRefresh) {
            document.getElementById('bridgeAmount').value = '';
            calcBridgeFee();
            updateBridgeBalances();
        }
    }

    function setBridgeDestToken(token, skipRefresh) {
        bridgeDestToken = token;
        document.getElementById('bridgeDstTokBtn_USDC').classList.toggle('tok-active', token === 'USDC');
        document.getElementById('bridgeDstTokBtn_ETH').classList.toggle('tok-active', token === 'ETH');
        document.getElementById('bridgeDestUnit').innerText = token;
        updateBridgeButtonLabel();
        if (!skipRefresh) calcBridgeFee();
    }

    async function updateBridgeBalances() {
        const requestId = ++_bridgeBalRequestId;

        const sourceChain = document.getElementById('bridgeSourceChain').value;
        const destChain = document.getElementById('bridgeDestChain').value;

        // The ETH/USDC token pills only make sense on the Sepolia leg.
        const srcTokWrap = document.getElementById('bridgeSourceTokenWrap');
        if (sourceChain === 'ethereumSepolia') {
            srcTokWrap.style.display = 'flex';
        } else {
            srcTokWrap.style.display = 'none';
            if (bridgeSourceToken !== 'USDC') setBridgeSourceToken('USDC', true);
        }
        const dstTokWrap = document.getElementById('bridgeDestTokenWrap');
        if (destChain === 'ethereumSepolia') {
            dstTokWrap.style.display = 'flex';
        } else {
            dstTokWrap.style.display = 'none';
            if (bridgeDestToken !== 'USDC') setBridgeDestToken('USDC', true);
        }

        if (!isConnected) {
            document.getElementById('bridgeSourceBal').innerText = 'Balance: —';
            document.getElementById('bridgeDestBal').innerText = 'Balance: —';
            document.getElementById('bridgeSourceEthBal').innerText = '';
            document.getElementById('bridgeDestEthBal').innerText = '';
            return;
        }

        // Source and destination fetches are independent — one chain's RPC
        // being down should not blank out the balance we DID manage to fetch
        // for the other chain.
        const usingEthSource = sourceChain === 'ethereumSepolia' && bridgeSourceToken === 'ETH';
        try {
            if (usingEthSource) {
                const ethBal = await callWithChainFallback('ethereumSepolia', (provider) =>
                    withRpcRetry(() => provider.getBalance(currentAccount), { retries: 1 })
                );
                if (requestId !== _bridgeBalRequestId) return;
                document.getElementById('bridgeSourceBal').innerText = `Balance: ${parseFloat(ethers.utils.formatEther(ethBal)).toFixed(4)} ETH`;
            } else {
                const sourceConfig = sourceChain === 'ethereumSepolia' ? CCTP_CONFIG.ethereumSepolia : CCTP_CONFIG.arcTestnet;
                const sourceBal = await callWithChainFallback(sourceChain, (provider) => {
                    const sourceUsdc = new ethers.Contract(sourceConfig.usdc, ERC20_ABI, provider);
                    return withRpcRetry(() => sourceUsdc.balanceOf(currentAccount), { retries: 1 });
                });
                if (requestId !== _bridgeBalRequestId) return; // a newer call has since started
                document.getElementById('bridgeSourceBal').innerText = `Balance: ${parseFloat(ethers.utils.formatUnits(sourceBal, 6)).toFixed(2)} USDC`;
            }
        } catch (err) {
            console.error(`Bridge source (${sourceChain}) balance error:`, err);
            if (requestId !== _bridgeBalRequestId) return;
            document.getElementById('bridgeSourceBal').innerText = 'Balance: RPC error';
        }

        try {
            const destConfig = destChain === 'ethereumSepolia' ? CCTP_CONFIG.ethereumSepolia : CCTP_CONFIG.arcTestnet;
            const destBal = await callWithChainFallback(destChain, (provider) => {
                const destUsdc = new ethers.Contract(destConfig.usdc, ERC20_ABI, provider);
                return withRpcRetry(() => destUsdc.balanceOf(currentAccount), { retries: 1 });
            });
            if (requestId !== _bridgeBalRequestId) return;
            document.getElementById('bridgeDestBal').innerText = `Balance: ${parseFloat(ethers.utils.formatUnits(destBal, 6)).toFixed(2)} USDC`;
        } catch (err) {
            console.error(`Bridge destination (${destChain}) balance error:`, err);
            if (requestId !== _bridgeBalRequestId) return;
            document.getElementById('bridgeDestBal').innerText = 'Balance: RPC error';
        }

        // Native ETH is only relevant on the Ethereum Sepolia side — it's the
        // gas token there. If we already showed it as the main source balance
        // above, skip the redundant secondary line.
        if (!usingEthSource) {
            await updateSepoliaEthBalance('bridgeSourceEthBal', sourceChain, requestId);
        } else {
            document.getElementById('bridgeSourceEthBal').innerText = '';
        }
        await updateSepoliaEthBalance('bridgeDestEthBal', destChain, requestId);
    }

    async function updateSepoliaEthBalance(elementId, chainName, requestId) {
        const el = document.getElementById(elementId);
        if (chainName !== 'ethereumSepolia') {
            el.innerText = '';
            return;
        }
        try {
            const ethBal = await callWithChainFallback('ethereumSepolia', (provider) => {
                return withRpcRetry(() => provider.getBalance(currentAccount), { retries: 1 });
            });
            if (requestId !== _bridgeBalRequestId) return; // stale — a newer selection has taken over
            el.innerText = `${parseFloat(ethers.utils.formatEther(ethBal)).toFixed(4)} ETH (gas)`;
        } catch (err) {
            console.error('Sepolia ETH balance error:', err);
            if (requestId !== _bridgeBalRequestId) return;
            el.innerText = 'ETH: RPC error';
        }
    }

    // Guards calcBridgeFee's async quote lookups the same way _bridgeBalRequestId
    // guards balances — a stale in-flight quote must not overwrite a newer one.
    let _feeCalcRequestId = 0;

    async function calcBridgeFee() {
        const requestId = ++_feeCalcRequestId;
        const amount = parseFloat(document.getElementById('bridgeAmount').value) || 0;
        const fee = 0.0005; // Fixed CCTP fee, denominated in USDC (the bridged asset)

        const sourceChain = document.getElementById('bridgeSourceChain').value;
        const destChain = document.getElementById('bridgeDestChain').value;
        const usingEthSource = sourceChain === 'ethereumSepolia' && bridgeSourceToken === 'ETH';
        const usingEthDest = destChain === 'ethereumSepolia' && bridgeDestToken === 'ETH';

        let usdcAmount = amount;

        // Leg 1: if bridging FROM ETH, quote what the Uniswap swap would
        // yield in USDC before any of that USDC gets bridged.
        if (usingEthSource) {
            if (amount <= 0) {
                document.getElementById('bridgeFee').innerText = '0.0005 USDC';
                document.getElementById('bridgeReceive').innerText = usingEthDest ? '0.00 ETH' : '0.00 USDC';
                document.getElementById('bridgeDestAmount').innerText = '0.00';
                return;
            }
            document.getElementById('bridgeFee').innerText = 'estimating…';
            document.getElementById('bridgeReceive').innerText = 'estimating…';
            try {
                const { weth } = UNISWAP_CONFIG.ethereumSepolia;
                const quoted = await getSwapQuote(weth, CCTP_CONFIG.ethereumSepolia.usdc, ethers.utils.parseEther(amount.toString()));
                if (requestId !== _feeCalcRequestId) return; // a newer calc has since started
                usdcAmount = parseFloat(ethers.utils.formatUnits(quoted, 6));
            } catch (err) {
                console.error('Swap quote error (ETH->USDC):', err);
                if (requestId !== _feeCalcRequestId) return;
                document.getElementById('bridgeFee').innerText = '—';
                document.getElementById('bridgeReceive').innerText = 'quote unavailable';
                document.getElementById('bridgeDestAmount').innerText = '0.00';
                return;
            }
        }

        const receiveUsdc = Math.max(0, usdcAmount - fee);
        document.getElementById('bridgeFee').innerText = `${fee.toFixed(4)} USDC`;

        // Leg 2: if bridging TO ETH, quote what the post-mint Uniswap swap
        // on Sepolia would yield.
        if (usingEthDest && receiveUsdc > 0) {
            document.getElementById('bridgeReceive').innerText = 'estimating…';
            try {
                const { weth } = UNISWAP_CONFIG.ethereumSepolia;
                const quotedEth = await getSwapQuote(CCTP_CONFIG.ethereumSepolia.usdc, weth, ethers.utils.parseUnits(receiveUsdc.toFixed(6), 6));
                if (requestId !== _feeCalcRequestId) return;
                const ethOut = parseFloat(ethers.utils.formatEther(quotedEth));
                document.getElementById('bridgeReceive').innerText = `≈ ${ethOut.toFixed(6)} ETH`;
                document.getElementById('bridgeDestAmount').innerText = ethOut.toFixed(6);
            } catch (err) {
                console.error('Swap quote error (USDC->ETH):', err);
                if (requestId !== _feeCalcRequestId) return;
                document.getElementById('bridgeReceive').innerText = 'quote unavailable';
                document.getElementById('bridgeDestAmount').innerText = '0.00';
            }
        } else {
            document.getElementById('bridgeReceive').innerText = `${receiveUsdc.toFixed(2)} USDC`;
            document.getElementById('bridgeDestAmount').innerText = receiveUsdc.toFixed(2);
        }
    }

    async function setMaxBridgeAmount() {
        if (!isConnected) {
            showToast('warning','Wallet Not Connected','Please connect your wallet first.');
            return;
        }

        const sourceChain = document.getElementById('bridgeSourceChain').value;
        try {
            if (sourceChain === 'ethereumSepolia' && bridgeSourceToken === 'ETH') {
                const ethBal = await callWithChainFallback('ethereumSepolia', (provider) =>
                    withRpcRetry(() => provider.getBalance(currentAccount), { retries: 1 })
                );
                // Leave some ETH behind to cover gas for the swap + approve +
                // burn transactions that still need to happen after this.
                const gasBuffer = ethers.utils.parseEther('0.01');
                const usable = ethBal.gt(gasBuffer) ? ethBal.sub(gasBuffer) : ethers.BigNumber.from(0);
                document.getElementById('bridgeAmount').value = parseFloat(ethers.utils.formatEther(usable)).toFixed(6);
            } else {
                const sourceConfig = sourceChain === 'ethereumSepolia' ? CCTP_CONFIG.ethereumSepolia : CCTP_CONFIG.arcTestnet;
                const sourceBal = await callWithChainFallback(sourceChain, (provider) => {
                    const sourceUsdc = new ethers.Contract(sourceConfig.usdc, ERC20_ABI, provider);
                    return withRpcRetry(() => sourceUsdc.balanceOf(currentAccount), { retries: 1 });
                });
                const balUsdc = parseFloat(ethers.utils.formatUnits(sourceBal, 6));
                document.getElementById('bridgeAmount').value = Math.max(0, balUsdc - 0.0005).toFixed(2);
            }
            calcBridgeFee();
        } catch (err) {
            console.error('Max amount error:', err);
        }
    }

    function swapBridgeDirection() {
        const sourceSelect = document.getElementById('bridgeSourceChain');
        const destSelect = document.getElementById('bridgeDestChain');
        const temp = sourceSelect.value;
        sourceSelect.value = destSelect.value;
        destSelect.value = temp;

        // Reset both token pills to USDC after flipping so an "ETH"
        // selection never silently carries over to the wrong leg.
        setBridgeSourceToken('USDC', true);
        setBridgeDestToken('USDC', true);

        document.getElementById('bridgeAmount').value = '';
        calcBridgeFee();
        updateBridgeBalances();
    }

    // Helper: Convert address to bytes32 for CCTP
    function addressToBytes32(address) {
        return ethers.utils.hexZeroPad(address, 32);
    }

    // Helper: Convert bytes32 to address
    function bytes32ToAddress(bytes32) {
        return ethers.utils.hexStripZeros(bytes32);
    }

    // Set right before we ask the wallet to switch networks ourselves (e.g.
    // mid-bridge), and cleared shortly after. The 'chainChanged' listener below
    // uses this to tell apart "we switched the chain on purpose, as part of a
    // flow that's still running" from "the user flipped networks manually in
    // their wallet" — only the latter should reload the page.
    let programmaticChainSwitch = false;

    async function switchToChain(targetChainId, chainConfig) {
        programmaticChainSwitch = true;
        try {
            await window.ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: targetChainId }]
            });
        } catch (switchErr) {
            if (switchErr.code === 4902 || switchErr.code === -32603) {
                await window.ethereum.request({
                    method: 'wallet_addEthereumChain',
                    params: [chainConfig]
                });
            } else if (switchErr.code === 4001) {
                programmaticChainSwitch = false;
                throw new Error('Network switch was rejected in your wallet. Please approve switching networks to continue.');
            } else {
                programmaticChainSwitch = false;
                throw switchErr;
            }
        } finally {
            // Wallets fire 'chainChanged' asynchronously, often a tick or two
            // after this request resolves — keep the flag up briefly so that
            // event, whenever it lands, still reads it as "on purpose".
            setTimeout(() => { programmaticChainSwitch = false; }, 1500);
        }
    }

    // Checks whether MetaMask's currently active chain is Arc Testnet.
    // If not, prompts the wallet to switch (reusing switchToChain so the
    // chainChanged listener above knows this was intentional and won't
    // force a page reload mid-flow). Returns true only if the wallet ends
    // up on Arc Testnet; callers should abort their transaction otherwise.
    async function ensureArcNetwork() {
        if (!window.ethereum) {
            showToast('error','No Wallet Detected','Please install MetaMask or a compatible browser wallet.');
            return false;
        }
        try {
            const currentChainId = await window.ethereum.request({ method: 'eth_chainId' });
            if (currentChainId.toLowerCase() === ARC_CHAIN.chainId.toLowerCase()) return true;

            showToast('warning','Wrong Network','You\'re not on Arc Testnet — requesting your wallet to switch…');
            await switchToChain(ARC_CHAIN.chainId, ARC_CHAIN);

            const confirmedChainId = await window.ethereum.request({ method: 'eth_chainId' });
            if (confirmedChainId.toLowerCase() !== ARC_CHAIN.chainId.toLowerCase()) {
                showToast('error','Still on Wrong Network','Please switch to Arc Testnet manually in your wallet, then try again.');
                return false;
            }
            return true;
        } catch (err) {
            showToast('error','Network Switch Failed', err.message || 'Please switch to Arc Testnet manually in your wallet, then try again.');
            return false;
        }
    }

    // Parses ERC20 Transfer logs out of a receipt and sums the amount sent
    // TO `toAddress` from the given token contract. Used to read the exact
    // amount a swap/mint actually produced, rather than trusting a quote.
    function sumTransfersTo(receipt, tokenAddress, toAddress) {
        const iface = new ethers.utils.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
        let total = ethers.BigNumber.from(0);
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== tokenAddress.toLowerCase()) continue;
            try {
                const parsed = iface.parseLog(log);
                if (parsed.name === 'Transfer' && parsed.args.to.toLowerCase() === toAddress.toLowerCase()) {
                    total = total.add(parsed.args.value);
                }
            } catch (e) { /* not a Transfer log — ignore */ }
        }
        return total;
    }

    async function executeBridge() {
        if (!isConnected) {
            showToast('warning','Wallet Not Connected','Please connect your wallet before bridging.');
            return;
        }

        const amtStr = document.getElementById('bridgeAmount').value;
        const amt = parseFloat(amtStr);
        if (!amt || amt <= 0) {
            showToast('warning','Invalid Amount','Please enter a valid amount to bridge.');
            return;
        }

        const sourceChain = document.getElementById('bridgeSourceChain').value;
        const destChain = document.getElementById('bridgeDestChain').value;

        if (sourceChain === destChain) {
            showToast('warning','Same Chain','Source and destination chains must be different.');
            return;
        }

        // ETH is only ever involved on the Ethereum Sepolia leg — Arc Testnet's
        // native/only relevant asset is USDC itself, so it's always USDC there.
        const srcIsEth = sourceChain === 'ethereumSepolia' && bridgeSourceToken === 'ETH';
        const dstIsEth = destChain === 'ethereumSepolia' && bridgeDestToken === 'ETH';

        const status = document.getElementById('bridgeStatus');
        const execBtn = document.getElementById('bridgeExecuteBtn');

        const setStatus = (msg, hide = false) => {
            status.innerText = msg;
            status.classList.toggle('hidden', hide);
        };

        execBtn.disabled = true;
        execBtn.style.opacity = '.6';

        let bridgeToast = null;
        const onRpcRetry = (n, max) => setStatus(`⏳ RPC hiccup — retrying (${n}/${max})…`);
        const destConfig = destChain === 'ethereumSepolia' ? CCTP_CONFIG.ethereumSepolia : CCTP_CONFIG.arcTestnet;
        const srcDomain = sourceChain === 'ethereumSepolia' ? CCTP_CONFIG.domains.ETHEREUM_SEPOLIA : CCTP_CONFIG.domains.ARC_TESTNET;
        const { swapRouter02, weth, poolFee } = UNISWAP_CONFIG.ethereumSepolia;

        // Total steps just drives the "Step X/N" status label.
        const totalSteps = 3 + (srcIsEth ? 1 : 0) + (dstIsEth ? 1 : 0);
        let stepNum = 0;

        // If a previous attempt already burned USDC but the attestation poll
        // timed out, resume from there instead of burning (or swapping) again.
        const pending = getPendingBridge(currentAccount, sourceChain, destChain);

        try {
            let burnTxHash, displayAmt;

            if (pending) {
                stepNum = srcIsEth ? 2 : 1; // swap+approve already happened before the burn
                setStatus('⏳ Resuming previous bridge — retrieving attestation…');
                bridgeToast = showToast('pending','Resuming Bridge','Found an already-confirmed burn — fetching Circle attestation…');
                burnTxHash = pending.txHash;
                displayAmt = pending.amount;
            } else {
                // Force the wallet onto the source chain BEFORE any contract call.
                // Without this, allowance()/approve()/depositForBurn() run against
                // whatever network the wallet happened to be on (e.g. left over
                // from a previous mint step), which reverts with an empty-data
                // CALL_EXCEPTION because the source contract doesn't exist there.
                setStatus('⏳ Switching to source network…');
                await switchToChain(
                    sourceChain === 'ethereumSepolia' ? ETHEREUM_SEPOLIA_CHAIN.chainId : ARC_CHAIN.chainId,
                    sourceChain === 'ethereumSepolia' ? ETHEREUM_SEPOLIA_CHAIN : ARC_CHAIN
                );
                await new Promise(r => setTimeout(r, 400)); // let the wallet settle on the new network

                const provider = new ethers.providers.Web3Provider(window.ethereum);
                const signer = provider.getSigner();

                const sourceConfig = sourceChain === 'ethereumSepolia' ? CCTP_CONFIG.ethereumSepolia : CCTP_CONFIG.arcTestnet;
                const destDomain = destChain === 'ethereumSepolia' ? CCTP_CONFIG.domains.ETHEREUM_SEPOLIA : CCTP_CONFIG.domains.ARC_TESTNET;

                let amtInWei; // final USDC amount (6 decimals) that gets burned

                if (srcIsEth) {
                    // Step 0: swap ETH -> USDC on Uniswap V3 before touching CCTP at all.
                    stepNum++;
                    setStatus(`⏳ Step ${stepNum}/${totalSteps} — Swapping ETH → USDC on Uniswap…`);
                    bridgeToast = showToast('pending','Swapping ETH → USDC','Swapping via Uniswap V3 before bridging…');

                    const ethAmountWei = ethers.utils.parseEther(amtStr);
                    let quotedOut;
                    try {
                        quotedOut = await getSwapQuote(weth, sourceConfig.usdc, ethAmountWei);
                    } catch (quoteErr) {
                        throw new Error('Could not get a Uniswap quote for ETH → USDC — the Sepolia testnet pool may be temporarily unavailable.');
                    }
                    const minOut = applySlippage(quotedOut, 3); // 3% slippage tolerance

                    const router = new ethers.Contract(swapRouter02, SWAP_ROUTER_02_ABI, signer);
                    const swapTx = await withRpcRetry(
                        () => router.exactInputSingle({
                            tokenIn: weth,
                            tokenOut: sourceConfig.usdc,
                            fee: poolFee,
                            recipient: currentAccount,
                            amountIn: ethAmountWei,
                            amountOutMinimum: minOut,
                            sqrtPriceLimitX96: 0
                        }, { value: ethAmountWei }),
                        { onRetry: onRpcRetry }
                    );
                    updateToast(bridgeToast, 'pending','Confirming Swap','Waiting for the ETH → USDC swap to confirm…');
                    setStatus(`⏳ Step ${stepNum}/${totalSteps} — Waiting for swap confirmation…`);
                    const swapReceipt = await withRpcRetry(() => swapTx.wait(), { onRetry: onRpcRetry });

                    // Trust the actual Transfer amount over the quote — price can
                    // move slightly between quoting and execution.
                    const received = sumTransfersTo(swapReceipt, sourceConfig.usdc, currentAccount);
                    amtInWei = received.isZero() ? quotedOut : received;
                } else {
                    amtInWei = ethers.utils.parseUnits(amtStr, 6); // USDC has 6 decimals
                }

                // Fetch the current Fast Transfer fee for this route instead of
                // hardcoding it. Per Circle's docs, if maxFee is below the live
                // minimum Fast Transfer fee, the burn is silently downgraded to a
                // Standard Transfer (13-19 min finality on Sepolia) instead of
                // failing outright — which is what was causing "Attestation not
                // ready yet" even though the burn itself succeeded.
                let maxFee = ethers.utils.parseUnits('0.0005', 6); // conservative fallback (must stay well below tiny test amounts)
                try {
                    const feeResp = await fetch(`${CCTP_CONFIG.attestationApi.replace('/messages', '')}/burn/USDC/fees/${srcDomain}/${destDomain}`);
                    if (feeResp.ok) {
                        const feeData = await feeResp.json();
                        const fastFeeEntry = Array.isArray(feeData) ? feeData.find(f => f.finalityThreshold <= 1000) || feeData[0] : null;
                        if (fastFeeEntry && typeof fastFeeEntry.minimumFee === 'number') {
                            // minimumFee is in basis points; add a 20% buffer as Circle recommends
                            const protocolFee = amtInWei.mul(Math.round(fastFeeEntry.minimumFee * 100)).div(1_000_000);
                            const buffered = protocolFee.mul(120).div(100);
                            if (buffered.gt(0)) maxFee = buffered;
                        }
                    }
                } catch (feeErr) {
                    console.log('Fee lookup failed, using fallback maxFee:', feeErr);
                }
                // depositForBurn requires maxFee strictly < amount. Clamp so tiny
                // test transfers never revert with "Max fee must be less than amount".
                if (maxFee.gte(amtInWei)) {
                    maxFee = amtInWei.gt(1) ? amtInWei.sub(1) : ethers.BigNumber.from(0);
                }

                // Step: Approve TokenMessenger
                stepNum++;
                setStatus(`⏳ Step ${stepNum}/${totalSteps} — Approving USDC spend…`);
                bridgeToast = showToast('pending','Approving USDC','Requesting spend approval for USDC…');

                const usdc = new ethers.Contract(sourceConfig.usdc, ERC20_ABI, signer);
                const allowance = await withRpcRetry(
                    () => usdc.allowance(currentAccount, sourceConfig.tokenMessenger),
                    { onRetry: onRpcRetry }
                );

                if (allowance.lt(amtInWei)) {
                    const approveTx = await withRpcRetry(
                        () => usdc.approve(sourceConfig.tokenMessenger, ethers.constants.MaxUint256),
                        { onRetry: onRpcRetry }
                    );
                    updateToast(bridgeToast, 'pending','Waiting for Approval','Confirming approval on-chain…');
                    setStatus(`⏳ Step ${stepNum}/${totalSteps} — Waiting for approval confirmation…`);
                    await withRpcRetry(() => approveTx.wait(), { onRetry: onRpcRetry });
                }

                // Step: Burn USDC on source chain
                stepNum++;
                setStatus(`⏳ Step ${stepNum}/${totalSteps} — Burning USDC on source chain…`);
                updateToast(bridgeToast, 'pending','Burning USDC','Initiating CCTP burn transaction…');

                const tokenMessenger = new ethers.Contract(sourceConfig.tokenMessenger, TOKEN_MESSENGER_ABI, signer);
                const burnTx = await withRpcRetry(
                    () => tokenMessenger.depositForBurn(
                        amtInWei,
                        destDomain,
                        addressToBytes32(currentAccount),
                        sourceConfig.usdc,
                        ethers.constants.HashZero, // destinationCaller = any
                        maxFee,
                        1000 // minFinalityThreshold: 1000 or less = Fast Transfer (per Circle's CCTP v2 docs)
                    ),
                    { onRetry: onRpcRetry }
                );

                updateToast(bridgeToast, 'pending','Confirming Burn','Waiting for burn confirmation…');
                setStatus(`⏳ Step ${stepNum}/${totalSteps} — Waiting for burn confirmation…`);
                const burnReceipt = await withRpcRetry(() => burnTx.wait(), { onRetry: onRpcRetry });
                burnTxHash = burnReceipt.transactionHash;
                displayAmt = parseFloat(ethers.utils.formatUnits(amtInWei, 6));

                // Persist the burn immediately. From this point on, the USDC is
                // already gone from the source chain — if the attestation poll
                // below times out, a retry must resume here, NOT burn (or swap) again.
                savePendingBridge(currentAccount, sourceChain, destChain, {
                    txHash: burnTxHash,
                    amount: displayAmt,
                    timestamp: Date.now()
                });
            }

            // Step: Mint USDC on destination chain
            stepNum++;
            setStatus(`⏳ Step ${stepNum}/${totalSteps} — Retrieving attestation and minting…`);
            updateToast(bridgeToast, 'pending','Retrieving Attestation','Fetching Circle attestation…');

            // Poll for attestation — per Circle's official CCTP v2 API
            // (GET /v2/messages/{sourceDomainId}?transactionHash=...), which
            // returns { messages: [{ status, message, attestation, ... }] }.
            // Only status === 'complete' means the attestation is signed.
            let attestationMsg = null;
            const maxPollTime = 180000; // 180 seconds (3 minutes) per attempt — increased from 90s to give Circle more time to process attestations
                                        // burn stays saved (see savePendingBridge above)
                                        // so clicking "Bridge USDC" again just resumes
                                        // polling instead of burning a second time.
            const pollInterval = 2000;
            const startTime = Date.now();
            const attestationUrl = `${CCTP_CONFIG.attestationApi}/${srcDomain}?transactionHash=${burnTxHash}`;

            while (!attestationMsg && Date.now() - startTime < maxPollTime) {
                try {
                    const response = await fetch(attestationUrl);
                    if (response.ok) {
                        const data = await response.json();
                        if (data?.messages?.[0]?.status === 'complete') {
                            attestationMsg = data.messages[0];
                            break;
                        }
                    }
                    // 404 just means Iris hasn't indexed the tx yet — keep polling.
                } catch (err) {
                    // Attestation poll error - will retry
                }
                await new Promise(r => setTimeout(r, pollInterval));
            }

            if (!attestationMsg) {
                throw new Error('Attestation not ready yet — Circle is still confirming the burn. Your USDC was already burned; click "Bridge USDC" again in a minute to resume (will NOT burn again).');
            }

            updateToast(bridgeToast, 'pending','Minting USDC','Minting USDC on destination chain…');
            setStatus(`⏳ Step ${stepNum}/${totalSteps} — Minting USDC on destination chain…`);

            // Switch to destination chain
            await switchToChain(
                destChain === 'ethereumSepolia' ? ETHEREUM_SEPOLIA_CHAIN.chainId : ARC_CHAIN.chainId,
                destChain === 'ethereumSepolia' ? ETHEREUM_SEPOLIA_CHAIN : ARC_CHAIN
            );
            await new Promise(r => setTimeout(r, 400));

            const destProvider = new ethers.providers.Web3Provider(window.ethereum);
            const destSigner = destProvider.getSigner();

            const messageTransmitter = new ethers.Contract(destConfig.messageTransmitter, MESSAGE_TRANSMITTER_ABI, destSigner);

            // receiveMessage(message, attestation) — both values come straight
            // from the Iris API response, NOT the burn transaction hash.
            const mintTx = await withRpcRetry(
                () => messageTransmitter.receiveMessage(
                    attestationMsg.message,
                    attestationMsg.attestation
                ),
                { onRetry: onRpcRetry }
            );

            updateToast(bridgeToast, 'pending','Confirming Mint','Waiting for mint confirmation…');
            setStatus(`⏳ Step ${stepNum}/${totalSteps} — Waiting for mint confirmation…`);
            const mintReceipt = await withRpcRetry(() => mintTx.wait(), { onRetry: onRpcRetry });

            // Mint succeeded — the pending burn is fully resolved, clear it so
            // the next bridge starts fresh instead of trying to resume this one.
            clearPendingBridge(currentAccount, sourceChain, destChain);

            // Read the exact minted amount from the mint tx's Transfer log —
            // it can be marginally less than what was burned (protocol fee).
            const mintedWei = sumTransfersTo(mintReceipt, destConfig.usdc, currentAccount);
            const mintedUsdc = mintedWei.isZero() ? displayAmt : parseFloat(ethers.utils.formatUnits(mintedWei, 6));

            let finalReceiveLabel = `${mintedUsdc.toFixed(2)} USDC`;
            let mintTxForDisplay = mintReceipt.transactionHash;

            if (dstIsEth) {
                // Final step: swap the freshly-minted USDC into ETH on Uniswap,
                // then unwrap WETH -> native ETH straight to the user's wallet.
                stepNum++;
                setStatus(`⏳ Step ${stepNum}/${totalSteps} — Swapping USDC → ETH on Uniswap…`);
                updateToast(bridgeToast, 'pending','Swapping USDC → ETH','Converting minted USDC to ETH via Uniswap…');

                try {
                    const swapAmountWei = mintedWei.isZero() ? ethers.utils.parseUnits(displayAmt.toString(), 6) : mintedWei;

                    const usdcOnDest = new ethers.Contract(destConfig.usdc, ERC20_ABI, destSigner);
                    const routerAllowance = await withRpcRetry(
                        () => usdcOnDest.allowance(currentAccount, swapRouter02),
                        { onRetry: onRpcRetry }
                    );
                    if (routerAllowance.lt(swapAmountWei)) {
                        const approveSwapTx = await withRpcRetry(
                            () => usdcOnDest.approve(swapRouter02, ethers.constants.MaxUint256),
                            { onRetry: onRpcRetry }
                        );
                        setStatus(`⏳ Step ${stepNum}/${totalSteps} — Approving USDC for swap…`);
                        await withRpcRetry(() => approveSwapTx.wait(), { onRetry: onRpcRetry });
                    }

                    const quotedEthOut = await getSwapQuote(destConfig.usdc, weth, swapAmountWei);
                    const minEthOut = applySlippage(quotedEthOut, 3);

                    const router = new ethers.Contract(swapRouter02, SWAP_ROUTER_02_ABI, destSigner);
                    const swapData = router.interface.encodeFunctionData('exactInputSingle', [{
                        tokenIn: destConfig.usdc,
                        tokenOut: weth,
                        fee: poolFee,
                        recipient: UNI_ADDRESS_THIS, // keep WETH in the router so unwrapWETH9 can pay it out as ETH
                        amountIn: swapAmountWei,
                        amountOutMinimum: minEthOut,
                        sqrtPriceLimitX96: 0
                    }]);
                    const unwrapData = router.interface.encodeFunctionData('unwrapWETH9', [minEthOut, currentAccount]);

                    const swapBackTx = await withRpcRetry(
                        () => router.multicall([swapData, unwrapData]),
                        { onRetry: onRpcRetry }
                    );
                    setStatus(`⏳ Step ${stepNum}/${totalSteps} — Waiting for swap-to-ETH confirmation…`);
                    const swapBackReceipt = await withRpcRetry(() => swapBackTx.wait(), { onRetry: onRpcRetry });

                    finalReceiveLabel = `≈ ${parseFloat(ethers.utils.formatEther(quotedEthOut)).toFixed(6)} ETH`;
                    mintTxForDisplay = swapBackReceipt.transactionHash;
                } catch (swapBackErr) {
                    // The bridge itself already succeeded — the USDC is safely in
                    // the user's wallet even if this last conversion step fails.
                    console.error('USDC -> ETH swap-back error:', swapBackErr);
                    showToast('warning', 'Bridge OK, Swap-to-ETH Failed', `${mintedUsdc.toFixed(2)} USDC arrived safely, but converting it to ETH failed: ${friendlyTxError(swapBackErr)}. You can swap it manually from the Swap tab.`);
                }
            }

            const shortTx = mintTxForDisplay.slice(0, 10) + '…';
            setStatus(`✅ Bridge complete! Tx: ${shortTx}`);
            updateToast(bridgeToast, 'success', 'Bridge Successful! 🎉', `Received ${finalReceiveLabel}. Tx: ${shortTx}`);

            document.getElementById('bridgeAmount').value = '';
            calcBridgeFee();
            updateBridgeBalances();

        } catch (err) {
            console.error('Bridge error:', err);
            if (err.code === 4001 || err.code === 'ACTION_REJECTED') {
                // User only rejected a wallet prompt (swap/approve/burn/mint) — if
                // a burn had already gone through earlier in this session it's
                // still safely persisted for next time, so nothing to undo here.
                setStatus('❌ Transaction rejected by user.');
                if (bridgeToast) updateToast(bridgeToast, 'error', 'Bridge Cancelled', 'You rejected the transaction in your wallet.');
                else showToast('error', 'Bridge Cancelled', 'You rejected the transaction in your wallet.');
            } else {
                const reason = friendlyTxError(err);
                setStatus('❌ Bridge failed: ' + reason);
                // bridgeToast can still be null here (e.g. the network switch before
                // any toast is created failed) — always surface a toast either way.
                if (bridgeToast) updateToast(bridgeToast, 'error', 'Bridge Failed', reason);
                else showToast('error', 'Bridge Failed', reason);
            }
        } finally {
            execBtn.disabled = false;
            execBtn.style.opacity = '1';
        }
    }

    // Init swap tokens on load
    renderSwapTokens();

    /* ── Wallet connect / disconnect ── */
    function setLoading(on) {
        connectBtn.classList.toggle('loading', on);
        if (on) connectBtn.innerText = 'Connecting…';
        else if (!isConnected) connectBtn.innerText = 'Connect Wallet';
    }

    function setConnectedUI(account, bal) {
        connectBtn.innerText = shortAddr(account);
        connectBtn.classList.remove('loading');
        connectBtn.classList.add('connected');
        isConnected    = true;
        currentAccount = account;
        currentBalance = bal;
        renderPortfolioData(account, bal);
        updateSwapBalances();
        updateBridgeBalances();
        updateAdminVisibility();
    }

    function setDisconnectedUI() {
        connectBtn.innerText = 'Connect Wallet';
        connectBtn.classList.remove('connected','loading');
        isConnected    = false;
        currentAccount = null;
        currentBalance = '0';
        clearPortfolioData();
        updateSwapBalances();
        updateBridgeBalances();
        updateAdminVisibility();
    }

    document.addEventListener('walletConnected', () => {
        if (!stakingConfigured()) return;
        updateStakeButtonLabel();
        const view = document.getElementById('stakeView');
        if (view && view.classList.contains('open')) {
            refreshStakeStats();
            loadMyStakes();
        }
    });

    async function connectWallet() {
        if (!window.ethereum) {
            showToast('error','No Wallet Detected','Please install MetaMask or a compatible browser wallet.');
            return;
        }
        setLoading(true);
        try {
            const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
            if (!accounts || accounts.length === 0) throw new Error('No accounts returned');

            // Switch to ARC Testnet; add it first if missing (error 4902)
            try {
                await window.ethereum.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: ARC_CHAIN.chainId }]
                });
            } catch (switchErr) {
                if (switchErr.code === 4902 || switchErr.code === -32603) {
                    await window.ethereum.request({
                        method: 'wallet_addEthereumChain',
                        params: [ARC_CHAIN]
                    });
                } else { throw switchErr; }
            }

            // Add small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));

            const bal = await fetchBalance(accounts[0]);
            setConnectedUI(accounts[0], bal);
            document.dispatchEvent(new Event('walletConnected'));
        } catch(err) {
            console.error('Wallet connect error:', err);
            if (err.code === 4001) showToast('warning','Connection Rejected','Please approve the connection request in your wallet.');
            else if (err.message && err.message.includes('rate limit')) {
                showToast('error','Rate Limited','Please wait a moment and try again. Too many connection attempts.');
            } else {
                showToast('error','Connection Failed', err.message || String(err));
            }
            setDisconnectedUI();
        }
    }

    function openModal() {
        modalAddr.innerText = shortAddr(currentAccount);
        modalBal.innerText  = fmtBal(currentBalance) + ' USDC';
        modal.classList.add('open');
    }
    function closeModal()       { modal.classList.remove('open'); }
    function disconnectWallet() { setDisconnectedUI(); closeModal(); }

    function handleWallet() {
        if (isConnected) openModal();
        else connectWallet();
    }

    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

    if (window.ethereum) {
        window.ethereum.on('accountsChanged', accounts => {
            if (accounts.length === 0) setDisconnectedUI();
            else connectWallet();
        });
        window.ethereum.on('chainChanged', () => {
            // If this fired because our own code called switchToChain (e.g.
            // mid-bridge, hopping to the source then destination network),
            // do NOT reload — that would wipe the in-progress bridge status
            // and dump the user back on the main menu even though the
            // on-chain transaction went through fine. Only a manual network
            // change by the user, made directly in their wallet, should
            // trigger a reload.
            if (programmaticChainSwitch) return;
            window.location.reload();
        });
    }

    /* ── Auto-reconnect wallet on page load/refresh ──
       eth_accounts (tanpa "request") tidak memunculkan popup MetaMask,
       cuma mengecek apakah situs ini sudah pernah diizinkan sebelumnya.
       Kalau ya, langsung connect ulang otomatis tanpa user harus klik lagi. */
    async function tryAutoReconnect() {
        if (!window.ethereum) return;
        try {
            const accounts = await window.ethereum.request({ method: 'eth_accounts' });
            if (accounts && accounts.length > 0) {
                const bal = await fetchBalance(accounts[0]);
                setConnectedUI(accounts[0], bal);
            }
        } catch (err) {
            console.warn('Auto-reconnect wallet gagal:', err);
        }
    }
    tryAutoReconnect();


    /* ══════════════════════════════════════════════════
       POOLS
    ══════════════════════════════════════════════════ */

    function showPools() {
        hideAllOverlays();
        document.getElementById('poolsView').classList.add('open');
        document.body.style.overflow = 'hidden';
        setNavActive('navTrading');
        // auto-load reserves if wallet connected
        if (isConnected) {
            loadReserves('usdc-centic','USDC','CENTIC');
            loadReserves('usdc-eurc','USDC','EURC');
            loadReserves('eurc-centic','EURC','CENTIC');
        }
    }

    function toggleLiqPanel(panelId) {
        const panel = document.getElementById(panelId);
        if (!panel) return;
        panel.classList.toggle('open');
    }

    // Raw numeric reserves per pool, kept separate from the formatted display text
    // so the AMM ratio calculation below always has exact numbers to work with.
    const poolReserveValues = {};

    async function loadReserves(poolKey, symA, symB) {
        // Map sym → TOKENS entry
        const tokA = TOKENS.find(t => t.sym === symA);
        const tokB = TOKENS.find(t => t.sym === symB);
        if (!tokA || !tokB || !window.ethereum) return;

        const idMapA = { 'usdc-centic':'reserve-usdc-centic-usdc', 'usdc-eurc':'reserve-usdc-eurc-usdc', 'eurc-centic':'reserve-eurc-centic-eurc' };
        const idMapB = { 'usdc-centic':'reserve-usdc-centic-centic', 'usdc-eurc':'reserve-usdc-eurc-eurc', 'eurc-centic':'reserve-eurc-centic-centic' };

        const elA = document.getElementById(idMapA[poolKey]);
        const elB = document.getElementById(idMapB[poolKey]);
        if (elA) elA.innerText = '…';
        if (elB) elB.innerText = '…';

        try {
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const pool = new ethers.Contract(CONTRACT_ADDRS.ArcenticMultiPool, POOL_ABI, provider);
            const [rawA, rawB, decA, decB] = await Promise.all([
                pool.reserves(tokA.addr),
                pool.reserves(tokB.addr),
                getDecimals(tokA),
                getDecimals(tokB),
            ]);
            const valA = parseFloat(ethers.utils.formatUnits(rawA, decA));
            const valB = parseFloat(ethers.utils.formatUnits(rawB, decB));
            poolReserveValues[poolKey] = { [symA]: valA, [symB]: valB };
            if (elA) elA.innerText = fmtBal(valA) + ' ' + symA;
            if (elB) elB.innerText = fmtBal(valB) + ' ' + symB;
        } catch(e) {
            if (elA) elA.innerText = 'n/a';
            if (elB) elB.innerText = 'n/a';
        }
    }

    /* AMM-ratio auto-calculation for the Add Liquidity inputs.
       When the user types in one token amount, the paired amount is derived
       from the current pool reserve ratio: amountOut = amountIn * reserveOut / reserveIn
       so the deposit stays balanced with the pool (constant-product AMMs require this). */
    function calcLiqPair(poolKey, symA, symB, inputIdA, inputIdB, source) {
        const reserves = poolReserveValues[poolKey];
        const inputA = document.getElementById(inputIdA);
        const inputB = document.getElementById(inputIdB);
        if (!inputA || !inputB) return;

        const reserveA = reserves ? (reserves[symA] || 0) : 0;
        const reserveB = reserves ? (reserves[symB] || 0) : 0;
        const hasReserves = reserveA > 0 && reserveB > 0;

        // Find or create the "first deposit" hint for this pool panel
        const hintId = 'liq-hint-' + poolKey;
        let hintEl = document.getElementById(hintId);
        if (!hintEl) {
            const btn = document.querySelector('[onclick*="addLiquidity(\''+symA+'\',\''+symB+'\'"]');
            if (btn) {
                hintEl = document.createElement('p');
                hintEl.id = hintId;
                hintEl.style.cssText = 'font-size:.78rem;color:rgba(255,200,80,.85);margin-bottom:10px;margin-top:4px;';
                btn.parentNode.insertBefore(hintEl, btn);
            }
        }

        if (!hasReserves) {
            // Empty pool — both inputs are free, user sets initial price
            if (hintEl) hintEl.innerText = '\u{1F195} Empty pool \u2014 you set the initial price. Enter amounts for both tokens freely.';
            return;
        }

        // Pool has reserves — auto-fill paired amount from ratio
        if (hintEl) hintEl.innerText = '';
        if (source === 'a') {
            const amtA = parseFloat(inputA.value);
            if (!amtA || amtA <= 0) { inputB.value = ''; return; }
            const amtB = amtA * (reserveB / reserveA);
            inputB.value = amtB.toFixed(6).replace(/0+$/,'').replace(/\.$/,'');
        } else {
            const amtB = parseFloat(inputB.value);
            if (!amtB || amtB <= 0) { inputA.value = ''; return; }
            const amtA = amtB * (reserveA / reserveB);
            inputA.value = amtA.toFixed(6).replace(/0+$/,'').replace(/\.$/,'');
        }
    }

    /* Single-sided addLiquidity via contract */
    async function addLiquidity(symA, symB, inputIdA, inputIdB, statusId, btn) {
        if (!isConnected) { showToast('warning','Wallet Not Connected','Please connect your wallet first.'); return; }
        // Guard against double-submit: without this, clicking the button
        // again while a transaction is already in flight fires a second,
        // overlapping addLiquidity() run — duplicate wallet prompts and
        // transactions, and toasts stepping on each other.
        if (btn && btn.disabled) return;

        const tokA = TOKENS.find(t => t.sym === symA);
        const tokB = TOKENS.find(t => t.sym === symB);
        const amtA = parseFloat(document.getElementById(inputIdA).value) || 0;
        const amtB = parseFloat(document.getElementById(inputIdB).value) || 0;

        if (amtA <= 0 && amtB <= 0) { showToast('warning','Invalid Amount','Please enter at least one amount.'); return; }

        const statusEl = document.getElementById(statusId);
        const setStatus = (msg) => {
            statusEl.innerText = msg;
            statusEl.classList.remove('hidden');
        };

        const origBtnText = btn ? btn.innerText : null;
        if (btn) { btn.disabled = true; btn.style.opacity = '.6'; btn.innerText = 'Processing…'; }

        try {
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const signer = provider.getSigner();
            const pool = new ethers.Contract(CONTRACT_ADDRS.ArcenticMultiPool, POOL_ABI, signer);

            const ops = [];
            if (amtA > 0) ops.push({ tok: tokA, amt: amtA });
            if (amtB > 0) ops.push({ tok: tokB, amt: amtB });

            let liqToast = null;
            for (let i = 0; i < ops.length; i++) {
                const { tok, amt } = ops[i];
                try {
                    setStatus(`⏳ (${i+1}/${ops.length}) Approving ${tok.sym}…`);
                    if (i === 0) liqToast = showToast('pending','Adding Liquidity',`Approving ${tok.sym} (${i+1}/${ops.length})…`);
                    else updateToast(liqToast,'pending','Adding Liquidity',`Approving ${tok.sym} (${i+1}/${ops.length})…`);
                    const onRpcRetry = (n, max) => setStatus(`⏳ RPC hiccup — retrying (${n}/${max})…`);
                    const dec = await getDecimals(tok);
                    const amtWei = ethers.utils.parseUnits(amt.toFixed(dec), dec);
                    const erc20 = new ethers.Contract(tok.addr, ERC20_ABI, signer);
                    const allowance = await withRpcRetry(
                        () => erc20.allowance(currentAccount, CONTRACT_ADDRS.ArcenticMultiPool),
                        { onRetry: onRpcRetry }
                    );
                    if (allowance.lt(amtWei)) {
                        const approveTx = await withRpcRetry(
                            () => erc20.approve(CONTRACT_ADDRS.ArcenticMultiPool, ethers.constants.MaxUint256),
                            { onRetry: onRpcRetry }
                        );
                        setStatus(`⏳ Waiting for ${tok.sym} approval…`);
                        updateToast(liqToast,'pending','Waiting for Approval',`Confirming ${tok.sym} approval on-chain…`);
                        await withRpcRetry(() => approveTx.wait(), { onRetry: onRpcRetry });
                    }
                    setStatus(`⏳ Supplying ${tok.sym}…`);
                    updateToast(liqToast,'pending','Supplying Tokens',`Depositing ${amt} ${tok.sym}…`);
                    const tx = await withRpcRetry(
                        () => pool.addLiquidity(tok.addr, amtWei),
                        { onRetry: onRpcRetry }
                    );
                    setStatus(`⏳ Confirming ${tok.sym} supply…`);
                    updateToast(liqToast,'pending','Confirming','Waiting for block confirmation…');
                    await withRpcRetry(() => tx.wait(), { onRetry: onRpcRetry });
                    setStatus(`✅ ${tok.sym} liquidity added!`);
                } catch(err) {
                    if (err.code === 4001 || err.code === 'ACTION_REJECTED') {
                        setStatus('❌ Rejected by user.');
                        if (liqToast) updateToast(liqToast,'error','Transaction Cancelled',`You rejected the ${tok.sym} transaction.`);
                        else showToast('error','Transaction Cancelled',`You rejected the ${tok.sym} transaction.`);
                    } else {
                        const reason = friendlyTxError(err);
                        setStatus('❌ Failed: ' + reason);
                        if (liqToast) updateToast(liqToast,'error','Liquidity Failed', reason);
                        else showToast('error','Liquidity Failed', reason);
                    }
                    return;
                }
            }
            setStatus('✅ All liquidity supplied successfully!');
            updateToast(liqToast,'success','Liquidity Added! 🎉',`${symA}/${symB} liquidity supplied successfully.`);
            document.getElementById(inputIdA).value = '';
            document.getElementById(inputIdB).value = '';
        } finally {
            if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.innerText = origBtnText; }
        }
    }

    function switchLiqTab(poolKey, tab, btn) {
        // update tab buttons
        const addBtn = document.getElementById('tab-add-' + poolKey);
        const remBtn = document.getElementById('tab-remove-' + poolKey);
        if (addBtn) addBtn.classList.remove('active');
        if (remBtn) remBtn.classList.remove('active');
        btn.classList.add('active');
        // show/hide panels
        const addPanel = document.getElementById('liq-' + poolKey + '-add');
        const remPanel = document.getElementById('liq-' + poolKey + '-remove');
        if (addPanel) addPanel.style.display = tab === 'add' ? '' : 'none';
        if (remPanel) remPanel.style.display = tab === 'remove' ? '' : 'none';
        // clear status
        const statusEl = document.getElementById('liq-' + poolKey + '-status');
        if (statusEl) { statusEl.innerText = ''; statusEl.classList.add('hidden'); }
        // ── Key fix: force-load reserves when opening the Withdraw tab so
        //    calcLiqPair always has poolReserveValues populated ──
        if (tab === 'remove' && isConnected) {
            const symMap = {
                'usdc-centic': ['USDC','CENTIC'],
                'usdc-eurc':   ['USDC','EURC'],
                'eurc-centic': ['EURC','CENTIC'],
            };
            const syms = symMap[poolKey];
            if (syms) loadReserves(poolKey, syms[0], syms[1]);
        }
    }

    /* Single-sided removeLiquidity via contract */
    async function removeLiquidity(symA, symB, inputIdA, inputIdB, statusId, btn) {
        if (!isConnected) { showToast('warning','Wallet Not Connected','Please connect your wallet first.'); return; }
        if (btn && btn.disabled) return; // guard against double-submit

        const tokA = TOKENS.find(t => t.sym === symA);
        const tokB = TOKENS.find(t => t.sym === symB);
        const amtA = parseFloat(document.getElementById(inputIdA).value) || 0;
        const amtB = parseFloat(document.getElementById(inputIdB).value) || 0;

        if (amtA <= 0 && amtB <= 0) { showToast('warning','Invalid Amount','Please enter at least one amount to withdraw.'); return; }

        const statusEl = document.getElementById(statusId);
        const setStatus = (msg) => { statusEl.innerText = msg; statusEl.classList.remove('hidden'); };

        const origBtnText = btn ? btn.innerText : null;
        if (btn) { btn.disabled = true; btn.style.opacity = '.6'; btn.innerText = 'Processing…'; }

        try {
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const signer = provider.getSigner();
            const pool = new ethers.Contract(CONTRACT_ADDRS.ArcenticMultiPool, POOL_ABI, signer);

            const ops = [];
            if (amtA > 0) ops.push({ tok: tokA, amt: amtA });
            if (amtB > 0) ops.push({ tok: tokB, amt: amtB });

            let remToast = null;
            for (let i = 0; i < ops.length; i++) {
                const { tok, amt } = ops[i];
                try {
                    setStatus(`⏳ (${i+1}/${ops.length}) Checking LP balance for ${tok.sym}…`);
                    if (i === 0) remToast = showToast('pending','Checking LP Balance',`Verifying your deposited ${tok.sym} balance…`);
                    else updateToast(remToast,'pending','Checking LP Balance',`Verifying your deposited ${tok.sym} balance…`);
                    const onRpcRetry = (n, max) => setStatus(`⏳ RPC hiccup — retrying (${n}/${max})…`);

                    const dec = await getDecimals(tok);
                    const amtWei = ethers.utils.parseUnits(amt.toFixed(dec), dec);

                    // ── Key fix: check on-chain lpBalance before submitting ──
                    const lpRaw = await withRpcRetry(
                        () => pool.lpBalance(currentAccount, tok.addr),
                        { onRetry: onRpcRetry }
                    );
                    if (lpRaw.lt(amtWei)) {
                        const available = parseFloat(ethers.utils.formatUnits(lpRaw, dec));
                        setStatus(`❌ Insufficient LP balance for ${tok.sym}. Available: ${available.toFixed(6)}`);
                        updateToast(remToast,'error','Insufficient LP Balance',
                            `You have only ${available.toFixed(6)} ${tok.sym} deposited in this pool.`);
                        return;
                    }

                    setStatus(`⏳ (${i+1}/${ops.length}) Withdrawing ${tok.sym}…`);
                    updateToast(remToast,'pending','Withdrawing Liquidity',`Sending withdrawal for ${amt} ${tok.sym}…`);
                    const tx = await withRpcRetry(
                        () => pool.removeLiquidity(tok.addr, amtWei),
                        { onRetry: onRpcRetry }
                    );
                    setStatus(`⏳ Confirming ${tok.sym} withdrawal…`);
                    updateToast(remToast,'pending','Confirming Withdrawal','Waiting for block confirmation…');
                    await withRpcRetry(() => tx.wait(), { onRetry: onRpcRetry });
                    setStatus(`✅ ${tok.sym} withdrawn!`);
                } catch(err) {
                    if (err.code === 4001 || err.code === 'ACTION_REJECTED') {
                        setStatus('❌ Rejected by user.');
                        if (remToast) updateToast(remToast,'error','Withdrawal Cancelled',`You rejected the ${tok.sym} withdrawal.`);
                        else showToast('error','Withdrawal Cancelled',`You rejected the ${tok.sym} withdrawal.`);
                    } else {
                        const reason = friendlyTxError(err);
                        setStatus('❌ Failed: ' + reason);
                        if (remToast) updateToast(remToast,'error','Withdrawal Failed', reason);
                        else showToast('error','Withdrawal Failed', reason);
                    }
                    return;
                }
            }
            setStatus('✅ Withdrawal complete!');
            updateToast(remToast,'success','Withdrawal Complete! 🎉',`${symA}/${symB} liquidity returned to your wallet.`);
            document.getElementById(inputIdA).value = '';
            document.getElementById(inputIdB).value = '';
        } finally {
            if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.innerText = origBtnText; }
        }
        // Refresh reserves to reflect new pool state
        loadReserves(symA.toLowerCase() + '-' + symB.toLowerCase(), symA, symB);
    }

    /* ── Add Token Modal ── */
    let atmPool = 'usdc-centic';
    let atmToken = null; // selected token sym

    const ATM_POOLS = {
        'usdc-centic': ['USDC','CENTIC'],
        'usdc-eurc':   ['USDC','EURC'],
        'eurc-centic': ['EURC','CENTIC'],
    };

    function openAddTokenModal() {
        document.getElementById('addTokenModal').classList.add('open');
        setATMPool('usdc-centic', document.getElementById('atm-tab-usdc-centic'));
    }
    function closeATMModal() {
        document.getElementById('addTokenModal').classList.remove('open');
        document.getElementById('atm-status').classList.add('hidden');
        document.getElementById('atm-amount').value = '';
    }

    function setATMPool(poolKey, btn) {
        atmPool = poolKey;
        atmToken = null;
        ['atm-tab-usdc-centic','atm-tab-usdc-eurc','atm-tab-eurc-centic'].forEach(id => {
            document.getElementById(id).classList.remove('active');
        });
        btn.classList.add('active');
        renderATMTokenTabs();
    }

    function renderATMTokenTabs() {
        const container = document.getElementById('atm-token-tabs');
        container.innerHTML = '';
        const syms = ATM_POOLS[atmPool];
        const icons = {
            USDC:  '<img src=\"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiMyNzc1Q0EiLz48cGF0aCBkPSJNMjAuMDIyIDE4LjEyNGMwLTIuMTI0LTEuMjgtMi44NTItMy44NC0zLjE1Ni0xLjgyOC0uMjM0LTIuMTk0LS43MDItMi4xOTQtMS41MTggMC0uODE2LjU0Ni0xLjM2MiAxLjYzMi0xLjM2MiAuOTc1IDAgMS41MjEuMzUxIDEuNzk0IDEuMjE4YS4zOS4zOSAwIDAgMCAuMzY0LjI3M2guODMyYS4zNjQuMzY0IDAgMCAwIC4zNjQtLjM5Yy0uMjM0LTEuNDMtMS4xNy0yLjMtMi42MTItMi41MzRWOS44NzJhLjM5LjM5IDAgMCAwLS4zOS0uMzloLS43OGEuMzkuMzkgMCAwIDAtLjM5LjM5di43OGMtMS41Ni4yNzMtMi41NzQgMS4zMjYtMi41NzQgMi43MyAwIDIuMDQ2IDEuMjQ4IDIuOCAzLjgwOCAzLjEwNCAxLjcxNi4yNzMgMi4yMS42NjMgMi4yMSAxLjU5NnMtLjc4IDEuNTYtMS45NSAxLjU2Yy0xLjUzIDAtMi4wNjctLjY2My0yLjI2Mi0xLjU2YS4zOS4zOSAwIDAgMC0uMzktLjMxMmgtLjg1OGEuMzkuMzkgMCAwIDAtLjM5LjM5Yy4xOTUgMS42MzggMS4zMjYgMi44IDMuMDQyIDMuMDd2LjgyYS4zOS4zOSAwIDAgMCAuMzkuMzloLjc4YS4zOS4zOSAwIDAgMCAuMzktLjM5di0uODJjMS43MTYtLjMxMiAyLjczLTEuNCAyLjczLTIuODg2eiIgZmlsbD0iI2ZmZiIvPjxwYXRoIGQ9Ik0xNiA0QzkuMzczIDQgNCA5LjM3MyA0IDE2czUuMzczIDEyIDEyIDEyIDEyLTUuMzczIDEyLTEyUzIyLjYyNyA0IDE2IDR6bTAgMjEuNzVjLTUuMzg1IDAtOS43NS00LjM2NS05Ljc1LTkuNzVTMTAuNjE1IDYuMjUgMTYgNi4yNSAyNS43NSAxMC42MTUgMjUuNzUgMTYgMjEuMzg1IDI1Ljc1IDE2IDI1Ljc1eiIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==\" style=\"width:22px;height:22px;border-radius:50%;vertical-align:middle;\" alt=\"\">',
            EURC:  '<img src=\"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiMxQTlFNkQiLz48dGV4dCB4PSIxNiIgeT0iMjEiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtZmFtaWx5PSJBcmlhbCxzYW5zLXNlcmlmIiBmb250LXNpemU9IjE2IiBmb250LXdlaWdodD0iYm9sZCIgZmlsbD0iI2ZmZiI+4oKsPC90ZXh0PjxwYXRoIGQ9Ik0xNiA0QzkuMzczIDQgNCA5LjM3MyA0IDE2czUuMzczIDEyIDEyIDEyIDEyLTUuMzczIDEyLTEyUzIyLjYyNyA0IDE2IDR6bTAgMjEuNzVjLTUuMzg1IDAtOS43NS00LjM2NS05Ljc1LTkuNzVTMTAuNjE1IDYuMjUgMTYgNi4yNSAyNS43NSAxMC42MTUgMjUuNzUgMTYgMjEuMzg1IDI1Ljc1IDE2IDI1Ljc1eiIgZmlsbD0iI2ZmZiIgb3BhY2l0eT0iLjYiLz48L3N2Zz4=\" style=\"width:22px;height:22px;border-radius:50%;vertical-align:middle;\" alt=\"\">',
            USDT:  '<img src=\"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiMyNkExN0IiLz48cGF0aCBkPSJNMTcuOTIyIDE3LjM4M3YtLjAwMmMtLjExLjAwOC0uNjc3LjA0Mi0xLjk0Mi4wNDItMS4wMSAwLTEuNzIxLS4wMy0xLjk3MS0uMDQydi4wMDNjLTMuODg4LS4xNzEtNi43OS0uODQ4LTYuNzktMS42NjYgMC0uODE2IDIuOTAyLTEuNDk0IDYuNzktMS42Njh2Mi42NTVjLjI1NC4wMTguOTgyLjA2MSAxLjk4OC4wNjEgMS4yMDcgMCAxLjgxMi0uMDUgMS45MjUtLjA2di0yLjY1NGMzLjg4LjE3MyA2Ljc3NS44NTIgNi43NzUgMS42NjYgMCAuODE2LTIuODk1IDEuNDkzLTYuNzc1IDEuNjY1em0wLTMuNjAzdi0yLjM3OGg1LjQxNFY4LjVIOC42NjR2Mi45MDJoNS40MTR2Mi4zNzdjLTQuNC4yMDItNy43MDggMS4wNzQtNy43MDggMi4xMjcgMCAxLjA1MiAzLjMwOCAxLjkyMyA3LjcwOCAyLjEyNnY3LjYwN2gzLjg0NHYtNy42MDhjNC4zOTEtLjIwMiA3LjY5Mi0xLjA3MyA3LjY5Mi0yLjEyNSAwLTEuMDUyLTMuMzAxLTEuOTI0LTcuNjkyLTIuMTI2eiIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==\" style=\"width:22px;height:22px;border-radius:50%;vertical-align:middle;\" alt=\"\">',
            CENTIC:'<img src=\"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+CiAgPGRlZnM+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImFyYy1nIiB4MT0iMCUiIHkxPSIwJSIgeDI9IjEwMCUiIHkyPSIxMDAlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzM0NzhmZiIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjUwJSIgc3RvcC1jb2xvcj0iIzhiNWNmNiIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiNkNjZiZmYiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgPC9kZWZzPgogIDxjaXJjbGUgY3g9IjE2IiBjeT0iMTYiIHI9IjE1IiBmaWxsPSIjMDcwYzIzIi8+CiAgPGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTQuMjUiIGZpbGw9Im5vbmUiIHN0cm9rZT0idXJsKCNhcmMtZykiIHN0cm9rZS13aWR0aD0iMS41Ii8+CiAgPHBhdGggZD0iTTE2IDcuNSBMMjIuNSAyMi41IEwxOC43IDIyLjUgTDE2IDE1LjggTDEzLjMgMjIuNSBMOS41IDIyLjUgWiIgZmlsbD0idXJsKCNhcmMtZykiLz4KICA8cGF0aCBkPSJNOS41IDIwLjMgQzEyIDE3LjggMjAgMTcuOCAyMi41IDIwLjMiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2U2ZDlmZiIgc3Ryb2tlLXdpZHRoPSIxLjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K\" style=\"width:22px;height:22px;border-radius:50%;vertical-align:middle;\" alt=\"\">'
        };
        syms.forEach((sym, i) => {
            const btn = document.createElement('button');
            btn.className = 'tab-btn' + (i === 0 ? ' active' : '');
            btn.innerHTML = icons[sym] + ' ' + sym;
            btn.onclick = () => {
                container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                atmToken = sym;
                document.getElementById('atm-token-label').innerText = sym;
            };
            if (i === 0) { atmToken = sym; document.getElementById('atm-token-label').innerText = sym; }
            container.appendChild(btn);
        });
    }

    async function execAddToken() {
        if (!isConnected) { showToast('warning','Wallet Not Connected','Please connect your wallet first.'); return; }
        const amt = parseFloat(document.getElementById('atm-amount').value) || 0;
        if (amt <= 0) { showToast('warning','Invalid Amount','Please enter a valid amount.'); return; }
        if (!atmToken) { showToast('warning','No Token Selected','Please select a token.'); return; }

        const tok = TOKENS.find(t => t.sym === atmToken);
        if (!tok) { showToast('error','Token Not Found','The selected token could not be found.'); return; }

        const statusEl = document.getElementById('atm-status');
        const setStatus = (msg) => { statusEl.innerText = msg; statusEl.classList.remove('hidden'); };

        let addTokToast = null;
        try {
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const signer = provider.getSigner();
            const dec = await getDecimals(tok);
            const amtWei = ethers.utils.parseUnits(amt.toFixed(dec), dec);

            setStatus('⏳ Approving token…');
            addTokToast = showToast('pending','Approving Token',`Requesting approval for ${atmToken}…`);
            const onRpcRetry = (n, max) => setStatus(`⏳ RPC hiccup — retrying (${n}/${max})…`);
            const erc20 = new ethers.Contract(tok.addr, ERC20_ABI, signer);
            const allowance = await withRpcRetry(
                () => erc20.allowance(currentAccount, CONTRACT_ADDRS.ArcenticMultiPool),
                { onRetry: onRpcRetry }
            );
            if (allowance.lt(amtWei)) {
                const approveTx = await withRpcRetry(
                    () => erc20.approve(CONTRACT_ADDRS.ArcenticMultiPool, ethers.constants.MaxUint256),
                    { onRetry: onRpcRetry }
                );
                setStatus('⏳ Waiting for approval…');
                updateToast(addTokToast,'pending','Waiting for Approval','Confirming approval on-chain…');
                await withRpcRetry(() => approveTx.wait(), { onRetry: onRpcRetry });
            }
            setStatus('⏳ Adding liquidity…');
            updateToast(addTokToast,'pending','Adding Liquidity',`Depositing ${amt} ${atmToken} into the pool…`);
            const pool = new ethers.Contract(CONTRACT_ADDRS.ArcenticMultiPool, POOL_ABI, signer);
            const tx = await withRpcRetry(
                () => pool.addLiquidity(tok.addr, amtWei),
                { onRetry: onRpcRetry }
            );
            setStatus('⏳ Confirming…');
            updateToast(addTokToast,'pending','Confirming','Waiting for block confirmation…');
            await withRpcRetry(() => tx.wait(), { onRetry: onRpcRetry });
            setStatus('✅ Liquidity added successfully!');
            updateToast(addTokToast,'success','Liquidity Added! 🎉',`${amt} ${atmToken} successfully deposited into the pool.`);
            document.getElementById('atm-amount').value = '';
        } catch(err) {
            if (err.code === 4001 || err.code === 'ACTION_REJECTED') {
                setStatus('❌ Rejected by user.');
                updateToast(addTokToast,'error','Transaction Cancelled','You rejected the transaction in your wallet.');
            } else {
                const reason = friendlyTxError(err);
                setStatus('❌ Failed: ' + reason);
                updateToast(addTokToast,'error','Transaction Failed', reason);
            }
        }
    }

    document.getElementById('addTokenModal').addEventListener('click', e => {
        if (e.target === document.getElementById('addTokenModal')) closeATMModal();
    });

    /* ══════════════════════════════════════════════════
       LIVE DASHBOARD STATS — real-time TVL / volume / stakers / APR
       Tries to read real on-chain reserves from ArcenticMultiPool
       (no wallet connection required, just an injected provider).
       Falls back to a smooth simulated live feed if no provider
       is available, so the dashboard always feels "live".
    ══════════════════════════════════════════════════ */
    // "Pools" stat = jumlah token yang benar-benar dikonfigurasi di TOKENS,
    // bukan angka yang dikarang. Diisi setelah TOKENS terdefinisi di bawah.
    let POOLS_ACTIVE = null;

    // Riwayat TVL hanya diisi dari data on-chain asli (fetchOnChainTVL).
    // Tidak ada seed/fallback palsu — kalau belum ada data, grafik & angka
    // tetap kosong ("—") daripada menampilkan tren yang dikarang.
    let tvlHistory = [];

    // Cached across calls so we don't spin up a fresh set of JSON-RPC
    // connections (and fresh network-detection requests) every single time
    // some UI section wants to do a read.
    let _readOnlyProvider = null;

    function readOnlyProvider() {
        // View/read calls (tiers, TVL, balances, prices, …) used to ride on
        // window.ethereum — i.e. the wallet extension's own RPC connection.
        // That connection is shared with every other dApp/tab the user has
        // open, so under load it returns HTTP 429 "Request is being rate
        // limited" (ethers error code -32005). Ethers can't interpret a 429
        // as a normal revert, so it surfaces as a confusing
        // "missing revert data in call exception" instead of the real cause.
        //
        // Fix: read calls use ARC_CHAIN's own public RPC endpoints via a
        // FallbackProvider instead. If one endpoint is slow/rate-limited,
        // ethers automatically retries against the other endpoint — and as
        // a bonus, reads now work even before the user connects a wallet.
        if (_readOnlyProvider) return _readOnlyProvider;
        try {
            const urls = (ARC_CHAIN && ARC_CHAIN.rpcUrls) || [];
            const jsonRpcProviders = urls.map(url => new ethers.providers.JsonRpcProvider(url));
            if (jsonRpcProviders.length > 1) {
                // quorum 1: any single healthy endpoint answering is enough,
                // we don't need multiple endpoints to agree for read-only UI data
                _readOnlyProvider = new ethers.providers.FallbackProvider(jsonRpcProviders, 1);
            } else if (jsonRpcProviders.length === 1) {
                _readOnlyProvider = jsonRpcProviders[0];
            } else if (typeof window.ethereum !== 'undefined') {
                // No dedicated RPC configured — fall back to the wallet's own
                // provider like before, rather than failing outright.
                _readOnlyProvider = new ethers.providers.Web3Provider(window.ethereum);
            }
        } catch (err) {
            console.error('readOnlyProvider setup failed:', err);
            _readOnlyProvider = null;
        }
        return _readOnlyProvider;
    }

    /* Sum (reserves × rate) across all configured tokens in ArcenticMultiPool */
    async function fetchOnChainTVL() {
        const provider = readOnlyProvider();
        if (!provider) return null;
        try {
            const pool = new ethers.Contract(CONTRACT_ADDRS.ArcenticMultiPool, POOL_ABI, provider);
            // Fetch every token's decimals + reserves in parallel instead of
            // one-by-one in a sequential loop — with N tokens that turned a
            // single admin-panel load into N sequential RPC round-trips.
            const amountsUsd = await Promise.all(TOKENS.map(async (tok) => {
                const [dec, raw] = await Promise.all([getDecimals(tok), pool.reserves(tok.addr)]);
                const amt = parseFloat(ethers.utils.formatUnits(raw, dec));
                return amt * tok.rate;
            }));
            return amountsUsd.reduce((sum, v) => sum + v, 0); // in plain USD
        } catch {
            return null; // contract not deployed at this address / RPC unreachable / etc.
        }
    }

    function fmtUsdCompact(n) {
        if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
        if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
        if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
        return '$' + n.toFixed(0);
    }

    function fmtCount(n) {
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return Math.round(n).toString();
    }

    function redrawHeroChart(history) {
        if (!history || history.length < 2) return; // belum ada cukup data riil untuk digambar
        const min = Math.min(...history), max = Math.max(...history);
        const span = (max - min) || 1;
        const stepX = 1000 / (history.length - 1);
        const points = history.map((v, i) => {
            const x = Math.round(i * stepX);
            const y = Math.round(190 - ((v - min) / span) * 180); // 10..190 px range
            return `${x},${y}`;
        }).join(' ');
        const line = document.getElementById('heroChartLine');
        if (line) line.setAttribute('points', points);
    }

    async function refreshLiveStats() {
        const tvlEl       = document.getElementById('heroTVL');
        const tvlChangeEl = document.getElementById('heroTVLChange');
        const poolsEl     = document.getElementById('heroPools');

        // "Pools" = jumlah token yang benar-benar terdaftar di TOKENS. Data
        // riil dari config, bukan angka yang dikarang.
        if (POOLS_ACTIVE === null && typeof TOKENS !== 'undefined') {
            POOLS_ACTIVE = TOKENS.length;
        }
        if (poolsEl && POOLS_ACTIVE !== null) poolsEl.innerText = POOLS_ACTIVE.toString();

        // ── TVL: HANYA dari data on-chain asli. Kalau kontrak tidak
        // terjangkau / belum ada provider, tampilkan status apa adanya,
        // jangan mengarang angka. ──
        const onChainTvlUsd = await fetchOnChainTVL();
        if (onChainTvlUsd !== null && onChainTvlUsd > 0) {
            const latestTvlM = onChainTvlUsd / 1e6;
            tvlHistory.push(latestTvlM);
            if (tvlHistory.length > 12) tvlHistory.shift();

            if (tvlEl) tvlEl.innerText = fmtUsdCompact(latestTvlM * 1e6);

            if (tvlHistory.length > 1) {
                const firstM = tvlHistory[0];
                const hasSaneBaseline = firstM > latestTvlM * 0.001;
                const pctChange = hasSaneBaseline ? ((latestTvlM - firstM) / firstM) * 100 : null;
                if (tvlChangeEl) {
                    if (pctChange === null) {
                        tvlChangeEl.innerText = 'Live on-chain data';
                        tvlChangeEl.className = 'text-green-400 text-sm';
                    } else {
                        const up = pctChange >= 0;
                        const clamped = Math.min(Math.abs(pctChange), 999.9);
                        tvlChangeEl.innerText = `${up ? '↗' : '↘'} ${clamped.toFixed(1)}% this session`;
                        tvlChangeEl.className = (up ? 'text-green-400' : 'text-red-400') + ' text-sm';
                    }
                }
            } else if (tvlChangeEl) {
                tvlChangeEl.innerText = 'Live on-chain data';
                tvlChangeEl.className = 'text-green-400 text-sm';
            }
            redrawHeroChart(tvlHistory);
        } else {
            // Tidak ada wallet/provider terinjeksi, atau kontrak tidak
            // terjangkau di alamat itu — tampilkan status jujur, jangan
            // menampilkan angka.
            if (tvlEl) tvlEl.innerText = '—';
            if (tvlChangeEl) {
                tvlChangeEl.innerText = typeof window.ethereum === 'undefined'
                    ? 'Connect a wallet to view TVL'
                    : 'On-chain data unavailable';
                tvlChangeEl.className = 'text-gray-400 text-sm';
            }
        }

        // ── Volume / Stakers / APR: TIDAK ADA sumber data on-chain untuk
        // metrik ini di proyek ini saat ini (butuh event-indexer terpisah).
        // Daripada mengarang angka yang bergerak sendiri, tampilkan status
        // jujur sampai indexer-nya benar-benar dibangun. ──
        const volEl        = document.getElementById('heroVolume');
        const volChangeEl  = document.getElementById('heroVolumeChange');
        const stakersEl    = document.getElementById('heroStakers');
        const aprEl        = document.getElementById('heroAPR');
        const aprChangeEl  = document.getElementById('heroAPRChange');
        const activeUsersEl = document.getElementById('trustActiveUsers');

        if (volEl) volEl.innerText = '—';
        if (volChangeEl) volChangeEl.innerText = 'Coming soon';
        if (stakersEl) stakersEl.innerText = '—';
        if (aprEl) aprEl.innerText = '—';
        if (aprChangeEl) aprChangeEl.innerText = 'Coming soon';
        // Sama seperti Volume/Stakers/APR: belum ada indexer untuk jumlah
        // wallet/user aktif, jadi jangan pajang angka karangan (mis. "8.3K+").
        if (activeUsersEl) activeUsersEl.innerText = '👥 Active Users — Coming soon';
    }

    // kick off immediately, then keep polling every 4s for a "live" feel
    refreshLiveStats();
    setInterval(refreshLiveStats, 12000);

    // Boot nav state
    setNavActive('navHome');
    // If lendView is open and wallet connects, refresh
    document.addEventListener('walletConnected', () => { if (document.getElementById('lendView').classList.contains('open')) refreshLendData(); });

    /* ══════════════════════════════════════════════════
       TOAST NOTIFICATION SYSTEM
    ══════════════════════════════════════════════════ */
    /**
     * showToast(type, title, message, duration)
     * type: 'success' | 'error' | 'info' | 'warning' | 'pending'
     * duration: ms — set to 0 for a persistent toast (must be dismissed manually)
     * Returns the toast element so you can update/remove it programmatically.
     */
    function showToast(type, title, message, duration) {
        if (duration === undefined) {
            duration = type === 'pending' ? 0 : (type === 'error' ? 6000 : 4500);
        }
        const icons = { success:'✅', error:'❌', info:'ℹ️', warning:'⚠️', pending:'⏳' };
        const container = document.getElementById('toastContainer');

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;

        const progressStyle = duration > 0
            ? `animation-duration:${duration}ms`
            : 'display:none';

        toast.innerHTML = `
            <div class="toast-icon">${icons[type] || '🔔'}</div>
            <div class="toast-body">
                <div class="toast-title">${escapeHtml(title)}</div>
                ${message ? `<div class="toast-msg">${escapeHtml(message)}</div>` : ''}
            </div>
            <button class="toast-close" onclick="removeToast(this.closest('.toast'))">✕</button>
            <div class="toast-progress" style="${progressStyle}"></div>
        `;

        container.appendChild(toast);

        if (duration > 0) {
            setTimeout(() => removeToast(toast), duration);
        }
        return toast;
    }

    function removeToast(toast) {
        if (!toast || toast.classList.contains('removing')) return;
        toast.classList.add('removing');
        setTimeout(() => toast.remove(), 300);
    }

    /* Update an existing pending toast to success/error when tx completes */
    function updateToast(toast, type, title, message, duration) {
        if (!toast) return;
        const icons = { success:'✅', error:'❌', info:'ℹ️', warning:'⚠️', pending:'⏳' };
        if (duration === undefined) duration = type === 'error' ? 6000 : 5000;
        toast.className = `toast toast-${type}`;
        const iconEl = toast.querySelector('.toast-icon');
        const titleEl = toast.querySelector('.toast-title');
        const msgEl   = toast.querySelector('.toast-msg');
        const progEl  = toast.querySelector('.toast-progress');
        if (iconEl)  iconEl.innerText = icons[type] || '🔔';
        if (titleEl) titleEl.innerText = title;
        if (msgEl)   { msgEl.innerText = message || ''; msgEl.style.display = message ? '' : 'none'; }
        else if (message) {
            const body = toast.querySelector('.toast-body');
            const d = document.createElement('div');
            d.className = 'toast-msg'; d.innerText = message;
            body.appendChild(d);
        }
        if (progEl) {
            progEl.style.cssText = `animation-duration:${duration}ms`;
            // restart animation
            progEl.style.animation = 'none';
            void progEl.offsetWidth;
            progEl.style.animation = '';
        }
        if (duration > 0) setTimeout(() => removeToast(toast), duration);
    }


    /* ======= LEND & BORROW (arc-defi-lend-borrow) ======= */

    const LEND_ABI = [
        'function depositCollateral(uint256 amount)',
        'function takeLoan(uint256 amount)',
        'function repayLoan(uint256 amount)',
        'function withdrawCollateral(uint256 amount)',
        'function collateralBalances(address user) view returns (uint256)',
        'function loans(address user) view returns (uint256 amount, uint256 collateral, bool isActive)',
        'function collateralFactor() view returns (uint256)',
        'function cirBTCPriceUSDC() view returns (uint256)',
        'function owner() view returns (address)',
        'function fundPool(uint256 amount)',
    ];

    const CIRBTC_ABI = [
        'function balanceOf(address account) view returns (uint256)',
        'function decimals() view returns (uint8)',
        'function approve(address spender, uint256 amount) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)',
    ];

    // cirBTC uses 8 decimals (like real BTC), USDC uses 6
    const CIRBTC_DECIMALS = 8;
    const USDC_DECIMALS = 6;

    /* cirBTCPriceUSDC() and collateralFactor() are real on-chain view functions
       (see LEND_ABI above / loadAdminOverview()) and are immutable once deployed
       — there's no setter in the ABI. They used to be duplicated here as hardcoded
       fallback constants ("assumed price for health factor calc — testnet, no
       oracle") and EVERY user-facing number (Max Borrow, Borrow Available, Health
       Factor, deposit/borrow previews) was computed from those hardcoded values
       instead of the live contract state — meanwhile the admin panel read the real
       values. If the deployed contract's actual price/factor ever differed from
       these guesses, users would see a confidently-wrong Health Factor with no
       indication anything was off. Fetch once, cache, and use everywhere below;
       the hardcoded numbers now only serve as a last-resort fallback before the
       first successful fetch (e.g. very first render tick), clearly marked as such. */
    const CIRBTC_PRICE_USDC_FALLBACK = 65000;
    const COLLATERAL_FACTOR_PCT_FALLBACK = 50;
    let liveCirBTCPriceUSDC = null;      // in USDC, e.g. 65000
    let liveCollateralFactorPct = null;  // e.g. 50 meaning 50% — same scale as loadAdminOverview's display

    function currentCirBTCPriceUSDC() {
        return liveCirBTCPriceUSDC !== null ? liveCirBTCPriceUSDC : CIRBTC_PRICE_USDC_FALLBACK;
    }
    function currentCollateralFactor() {
        // returned as a 0–1 fraction for direct use in "* factor" math below
        return (liveCollateralFactorPct !== null ? liveCollateralFactorPct : COLLATERAL_FACTOR_PCT_FALLBACK) / 100;
    }

    /* Fetches and caches cirBTCPriceUSDC()/collateralFactor() once. Safe to call
       repeatedly — only hits the RPC the first time (or after a fetch failure). */
    async function ensureLendConstants(lend) {
        if (liveCirBTCPriceUSDC !== null && liveCollateralFactorPct !== null) return;
        try {
            const [price, factor] = await withRpcRetry(() => Promise.all([
                lend.cirBTCPriceUSDC(),
                lend.collateralFactor(),
            ]));
            liveCirBTCPriceUSDC = parseFloat(ethers.utils.formatUnits(price, USDC_DECIMALS));
            liveCollateralFactorPct = factor.toNumber();
            // Keep the two static "(max 50%)" labels honest — they were previously
            // hardcoded HTML text disconnected from the actual contract value.
            const pctEl1 = document.getElementById('lendMaxBorrowPct');
            const pctEl2 = document.getElementById('lendBorrowMaxPct');
            if (pctEl1) pctEl1.textContent = `USDC (${liveCollateralFactorPct}%)`;
            if (pctEl2) pctEl2.textContent = liveCollateralFactorPct;
        } catch (e) {
            console.error('ensureLendConstants error (falling back to assumed values):', e);
        }
    }

    let lendUserData = { collateral: 0n, loanAmt: 0n, loanActive: false, cirBTCBal: 0n };

    function showLend() {
        hideAllOverlays();
        document.getElementById('lendView').classList.add('open');
        document.body.style.overflow = 'hidden';
        setNavActive('navLend');
        if (currentAccount) refreshLendData();
    }

    function switchLendTab(tab) {
        ['deposit','borrow','repay','withdraw'].forEach(t => {
            document.getElementById('panel' + t.charAt(0).toUpperCase() + t.slice(1)).style.display = t === tab ? '' : 'none';
            document.getElementById('tab' + t.charAt(0).toUpperCase() + t.slice(1)).classList.toggle('active', t === tab);
        });
    }

    async function refreshLendData() {
        if (!currentAccount) return;
        try {
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const lend = new ethers.Contract(CONTRACT_ADDRS.LendingBorrowing, LEND_ABI, provider);
            const cirBTC = new ethers.Contract(CONTRACT_ADDRS.cirBTC, CIRBTC_ABI, provider);

            const [collBig, loanData, bal] = await withRpcRetry(() => Promise.all([
                lend.collateralBalances(currentAccount),
                lend.loans(currentAccount),
                cirBTC.balanceOf(currentAccount),
            ]));
            await ensureLendConstants(lend);

            // collateralBalances() is updated by depositCollateral()/withdrawCollateral() —
            // it's the live collateral balance. loans().collateral is only a snapshot taken
            // at the moment a loan was opened, so it stays 0 until a loan is actually taken.
            lendUserData.collateral = collBig;
            lendUserData.loanAmt = loanData.amount;
            lendUserData.loanActive = loanData.isActive;
            lendUserData.cirBTCBal = bal;

            const collFloat = parseFloat(ethers.utils.formatUnits(collBig, CIRBTC_DECIMALS));
            const loanFloat = parseFloat(ethers.utils.formatUnits(loanData.amount, USDC_DECIMALS));
            const balFloat  = parseFloat(ethers.utils.formatUnits(bal, CIRBTC_DECIMALS));
            const collValueUSDC = collFloat * currentCirBTCPriceUSDC();
            const maxBorrow = collValueUSDC * currentCollateralFactor();

            // Update stat cards
            document.getElementById('lendCollateral').textContent = collFloat.toFixed(6);
            document.getElementById('lendBorrowed').textContent = loanFloat.toFixed(2);
            document.getElementById('lendMaxBorrow').textContent = maxBorrow.toFixed(2);
            document.getElementById('cirBTCBal').textContent = balFloat.toFixed(6);
            document.getElementById('depositBalLabel').textContent = balFloat.toFixed(6);
            document.getElementById('borrowAvailLabel').textContent = Math.max(0, maxBorrow - loanFloat).toFixed(2);
            document.getElementById('borrowAvail').textContent = Math.max(0, maxBorrow - loanFloat).toFixed(2);
            document.getElementById('repayOwed').textContent = loanFloat.toFixed(2);
            document.getElementById('withdrawMax').textContent = collFloat.toFixed(6);

            // Health factor
            if (loanFloat > 0) {
                const hf = collValueUSDC * currentCollateralFactor() / loanFloat;
                const hfEl = document.getElementById('lendHFVal');
                const hfLabel = document.getElementById('lendHFLabel');
                const hfBar = document.getElementById('lendHFBar');
                const badge = document.getElementById('lendHealthBadge');

                if (hfEl) hfEl.textContent = hf.toFixed(2);
                if (hfLabel) hfLabel.textContent = hf.toFixed(2);
                const pct = Math.min(100, (hf / 2) * 100);
                if (hfBar) hfBar.style.width = pct + '%';

                const cls = hf < 1.1 ? 'lend-badge danger' : hf < 1.5 ? 'lend-badge warn' : 'lend-badge success';
                if (badge) { badge.className = cls; badge.style.display = ''; }
                document.getElementById('lendHFPanel').style.display = '';
            } else {
                document.getElementById('lendHealthBadge').style.display = 'none';
                document.getElementById('lendHFPanel').style.display = 'none';
            }

            // Enable action buttons
            ['btnDeposit','btnBorrow','btnRepay','btnWithdraw'].forEach(id => {
                const el = document.getElementById(id);
                if (el) { el.disabled = false; el.textContent = id.replace('btn',''); }
            });
            document.getElementById('btnDeposit').textContent = 'Deposit cirBTC';
            document.getElementById('btnBorrow').textContent = 'Borrow USDC';
            document.getElementById('btnRepay').textContent = 'Repay USDC';
            document.getElementById('btnWithdraw').textContent = 'Withdraw cirBTC';

        } catch(e) {
            console.error('refreshLendData error:', e);
            if (CONTRACT_ADDRS.LendingBorrowing === 'DEPLOY_YOUR_CONTRACT_HERE') {
                showToast('warning', 'Contract Not Set', 'Set LendingBorrowing contract address first', 5000);
            }
        }
    }

    function updateDepositPreview() {
        const amt = parseFloat(document.getElementById('depositAmt').value) || 0;
        document.getElementById('depositPreviewAmt').textContent = amt.toFixed(6) + ' cirBTC';
        document.getElementById('depositPreviewMax').textContent = (amt * currentCirBTCPriceUSDC() * currentCollateralFactor()).toFixed(2) + ' USDC';
    }

    function updateBorrowPreview() {
        const amt = parseFloat(document.getElementById('borrowAmt').value) || 0;
        document.getElementById('borrowPreviewAmt').textContent = amt.toFixed(2) + ' USDC';
        const collFloat = parseFloat(ethers.utils.formatUnits(lendUserData.collateral, CIRBTC_DECIMALS));
        const collVal = collFloat * currentCirBTCPriceUSDC();
        const existingLoan = parseFloat(ethers.utils.formatUnits(lendUserData.loanAmt, USDC_DECIMALS));
        const totalLoan = existingLoan + amt;
        const hf = totalLoan > 0 ? (collVal * currentCollateralFactor()) / totalLoan : Infinity;
        const hfEl = document.getElementById('borrowPreviewHF');
        if (hfEl) {
            hfEl.textContent = isFinite(hf) ? hf.toFixed(2) : '∞';
            hfEl.className = hf < 1.1 ? 'text-red-400' : hf < 1.5 ? 'text-yellow-400' : 'text-green-400';
        }
    }

    function setLendMax(type) {
        if (type === 'deposit') {
            const bal = parseFloat(ethers.utils.formatUnits(lendUserData.cirBTCBal, CIRBTC_DECIMALS));
            document.getElementById('depositAmt').value = bal.toFixed(6);
            updateDepositPreview();
        } else if (type === 'borrow') {
            const el = document.getElementById('borrowAvail');
            if (el) document.getElementById('borrowAmt').value = parseFloat(el.textContent).toFixed(2);
            updateBorrowPreview();
        } else if (type === 'repay') {
            const el = document.getElementById('repayOwed');
            if (el) document.getElementById('repayAmt').value = parseFloat(el.textContent).toFixed(2);
        } else if (type === 'withdraw') {
            const el = document.getElementById('withdrawMax');
            if (el) document.getElementById('withdrawAmt').value = parseFloat(el.textContent).toFixed(6);
        }
    }

    /* NOTE: like every other transactional feature (stake/swap/bridge/admin),
       lending reads/writes are wrapped in withRpcRetry so a single transient
       RPC hiccup doesn't fail the whole action, and every "pending" toast is
       always resolved via updateToast (success OR error) so it can never get
       stuck on screen forever. */
    async function lendEnsureApproval(tokenAddr, abi, spender, amountBig, signer, toast, label) {
        const token = new ethers.Contract(tokenAddr, abi, signer);
        const onRpcRetry = (n, max) => toast && updateToast(toast, 'pending', label, `RPC hiccup — retrying (${n}/${max})…`);
        const allowance = await withRpcRetry(() => token.allowance(currentAccount, spender), { onRetry: onRpcRetry });
        if (allowance.lt(amountBig)) {
            if (toast) updateToast(toast, 'pending', label, 'Requesting spend approval…');
            const tx = await withRpcRetry(() => token.approve(spender, ethers.constants.MaxUint256), { onRetry: onRpcRetry });
            if (toast) updateToast(toast, 'pending', label, 'Confirming approval on-chain…');
            await withRpcRetry(() => tx.wait(), { onRetry: onRpcRetry });
        }
    }

    async function doDeposit() {
        if (!currentAccount) { connectWallet(); return; }
        const amt = parseFloat(document.getElementById('depositAmt').value);
        if (!amt || amt <= 0) return showToast('error', 'Invalid Amount', 'Enter a valid amount');
        const btn = document.getElementById('btnDeposit');
        btn.disabled = true;
        const toast = showToast('pending', 'Depositing', 'Sending transaction...', 0);
        try {
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const signer = provider.getSigner();
            const amtBig = ethers.utils.parseUnits(amt.toFixed(CIRBTC_DECIMALS), CIRBTC_DECIMALS);
            const onRpcRetry = (n, max) => updateToast(toast, 'pending', 'Depositing', `RPC hiccup — retrying (${n}/${max})…`);
            await lendEnsureApproval(CONTRACT_ADDRS.cirBTC, CIRBTC_ABI, CONTRACT_ADDRS.LendingBorrowing, amtBig, signer, toast, 'Depositing');
            const lend = new ethers.Contract(CONTRACT_ADDRS.LendingBorrowing, LEND_ABI, signer);
            updateToast(toast, 'pending', 'Depositing', 'Sending transaction...');
            const tx = await withRpcRetry(() => lend.depositCollateral(amtBig), { onRetry: onRpcRetry });
            updateToast(toast, 'pending', 'Depositing', 'Waiting for confirmation…');
            await withRpcRetry(() => tx.wait(), { onRetry: onRpcRetry });
            updateToast(toast, 'success', 'Deposited!', amt.toFixed(6) + ' cirBTC deposited as collateral', 6000);
            document.getElementById('depositAmt').value = '';
            await refreshLendData();
        } catch(e) {
            console.error('doDeposit error:', e);
            updateToast(toast, 'error', 'Deposit Failed', friendlyTxError(e), 6000);
        } finally {
            btn.disabled = false;
        }
    }

    async function doBorrow() {
        if (!currentAccount) { connectWallet(); return; }
        const amt = parseFloat(document.getElementById('borrowAmt').value);
        if (!amt || amt <= 0) return showToast('error', 'Invalid Amount', 'Enter a valid amount');
        const btn = document.getElementById('btnBorrow');
        btn.disabled = true;
        const toast = showToast('pending', 'Borrowing', 'Sending transaction...', 0);
        try {
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const signer = provider.getSigner();
            const amtBig = ethers.utils.parseUnits(amt.toFixed(USDC_DECIMALS), USDC_DECIMALS);
            const onRpcRetry = (n, max) => updateToast(toast, 'pending', 'Borrowing', `RPC hiccup — retrying (${n}/${max})…`);
            const lend = new ethers.Contract(CONTRACT_ADDRS.LendingBorrowing, LEND_ABI, signer);
            const tx = await withRpcRetry(() => lend.takeLoan(amtBig), { onRetry: onRpcRetry });
            updateToast(toast, 'pending', 'Borrowing', 'Waiting for confirmation…');
            await withRpcRetry(() => tx.wait(), { onRetry: onRpcRetry });
            updateToast(toast, 'success', 'Borrowed!', amt.toFixed(2) + ' USDC sent to your wallet', 6000);
            document.getElementById('borrowAmt').value = '';
            await refreshLendData();
        } catch(e) {
            console.error('doBorrow error:', e);
            updateToast(toast, 'error', 'Borrow Failed', friendlyTxError(e), 6000);
        } finally {
            btn.disabled = false;
        }
    }

    async function doRepay() {
        if (!currentAccount) { connectWallet(); return; }
        const amt = parseFloat(document.getElementById('repayAmt').value);
        if (!amt || amt <= 0) return showToast('error', 'Invalid Amount', 'Enter a valid amount');
        const btn = document.getElementById('btnRepay');
        btn.disabled = true;
        const toast = showToast('pending', 'Repaying', 'Sending transaction...', 0);
        try {
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const signer = provider.getSigner();
            const amtBig = ethers.utils.parseUnits(amt.toFixed(USDC_DECIMALS), USDC_DECIMALS);
            const onRpcRetry = (n, max) => updateToast(toast, 'pending', 'Repaying', `RPC hiccup — retrying (${n}/${max})…`);
            await lendEnsureApproval(CONTRACT_ADDRS.USDC, ['function approve(address,uint256) returns(bool)','function allowance(address,address) view returns(uint256)'], CONTRACT_ADDRS.LendingBorrowing, amtBig, signer, toast, 'Repaying');
            const lend = new ethers.Contract(CONTRACT_ADDRS.LendingBorrowing, LEND_ABI, signer);
            updateToast(toast, 'pending', 'Repaying', 'Sending transaction...');
            const tx = await withRpcRetry(() => lend.repayLoan(amtBig), { onRetry: onRpcRetry });
            updateToast(toast, 'pending', 'Repaying', 'Waiting for confirmation…');
            await withRpcRetry(() => tx.wait(), { onRetry: onRpcRetry });
            updateToast(toast, 'success', 'Repaid!', amt.toFixed(2) + ' USDC repaid', 6000);
            document.getElementById('repayAmt').value = '';
            await refreshLendData();
        } catch(e) {
            console.error('doRepay error:', e);
            updateToast(toast, 'error', 'Repay Failed', friendlyTxError(e), 6000);
        } finally {
            btn.disabled = false;
        }
    }

    async function doWithdraw() {
        if (!currentAccount) { connectWallet(); return; }
        const amt = parseFloat(document.getElementById('withdrawAmt').value);
        if (!amt || amt <= 0) return showToast('error', 'Invalid Amount', 'Enter a valid amount');
        const btn = document.getElementById('btnWithdraw');
        btn.disabled = true;
        const toast = showToast('pending', 'Withdrawing', 'Sending transaction...', 0);
        try {
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            const signer = provider.getSigner();
            const amtBig = ethers.utils.parseUnits(amt.toFixed(CIRBTC_DECIMALS), CIRBTC_DECIMALS);
            const onRpcRetry = (n, max) => updateToast(toast, 'pending', 'Withdrawing', `RPC hiccup — retrying (${n}/${max})…`);
            const lend = new ethers.Contract(CONTRACT_ADDRS.LendingBorrowing, LEND_ABI, signer);
            const tx = await withRpcRetry(() => lend.withdrawCollateral(amtBig), { onRetry: onRpcRetry });
            updateToast(toast, 'pending', 'Withdrawing', 'Waiting for confirmation…');
            await withRpcRetry(() => tx.wait(), { onRetry: onRpcRetry });
            updateToast(toast, 'success', 'Withdrawn!', amt.toFixed(6) + ' cirBTC returned', 6000);
            document.getElementById('withdrawAmt').value = '';
            await refreshLendData();
        } catch(e) {
            console.error('doWithdraw error:', e);
            updateToast(toast, 'error', 'Withdraw Failed', friendlyTxError(e), 6000);
        } finally {
            btn.disabled = false;
        }
    }

    /* ======= EIJI AI AGENT ======= */
    // API keys loaded from secrets.js (excluded from git)

    const EIJI_SYSTEM = `Kamu adalah Eiji, AI Agent milik ARCENTIC — sebuah DEX (Decentralized Exchange) yang berjalan di ARC Testnet.

Kepribadianmu:
- Ramah, santai, dan sedikit gaya seperti teman yang paham crypto
- ATURAN BAHASA (PALING PENTING, JANGAN DILANGGAR): selalu balas dalam BAHASA YANG SAMA dengan pesan TERAKHIR dari user, bukan bahasa pesan sebelumnya. Kalau pesan terakhir user dalam Bahasa Inggris (termasuk kata singkat seperti "welcome", "thanks", "ok", "yes"), balas dalam Bahasa Inggris. Kalau dalam Bahasa Indonesia, balas dalam Bahasa Indonesia. Jangan menebak-nebak dari history sebelumnya, ikuti pesan terakhir.
- Bisa ngobrol dalam bahasa apapun yang dipakai user (Indonesia, Inggris, dll)
- Kalau user pakai bahasa gaul/slang, kamu ikut santai juga
- Selalu jujur kalau tidak tahu sesuatu

Kemampuanmu:
- Kamu PUNYA AKSES ke data real-time lewat tools: get_crypto_price (harga kripto live dari CoinGecko), get_weather (cuaca live dari Open-Meteo), web_search (pencarian web live lewat Tavily), dan get_trending_coins (koin trending + top gainer 24 jam live dari CoinGecko)
- KOIN NAIK/PUMP/REKOMENDASI: kalau user tanya "koin apa yang lagi naik/hot/trending", "top gainer", atau minta rekomendasi/koin yang "berpotensi pump", panggil get_trending_coins lalu tampilkan datanya apa adanya. TAPI JANGAN PERNAH menjanjikan atau memastikan sebuah koin akan naik/pump. Selalu sertakan disclaimer bahwa ini DATA pasar, bukan jaminan dan bukan saran investasi (DYOR). Jujur bahwa tidak ada yang bisa memprediksi pump dengan pasti.
- BATASAN TOOL (PENTING): get_crypto_price HANYA untuk cryptocurrency/token yang benar-benar ada (bitcoin, ethereum, dst). Kalau user menanyakan SIAPA/APA seseorang, tempat, istilah, atau hal apapun yang BUKAN nama coin kripto yang jelas — JANGAN coba get_crypto_price. Gunakan web_search untuk itu.
- Kalau kamu ragu apakah sesuatu itu nama koin kripto atau bukan, gunakan web_search dulu untuk memastikan, jangan asumsikan itu koin
- ATURAN WAJIB: kamu HARUS memanggil tool lewat mekanisme function-call yang sebenarnya (bukan menulis teks seperti kode/JSON di jawabanmu). JANGAN PERNAH menulis sesuatu seperti "(function=...)" atau menampilkan format JSON mentah ke user — itu salah. Panggil tool secara nyata, lalu jawab dengan kalimat natural berdasarkan hasilnya
- ATURAN WAJIB: kalau user menanyakan apapun yang butuh info terkini/aktual (harga, cuaca, berita, hasil pertandingan, siapa pemenang/juara, peringkat, status terbaru sesuatu, siapa/apa itu X yang tidak kamu kenal, dll), kamu HARUS memanggil tool yang sesuai dulu — JANGAN PERNAH hanya menyebutkan "aku bisa cari pakai web_search" tanpa benar-benar memanggilnya. Langsung panggil tool-nya.
- Kalau pertanyaannya tentang prediksi/opini pribadi (misal "siapa MENURUTMU akan menang"), tetap panggil web_search dulu untuk dapat konteks terkini (misal odds, ranking, berita terbaru), baru beri jawaban berdasarkan data itu sambil tetap jujur bahwa itu prediksi bukan kepastian
- Kalau tool mengembalikan error (misal koin tidak ditemukan), sampaikan dengan jujur ke user dan coba tanya ulang nama/symbol yang benar
- Menjelaskan konsep DeFi, Web3, smart contract dengan bahasa mudah dipahami
- Memberikan informasi tentang ARCENTIC, ARC Testnet, token: USDC, EURC, CENTIC
- Punya pengetahuan umum tentang kripto, DeFi, blockchain sebagai konteks tambahan
- PELAJARAN & SOAL: kamu bisa membantu SEMUA jenis pertanyaan pelajaran/akademik — matematika, fisika, kimia, biologi, sejarah, bahasa, soal ujian, sampai rumus yang sulit. Kerjakan LANGKAH DEMI LANGKAH sampai dapat jawaban akhir yang jelas. Kalau butuh fakta terbaru, pakai web_search dulu.
- FORMAT MATEMATIKA: tulis rumus & perhitungan dalam teks biasa yang mudah dibaca (pakai simbol seperti ×, ÷, ^, √, π, ≤, ≥, dan pecahan bentuk a/b). JANGAN pakai LaTeX atau format kode ($...$, \\frac, dll) karena tidak ter-render dan malah membingungkan user.
- MEMBUAT PPT/PRESENTASI: kalau user minta dibuatkan PPT/slide/presentasi, susun sendiri isinya (5-10 slide, tiap slide judul + 3-6 poin ringkas) lalu PANGGIL tool create_presentation. Setelah tool sukses, beri tahu user bahwa file .pptx sudah otomatis ter-download (cek folder Download) dan sebutkan singkat isi slide-nya.
- ALAT FILE (tombol di panel chat ini, BUKAN tool AI): ada tombol kamera 📷 untuk "Perbaiki Foto / Scan Dokumen", dan tombol 🔄 untuk "Konversi File" (gambar JPG/PNG/WEBP, serta video/audio → MP3/WAV termasuk MP4→MP3). Kalau user tanya cara memperbaiki foto, scan dokumen, atau mengubah/convert file (mis. MP4 ke MP3), arahkan mereka klik tombol 📷 atau 🔄 di kolom ketik chat ini. Semua diproses gratis di perangkat mereka.
- LOKASI/TEMPAT: kalau user menanyakan tempat/alamat/lokasi (pabrik, kantor, toko, resto, wisata, dll), setelah cari infonya lewat web_search, SELALU sertakan link Google Maps yang bisa langsung diklik dengan format PERSIS: https://www.google.com/maps/search/?api=1&query=NAMA_ATAU_ALAMAT_TEMPAT (ganti spasi dengan +, mis. https://www.google.com/maps/search/?api=1&query=Pabrik+Yakult+Sukabumi). Kalau ada beberapa lokasi, beri satu link Maps untuk tiap lokasi.
- FORMAT LINK (PENTING): tulis URL LENGKAP apa adanya (diawali https://). JANGAN pakai format markdown [teks](url) dan JANGAN singkat/potong URL-nya — cukup tempel URL utuh, nanti otomatis jadi tautan yang bisa diklik.

Yang TIDAK bisa kamu lakukan:
- Mengeksekusi transaksi — itu dilakukan user sendiri di DEX
- Memberikan saran investasi yang dijamin profit

BATASAN KONTEN (WAJIB, TIDAK BISA DITAWAR):
- JANGAN PERNAH memberikan, mencari, atau menautkan konten pornografi/seksual eksplisit, konten yang mengeksploitasi anak, kekerasan ekstrem/gore, atau materi ilegal (narkoba, senjata, peretasan/malware, penipuan, dsb).
- Kalau user meminta hal-hal di atas (termasuk minta "link porno" atau situs dewasa), TOLAK dengan sopan dan singkat, jangan panggil tool apa pun untuk itu, dan jangan tampilkan URL apa pun. Arahkan kembali ke topik ARCENTIC/kripto/DeFi atau info umum yang aman.
- Tetap ramah tapi tegas; tidak perlu menghakimi, cukup katakan kamu tidak bisa membantu untuk permintaan itu.
- FILM/MOVIE: boleh memberi info film (judul, sinopsis, rating) dan HANYA link RESMI/legal — trailer di channel resmi, IMDb, atau platform legal (Netflix, Disney+, Prime Video, Vidio, bioskop). JANGAN PERNAH memberi link download/streaming bajakan atau situs subtitle ilegal (mis. situs sejenis LK21/IndoXXI). Kalau user minta film bajakan/subtitle ilegal, tolak sopan dan arahkan ke opsi legal.

Selalu jawab singkat, padat, dan natural. Saat menyebutkan angka harga/cuaca dari tool, sebutkan juga bahwa datanya live/real-time.`;

    /* -- Tool definitions (function calling, format OpenAI/Groq) -- */
    const EIJI_TOOLS = [
        {
            type: 'function',
            function: {
                name: 'get_crypto_price',
                description: 'Mengambil harga real-time sebuah cryptocurrency (USD), termasuk market cap dan perubahan 24 jam, dari CoinGecko. Gunakan setiap kali user menanyakan harga koin/token apapun.',
                parameters: {
                    type: 'object',
                    properties: {
                        coin_id: {
                            type: 'string',
                            description: "ID koin gaya CoinGecko (lowercase), contoh: bitcoin, ethereum, solana, usd-coin, dogecoin, tether. Kalau user pakai simbol singkatan seperti 'btc' atau 'eth', ubah ke nama lengkapnya."
                        }
                    },
                    required: ['coin_id']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'get_weather',
                description: 'Mengambil data cuaca real-time (suhu, kelembapan, kecepatan angin) untuk sebuah kota/lokasi di dunia.',
                parameters: {
                    type: 'object',
                    properties: {
                        location: { type: 'string', description: 'Nama kota atau lokasi, contoh: Medan, Jakarta, Tokyo' }
                    },
                    required: ['location']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'web_search',
                description: 'Mencari informasi terbaru di internet untuk topik apapun (berita, fakta umum, harga di luar kripto, perbandingan, definisi, dll) lewat live web search. Hasilnya berupa ringkasan jawaban plus beberapa sumber/link.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Kata kunci pencarian' }
                    },
                    required: ['query']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'get_trending_coins',
                description: 'Mengambil daftar cryptocurrency yang sedang TRENDING (paling banyak dicari) dan TOP GAINER 24 jam (kenaikan harga terbesar) real-time dari CoinGecko. Panggil saat user bertanya koin apa yang lagi naik/hot/trending, top gainer, atau minta rekomendasi/koin yang "berpotensi pump". Sampaikan hasilnya sebagai DATA pasar disertai disclaimer bahwa ini bukan jaminan/saran investasi.',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'create_presentation',
                description: 'Membuat file presentasi PowerPoint (.pptx) yang otomatis ter-download ke perangkat user. Panggil saat user minta dibuatkan PPT/slide/presentasi tentang suatu topik. KAMU yang menyusun isi slide-nya (judul + poin-poin ringkas) lalu kirim ke tool ini. Buat 5-10 slide isi yang berbobot.',
                parameters: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'Judul presentasi (untuk slide sampul & nama file)' },
                        slides: {
                            type: 'array',
                            description: 'Daftar slide isi.',
                            items: {
                                type: 'object',
                                properties: {
                                    title: { type: 'string', description: 'Judul slide' },
                                    bullets: {
                                        type: 'array',
                                        items: { type: 'string' },
                                        description: 'Poin-poin isi slide (3-6 poin singkat & padat)'
                                    }
                                },
                                required: ['title', 'bullets']
                            }
                        }
                    },
                    required: ['title', 'slides']
                }
            }
        }
    ];

    /* -- Tool implementations: real public APIs, no key required -- */
    async function tool_get_crypto_price(coinIdRaw) {
        try {
            const aliasMap = { btc:'bitcoin', eth:'ethereum', sol:'solana', usdc:'usd-coin', usdt:'tether', bnb:'binancecoin', doge:'dogecoin', xrp:'ripple', ada:'cardano' };
            let id = (coinIdRaw || '').toLowerCase().trim();
            id = aliasMap[id] || id;
            const res = await eijiFetchWithTimeout(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`, {}, 12000);
            const data = await res.json();
            if (!data || !data[id]) return JSON.stringify({ error: `Koin '${id}' tidak ditemukan di CoinGecko. Coba pakai nama lengkap, contoh 'bitcoin' bukan 'btc'.` });
            const d = data[id];
            return JSON.stringify({
                coin: id,
                price_usd: d.usd,
                change_24h_percent: d.usd_24h_change !== undefined ? Number(d.usd_24h_change.toFixed(2)) : null,
                market_cap_usd: d.usd_market_cap,
                source: 'CoinGecko (live)'
            });
        } catch (e) {
            return JSON.stringify({ error: 'Gagal mengambil data harga: ' + e.message });
        }
    }

    async function tool_get_weather(location) {
        try {
            const geoRes = await eijiFetchWithTimeout(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location || '')}&count=1&language=id`, {}, 12000);
            const geoData = await geoRes.json();
            if (!geoData.results || !geoData.results.length) return JSON.stringify({ error: `Lokasi '${location}' tidak ditemukan.` });
            const { latitude, longitude, name, country } = geoData.results[0];
            const wRes = await eijiFetchWithTimeout(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`, {}, 12000);
            const wData = await wRes.json();
            const c = wData.current || {};
            return JSON.stringify({
                location: `${name}, ${country}`,
                temperature_c: c.temperature_2m,
                humidity_percent: c.relative_humidity_2m,
                wind_speed_kmh: c.wind_speed_10m,
                source: 'Open-Meteo (live)'
            });
        } catch (e) {
            return JSON.stringify({ error: 'Gagal mengambil data cuaca: ' + e.message });
        }
    }

    async function tool_create_presentation(args) {
        try {
            const title = (args && args.title) ? String(args.title) : 'Presentasi';
            let slides = args && args.slides;
            if (typeof slides === 'string') { try { slides = JSON.parse(slides); } catch (e) {} }
            if (!Array.isArray(slides) || !slides.length) {
                return JSON.stringify({ error: 'Butuh minimal 1 slide (judul + poin) untuk membuat PPT.' });
            }
            if (typeof PptxGenJS === 'undefined') {
                return JSON.stringify({ error: 'Library pembuat PPT belum termuat. Refresh halaman lalu coba lagi.' });
            }

            const pptx = new PptxGenJS();
            pptx.layout = 'LAYOUT_WIDE';

            const cover = pptx.addSlide();
            cover.background = { color: '0B0F1F' };
            cover.addText(title, { x: 0.5, y: 2.2, w: '90%', h: 1.6, fontSize: 40, bold: true, color: 'FFFFFF', align: 'center' });
            cover.addText('Dibuat oleh Eiji AI \u2022 ARCENTIC', { x: 0.5, y: 4.0, w: '90%', h: 0.5, fontSize: 16, color: '7C93FF', align: 'center' });

            slides.forEach(s => {
                const slide = pptx.addSlide();
                slide.background = { color: 'FFFFFF' };
                slide.addText((s && s.title) ? String(s.title) : '', { x: 0.5, y: 0.3, w: '92%', h: 0.9, fontSize: 28, bold: true, color: '1A1A2E' });
                let bullets = s && s.bullets;
                if (typeof bullets === 'string') bullets = bullets.split('\n');
                if (!Array.isArray(bullets)) bullets = [];
                const items = bullets
                    .filter(b => b !== null && b !== undefined && String(b).trim())
                    .map(b => ({ text: String(b), options: { bullet: true, fontSize: 18, color: '333333', paraSpaceAfter: 8 } }));
                if (items.length) slide.addText(items, { x: 0.7, y: 1.4, w: '88%', h: 5.2, valign: 'top' });
            });

            const safe = title.replace(/[^a-z0-9_\- ]/gi, '').trim().replace(/\s+/g, '_').slice(0, 40) || 'presentasi';
            const fileName = safe + '.pptx';
            await pptx.writeFile({ fileName });
            return JSON.stringify({
                success: true,
                file: fileName,
                slides_count: slides.length,
                note: 'File PPTX sudah otomatis ter-download ke perangkat user. Beri tahu user untuk cek folder Download.'
            });
        } catch (e) {
            return JSON.stringify({ error: 'Gagal membuat PPT: ' + e.message });
        }
    }

    async function tool_get_trending_coins() {
        try {
            const out = {
                source: 'CoinGecko (live)',
                disclaimer: 'Ini DATA pasar real-time, BUKAN jaminan koin akan naik/pump dan BUKAN saran investasi. Harga kripto sangat fluktuatif — selalu DYOR (do your own research).'
            };
            try {
                const tRes = await eijiFetchWithTimeout('https://api.coingecko.com/api/v3/search/trending', {}, 12000);
                const tData = await tRes.json();
                out.trending = (tData.coins || []).slice(0, 7).map(c => ({
                    name: c.item && c.item.name,
                    symbol: c.item && (c.item.symbol || '').toUpperCase(),
                    market_cap_rank: c.item && c.item.market_cap_rank
                }));
            } catch (e) { out.trending = []; }
            try {
                const mRes = await eijiFetchWithTimeout('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h', {}, 12000);
                const mData = await mRes.json();
                out.top_gainers_24h = (Array.isArray(mData) ? mData : [])
                    .filter(c => typeof c.price_change_percentage_24h === 'number')
                    .sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h)
                    .slice(0, 5)
                    .map(c => ({
                        name: c.name,
                        symbol: (c.symbol || '').toUpperCase(),
                        price_usd: c.current_price,
                        change_24h_percent: Number(c.price_change_percentage_24h.toFixed(2))
                    }));
            } catch (e) { out.top_gainers_24h = []; }
            if ((!out.trending || !out.trending.length) && (!out.top_gainers_24h || !out.top_gainers_24h.length)) {
                return JSON.stringify({ error: 'Gagal mengambil data trending/top gainer saat ini. Coba lagi sebentar lagi.' });
            }
            return JSON.stringify(out);
        } catch (e) {
            return JSON.stringify({ error: 'Gagal mengambil data trending: ' + e.message });
        }
    }

    async function tool_web_search(query) {
        try {
            const res = await eijiFetchWithTimeout('/api/tavily', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    query: query || '',
                    search_depth: 'basic',
                    max_results: 5,
                    include_answer: true
                })
            }, 15000);
            const data = await res.json();
            if (!data || (!data.answer && (!data.results || !data.results.length))) {
                return JSON.stringify({ error: 'Tidak ditemukan hasil untuk pencarian ini.' });
            }
            const results = (data.results || []).slice(0, 5).map(r => ({
                title: r.title,
                url: r.url,
                snippet: r.content ? r.content.slice(0, 300) : ''
            }));
            return JSON.stringify({
                query,
                answer: data.answer || null,
                results,
                source: 'Tavily (live web search)'
            });
        } catch (e) {
            return JSON.stringify({ error: 'Gagal melakukan pencarian: ' + e.message });
        }
    }

    const EIJI_TOOL_MAP = {
        get_crypto_price: (args) => tool_get_crypto_price(args.coin_id),
        get_weather: (args) => tool_get_weather(args.location),
        web_search: (args) => tool_web_search(args.query),
        get_trending_coins: () => tool_get_trending_coins(),
        create_presentation: (args) => tool_create_presentation(args)
    };

    /* Safety net: small models sometimes "leak" a fake function call as plain text
       (e.g. "(function=get_crypto_price> {\"coin_id\":\"x\"})") instead of using the
       real tool-calling mechanism. Detect and execute it manually so the user never
       sees raw JSON/code in the chat.

       Also exported: eijiLooksLikeLeakedToolCall(text) — a cheap "is this pattern
       present at all" check used by the caller as a last-resort guard. If the
       regex/brace-matching below fails to fully parse (unknown tool name, malformed
       JSON, mismatched braces from a leaked-but-broken call) we must NOT fall back
       to showing the raw text — that reintroduces exactly the leak this function
       exists to prevent. */
    // Models leak tool calls in MANY shapes. Cover the common ones:
    //   (function=get_crypto_price>{...})      function:get_crypto_price {...}
    //   <function/get_crypto_price>{...}</function>   <function=name>{...}
    //   {"name":"get_crypto_price","arguments":{...}}  (and "parameters")
    //   get_crypto_price(coin_id="bitcoin")     [get_crypto_price(...)]
    //   <|python_tag|>get_crypto_price.call(...)
    function eijiLooksLikeLeakedToolCall(text) {
        if (!text) return false;
        const names = Object.keys(EIJI_TOOL_MAP).join('|');
        return /<?\s*function\s*[=:\/]\s*[a-zA-Z_]/i.test(text)
            || /<\/?function\b/i.test(text)
            || new RegExp('"name"\\s*:\\s*"(?:' + names + ')"', 'i').test(text)
            || new RegExp('(?:^|[\\s\\[<(])(?:' + names + ')\\s*\\(', 'i').test(text)
            || /<\|python_tag\|>/i.test(text);
    }

    // String-aware balanced-brace slice starting at `start` (index of the opening
    // `{`). A plain char-count of `{`/`}` breaks when JSON string VALUES contain
    // literal braces, so we track whether we're inside a quoted string.
    function eijiSliceBalancedBraces(text, start) {
        if (start < 0 || text[start] !== '{') return null;
        let depth = 0, inString = false;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (inString) {
                if (ch === '\\') { i++; continue; }
                if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') inString = true;
            else if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
        }
        return null;
    }

    function eijiResolveToolKey(raw) {
        if (!raw) return null;
        return Object.keys(EIJI_TOOL_MAP).find(k => k.toLowerCase() === raw.toLowerCase()) || null;
    }

    function eijiExtractFakeToolCall(text) {
        if (!text) return null;

        // A) function=name / function:name / function/name (with optional < > wrappers)
        let m = text.match(/function\s*[=:\/]\s*([a-zA-Z_][a-zA-Z0-9_]*)/i);
        if (m) {
            const toolKey = eijiResolveToolKey(m[1]);
            if (toolKey) {
                const braceStart = text.indexOf('{', m.index);
                const jsonStr = braceStart !== -1 ? eijiSliceBalancedBraces(text, braceStart) : null;
                let args = {};
                if (jsonStr) { try { args = JSON.parse(jsonStr); } catch (e) {} }
                return { name: toolKey, args };
            }
        }

        // B) OpenAI-ish JSON: {"name":"tool","arguments":{...}} or "parameters"
        m = text.match(/"name"\s*:\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/i);
        if (m) {
            const toolKey = eijiResolveToolKey(m[1]);
            if (toolKey) {
                let args = {};
                const am = text.match(/"(?:arguments|parameters)"\s*:\s*\{/i);
                if (am) {
                    const braceStart = text.indexOf('{', am.index + am[0].length - 1);
                    const jsonStr = eijiSliceBalancedBraces(text, braceStart);
                    if (jsonStr) { try { args = JSON.parse(jsonStr); } catch (e) {} }
                }
                return { name: toolKey, args };
            }
        }

        // C) Call syntax: get_crypto_price(coin_id="bitcoin", ...) — best-effort kv parse
        for (const name of Object.keys(EIJI_TOOL_MAP)) {
            const callRe = new RegExp(name + '\\s*\\(([^)]*)\\)', 'i');
            const cm = text.match(callRe);
            if (cm) {
                const args = {};
                const inner = cm[1] || '';
                const kvRe = /([a-zA-Z_][a-zA-Z0-9_]*)\s*[=:]\s*("([^"]*)"|'([^']*)'|[^,]+)/g;
                let kv;
                while ((kv = kvRe.exec(inner))) {
                    const val = kv[3] !== undefined ? kv[3] : (kv[4] !== undefined ? kv[4] : kv[2].trim());
                    args[kv[1]] = val;
                }
                return { name, args };
            }
        }

        return null;
    }

    /* fetch() has no built-in timeout — without this, a stalled /api/groq or
       /api/gemini response (server hung, network black hole, etc.) leaves the
       chat stuck on "typing…" forever with the send button locked, since
       nothing ever resolves or rejects the promise it's awaiting. */
    async function eijiFetchWithTimeout(url, options, timeoutMs = 25000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } catch (err) {
            if (err && err.name === 'AbortError') {
                throw new Error('Request timed out — the AI server took too long to respond.');
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    async function eijiCallGroq(messages, useTools) {
        if (useTools === undefined) useTools = true;
        const body = {
            model: 'llama-3.3-70b-versatile',
            max_tokens: 1024,
            messages
        };
        if (useTools) {
            body.tools = EIJI_TOOLS;
            body.tool_choice = 'auto';
        }
        const res = await eijiFetchWithTimeout('/api/groq', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        const json = await res.json();
        if (!res.ok) {
            const apiMsg = (json && json.error && json.error.message) ? json.error.message : JSON.stringify(json);
            throw new Error('Groq API ' + res.status + ': ' + apiMsg);
        }
        return json;
    }

    /* Groq sometimes returns a 400 "Failed to call a function" error when its
       strict tool-call validator rejects the model's attempt. Retry once without
       tools so the user still gets an answer instead of a hard error. */
    async function eijiCallGroqSafe(messages, useTools) {
        if (useTools === undefined) useTools = true;
        try {
            return await eijiCallGroq(messages, useTools);
        } catch (err) {
            if (useTools && err && /failed to call a function/i.test(err.message)) {
                try {
                    return await eijiCallGroq(messages, false);
                } catch (err2) {
                    console.warn('Groq (no-tools) juga gagal, fallback ke OpenRouter:', err2.message);
                    return await eijiCallOpenRouterSafe(messages, useTools);
                }
            }
            // Groq down / rate-limited / 5xx / network error -> fallback ke OpenRouter
            console.warn('Groq gagal (' + err.message + '), fallback ke OpenRouter...');
            return await eijiCallOpenRouterSafe(messages, useTools);
        }
    }

    /* Fallback provider #1: OpenRouter (pakai OPENROUTER_API_KEY di server).
       Body OpenAI-style yang sama diteruskan apa adanya via /api/openrouter,
       jadi semua logic tool-calling tetap jalan. Kalau OpenRouter juga gagal,
       lanjut fallback terakhir ke Gemini. */
    async function eijiCallOpenRouter(messages, useTools) {
        if (useTools === undefined) useTools = true;
        const body = {
            model: 'meta-llama/llama-3.3-70b-instruct',
            max_tokens: 1024,
            messages
        };
        if (useTools) {
            body.tools = EIJI_TOOLS;
            body.tool_choice = 'auto';
        }
        const res = await eijiFetchWithTimeout('/api/openrouter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const json = await res.json();
        if (!res.ok) {
            const apiMsg = (json && json.error && json.error.message) ? json.error.message : JSON.stringify(json);
            throw new Error('OpenRouter API ' + res.status + ': ' + apiMsg);
        }
        return json;
    }

    async function eijiCallOpenRouterSafe(messages, useTools) {
        if (useTools === undefined) useTools = true;
        try {
            return await eijiCallOpenRouter(messages, useTools);
        } catch (err) {
            if (useTools && err && /failed to call a function/i.test(err.message)) {
                try {
                    return await eijiCallOpenRouter(messages, false);
                } catch (err2) {
                    console.warn('OpenRouter (no-tools) juga gagal, fallback ke Gemini:', err2.message);
                    return await eijiCallGeminiSafe(messages, useTools);
                }
            }
            console.warn('OpenRouter gagal (' + err.message + '), fallback ke Gemini...');
            return await eijiCallGeminiSafe(messages, useTools);
        }
    }

    /* Fallback provider: Gemini (free tier kuota harian besar). Endpoint backend
       /api/gemini diharapkan menerima body OpenAI-style yang sama persis dengan
       /api/groq, dan mengembalikan response berformat OpenAI-compatible juga,
       supaya semua logic tool-calling di atas tetap jalan tanpa perubahan. */
    async function eijiCallGemini(messages, useTools) {
        if (useTools === undefined) useTools = true;
        const body = {
            model: 'gemini-2.0-flash',
            max_tokens: 1024,
            messages
        };
        if (useTools) {
            body.tools = EIJI_TOOLS;
            body.tool_choice = 'auto';
        }
        const res = await eijiFetchWithTimeout('/api/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const json = await res.json();
        if (!res.ok) {
            const apiMsg = (json && json.error && json.error.message) ? json.error.message : JSON.stringify(json);
            throw new Error('Gemini API ' + res.status + ': ' + apiMsg);
        }
        return json;
    }

    async function eijiCallGeminiSafe(messages, useTools) {
        if (useTools === undefined) useTools = true;
        try {
            return await eijiCallGemini(messages, useTools);
        } catch (err) {
            if (useTools && err && /failed to call a function/i.test(err.message)) {
                return await eijiCallGemini(messages, false);
            }
            throw err;
        }
    }

    let eijiHistory = [];
    let eijiIsTyping = false;
    let eijiVoiceActive = false;
    let eijiRecognition = null;
    let eijiSynthesis = window.speechSynthesis;
    let eijiVoiceSessionId = null;

    function toggleEiji() {
        const el = document.getElementById('eijiView');
        if (el && el.classList.contains('open')) {
            showHome();
        } else {
            showEiji();
        }
    }

    function showEiji() {
        hideAllOverlays();
        document.getElementById('eijiView').classList.add('open');
        setNavActive('navEiji');
        if (eijiHistory.length === 0) eijiWelcome();
    }

    function eijiWelcome() {
        const lang = (typeof window !== 'undefined' && window.__arcLang === 'en') ? 'en' : 'id';
        const msgsEn = [
            'Hey! I\'m Eiji \u2727\nAsk me anything — token prices, how to swap, or Web3 stuff!',
            'Yo! Eiji here \u270b\nGot questions about crypto, DeFi, or ARCENTIC? Fire away!'
        ];
        const msgsId = [
            'Hai! Aku Eiji \u2727\nTanya apa saja — harga token, cara swap, atau hal seputar Web3!',
            'Halo! Eiji di sini \u270b\nAda pertanyaan soal kripto, DeFi, atau ARCENTIC? Langsung tanya!'
        ];
        const msgs = lang === 'en' ? msgsEn : msgsId;
        appendEijiBubble('agent', msgs[Math.floor(Math.random() * msgs.length)]);
    }

    /* Ubah URL/tautan di jawaban Eiji jadi link yang bisa diklik — dengan AMAN.
       Teks di-escape DULU (anti-XSS), baru URL http(s) & markdown [teks](url)
       diubah jadi <a>. Karena sudah di-escape, tidak ada HTML lain yang lolos. */
    function eijiLinkify(text) {
        let s = escapeHtml(text);
        const anchor = (url, label) =>
            `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:#7c93ff;text-decoration:underline;word-break:break-all;">${label}</a>`;
        // markdown [label](url)
        s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => anchor(url, label));
        // URL polos (lewati yang sudah jadi href="...")
        s = s.replace(/(^|[^"=>])(https?:\/\/[^\s<]+)/g, (m, pre, url) => {
            let trail = '';
            while (/[.,;:!?)\]"']$/.test(url)) { trail = url.slice(-1) + trail; url = url.slice(0, -1); }
            return pre + anchor(url, url) + trail;
        });
        return s;
    }

    function appendEijiBubble(role, text) {
        const container = document.getElementById('eijiMessages');
        const div = document.createElement('div');
        div.className = 'eiji-bubble ' + role;
        if (role === 'agent') {
            const name = document.createElement('div');
            name.className = 'eiji-name';
            name.textContent = '\u2726 EIJI';
            div.appendChild(name);
            const body = document.createElement('div');
            body.innerHTML = eijiLinkify(text);
            body.style.whiteSpace = 'pre-wrap';
            body.style.wordBreak = 'break-word';
            div.appendChild(body);
        } else {
            div.textContent = text;
        }
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return div;
    }

    function showEijiTyping() {
        const container = document.getElementById('eijiMessages');
        const div = document.createElement('div');
        div.className = 'eiji-bubble agent typing';
        div.id = 'eijiTyping';
        const name = document.createElement('div');
        name.className = 'eiji-name';
        name.textContent = '\u2726 EIJI';
        div.appendChild(name);
        for (let i = 0; i < 3; i++) {
            const s = document.createElement('span');
            div.appendChild(s);
        }
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }

    function removeEijiTyping() {
        const el = document.getElementById('eijiTyping');
        if (el) el.remove();
    }

    async function sendEijiMessage() {
        const input = document.getElementById('eijiInput');
        const text = input.value.trim();
        if (!text || eijiIsTyping) return;

        document.getElementById('eijiSuggestions').style.display = 'none';
        input.value = '';
        eijiAutoResize(input);
        appendEijiBubble('user', text);
        eijiHistory.push({ role: 'user', content: text });

        eijiIsTyping = true;
        document.getElementById('eijiSendBtn').disabled = true;
        showEijiTyping();

        try {
            // Build messages: convert history to simple string format for Groq
            const historyMessages = eijiHistory.map(m => ({
                role: m.role,
                content: typeof m.content === 'string' ? m.content
                    : (Array.isArray(m.content)
                        ? m.content.filter(b => b.type === 'text').map(b => b.text).join('') || '...'
                        : String(m.content))
            }));

            let groqMessages = [
                { role: 'system', content: EIJI_SYSTEM },
                ...historyMessages
            ];

            let data = await eijiCallGroqSafe(groqMessages);
            let msg = data.choices && data.choices[0] && data.choices[0].message;

            // Tool-calling loop: let the model fetch realtime data (crypto/weather/search)
            // before producing its final answer. Capped to avoid infinite loops.
            let loops = 0;
            while (msg && msg.tool_calls && msg.tool_calls.length && loops < 3) {
                groqMessages.push(msg);
                for (const call of msg.tool_calls) {
                    const fn = EIJI_TOOL_MAP[call.function && call.function.name];
                    let result = JSON.stringify({ error: 'Tool tidak dikenal' });
                    if (fn) {
                        let args = {};
                        try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) {}
                        result = await fn(args);
                    }
                    groqMessages.push({ role: 'tool', tool_call_id: call.id, content: result });
                }
                data = await eijiCallGroqSafe(groqMessages);
                msg = data.choices && data.choices[0] && data.choices[0].message;
                loops++;
            }

            // Fallback: model leaked a fake function call as plain text instead of
            // using real tool_calls. Execute it ourselves and ask the model to
            // rephrase naturally, without ever showing raw JSON to the user.
            let fakeLoops = 0;
            while (msg && (!msg.tool_calls || !msg.tool_calls.length) && msg.content) {
                const fake = eijiExtractFakeToolCall(msg.content);
                if (!fake || fakeLoops >= 3) break;
                const result = await EIJI_TOOL_MAP[fake.name](fake.args);
                groqMessages.push({ role: 'assistant', content: msg.content });
                groqMessages.push({ role: 'user', content: `[System note] Tool "${fake.name}" result: ${result}\nGunakan data ini untuk menjawab pertanyaan saya sebelumnya dengan kalimat natural. Jawab langsung dalam kalimat biasa. JANGAN memanggil tool lagi, JANGAN menampilkan JSON/kode/format "(function=...)", "<function...>", atau nama tool apa pun.` });
                // Rephrase WITHOUT tools so a model that keeps leaking tool-call
                // syntax is forced to produce plain prose from the result above.
                data = await eijiCallGroqSafe(groqMessages, false);
                msg = data.choices && data.choices[0] && data.choices[0].message;
                fakeLoops++;
            }

            removeEijiTyping();

            let reply = (msg && msg.content) || '';
            if (!reply) reply = 'Maaf, ada gangguan. Coba lagi ya!';
            // Last-resort guard: eijiExtractFakeToolCall can fail to fully parse a
            // leaked call (unknown tool name, malformed JSON args, or the fakeLoops
            // cap being hit) while the raw "function=... {...}" pattern is still
            // sitting in `reply`. Without this check that raw pattern goes straight
            // to appendEijiBubble() and the user sees it — the exact failure mode
            // this whole safety net was built to prevent. Since we can't safely
            // execute or reformat it at this point, show a generic apology instead.
            else if (eijiLooksLikeLeakedToolCall(reply)) {
                console.warn('Eiji: leaked tool-call pattern survived parsing, suppressing raw text:', reply);
                reply = 'Maaf, ada gangguan teknis saat memproses jawaban ini. Coba tanya ulang ya!';
            }

            appendEijiBubble('agent', reply);
            eijiHistory.push({ role: 'assistant', content: reply });
            
            // Speak the response if voice was recently used
            if (eijiVoiceSessionId) {
                speakEijiResponse(reply);
            }

        } catch (err) {
            removeEijiTyping();
            console.error('Eiji error:', err);
            // Jangan tampilkan pesan error mentah dari provider (mis. JSON kuota
            // Gemini) ke user. Semua provider gagal -> pesan ramah + saran retry.
            appendEijiBubble('agent', '⚠️ Maaf, layanan AI sedang sibuk atau limit sementara. Coba tanya lagi sebentar lagi ya!');
        }

        eijiIsTyping = false;
        document.getElementById('eijiSendBtn').disabled = false;
        document.getElementById('eijiInput').focus();
    }

    function sendEijiChip(btn) {
        const raw = btn.textContent || btn.innerText;
        document.getElementById('eijiInput').value = raw.replace(/^.{1,3}\s/, '').trim();
        sendEijiMessage();
    }

    function eijiKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendEijiMessage();
        }
    }

    function eijiAutoResize(el) {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }

    /* ══════════════════════════════════════════════════
       EIJI VOICE CHAT - Secure speech recognition & synthesis
       Uses Web Speech API with proper error handling and session management
       ══════════════════════════════════════════════════ */
    function toggleEijiVoice() {
        const btn = document.getElementById('eijiVoiceBtn');
        
        if (eijiVoiceActive) {
            stopEijiVoice();
            btn.style.background = 'rgba(92,120,255,.15)';
            btn.style.color = '#a5b4fc';
        } else {
            startEijiVoice();
            btn.style.background = 'linear-gradient(135deg,#3478ff,#8b5cf6)';
            btn.style.color = '#fff';
        }
    }

    async function startEijiVoice() {
        // Check browser support
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            showToast('error', 'Voice Not Supported', 'Browser Anda tidak mendukung fitur voice chat. Gunakan Chrome atau Edge.');
            return;
        }

        // Check if already recording to prevent conflicts
        if (eijiVoiceActive) return;

        try {
            // Generate unique session ID for security tracking
            eijiVoiceSessionId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            eijiRecognition = new SpeechRecognition();
            
            // Configure recognition for security and accuracy
            eijiRecognition.lang = 'id-ID'; // Default to Indonesian
            eijiRecognition.continuous = false;
            eijiRecognition.interimResults = false;
            eijiRecognition.maxAlternatives = 1;

            eijiRecognition.onstart = () => {
                eijiVoiceActive = true;
                showToast('info', 'Voice Active', 'Silakan berbicara...');
                document.getElementById('eijiInput').placeholder = 'Mendengarkan...';
            };

            eijiRecognition.onresult = (event) => {
                const transcript = event.results[0][0].transcript;
                if (transcript && transcript.trim()) {
                    document.getElementById('eijiInput').value = transcript;
                    sendEijiMessage();
                }
            };

            eijiRecognition.onerror = (event) => {
                console.error('Voice recognition error:', event.error);
                let errorMsg = 'Terjadi kesalahan voice recognition.';
                
                if (event.error === 'not-allowed') {
                    errorMsg = 'Akses mikrofon ditolak. Izinkan akses mikrofon di browser.';
                } else if (event.error === 'no-speech') {
                    errorMsg = 'Tidak ada suara terdeteksi. Coba lagi.';
                } else if (event.error === 'network') {
                    errorMsg = 'Koneksi internet bermasalah untuk voice recognition.';
                }
                
                showToast('error', 'Voice Error', errorMsg);
                stopEijiVoice();
            };

            eijiRecognition.onend = () => {
                if (eijiVoiceActive) {
                    stopEijiVoice();
                }
            };

            eijiRecognition.start();

        } catch (err) {
            console.error('Failed to start voice recognition:', err);
            showToast('error', 'Voice Error', 'Gagal memulai voice recognition.');
            stopEijiVoice();
        }
    }

    function stopEijiVoice() {
        eijiVoiceActive = false;
        
        if (eijiRecognition) {
            try {
                eijiRecognition.stop();
            } catch (e) {
                // Recognition might already be stopped
            }
            eijiRecognition = null;
        }

        eijiVoiceSessionId = null;
        
        const btn = document.getElementById('eijiVoiceBtn');
        if (btn) {
            btn.style.background = 'rgba(92,120,255,.15)';
            btn.style.color = '#a5b4fc';
        }
        
        document.getElementById('eijiInput').placeholder = 'Ask Eiji anything...';
    }

    function speakEijiResponse(text) {
        if (!eijiSynthesis) return;
        
        // Stop any ongoing speech
        eijiSynthesis.cancel();
        
        // Clean text for speech (remove markdown, emojis, etc.)
        const cleanText = text
            .replace(/\*\*/g, '')
            .replace(/\*/g, '')
            .replace(/```[\s\S]*?```/g, '')
            .replace(/`[^`]+`/g, '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/[^\w\s.,?!-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (!cleanText) return;

        const utterance = new SpeechSynthesisUtterance(cleanText);
        utterance.lang = 'id-ID';
        utterance.rate = 1;
        utterance.pitch = 1;
        utterance.volume = 0.8;

        utterance.onerror = (event) => {
            console.error('Speech synthesis error:', event.error);
        };

        eijiSynthesis.speak(utterance);
    }

    function clearEijiChat() {
        eijiHistory = [];
        document.getElementById('eijiMessages').innerHTML = '';
        document.getElementById('eijiSuggestions').style.display = 'flex';
        eijiWelcome();
    }

    /* ══════════════════════════════════════════════════
       EIJI PHOTO / SCAN TOOL (client-side, gratis)
       Perbaiki foto (cerah/kontras/pertajam/saturasi) atau mode Scan Dokumen
       (grayscale + normalisasi cahaya via blur-background + kontras) lalu
       bisa di-download / print. Semua diproses lokal di browser (tanpa server).
       ══════════════════════════════════════════════════ */
    let eijiPhotoImg = null;
    let eijiPhotoMode = 'enhance';

    function eijiClamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

    function eijiMakeCanvas(w, h) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        return c;
    }

    function eijiOpenPhoto() {
        const inp = document.getElementById('eijiPhotoInput');
        if (inp) { inp.value = ''; inp.click(); }
    }

    function eijiHandlePhoto(input) {
        const file = input && input.files && input.files[0];
        if (!file) return;
        if (!/^image\//.test(file.type)) { alert('File harus berupa gambar (JPG/PNG).'); return; }
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                eijiPhotoImg = img;
                eijiPhotoSetMode('enhance');
                document.getElementById('eijiPhotoModal').classList.add('open');
            };
            img.onerror = () => alert('Gagal membuka gambar. Coba file lain.');
            img.src = e.target.result;
        };
        reader.onerror = () => alert('Gagal membaca file.');
        reader.readAsDataURL(file);
    }

    function eijiPhotoSetMode(mode) {
        eijiPhotoMode = mode;
        document.querySelectorAll('.eiji-photo-mode').forEach(b =>
            b.classList.toggle('active', b.getAttribute('data-mode') === mode));
        eijiRenderPhoto();
    }

    function eijiClosePhoto() {
        const m = document.getElementById('eijiPhotoModal');
        if (m) m.classList.remove('open');
        eijiPhotoImg = null;
    }

    function eijiRenderPhoto() {
        const img = eijiPhotoImg;
        const out = document.getElementById('eijiPhotoCanvas');
        if (!img || !out) return;
        const maxDim = 2200;
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        const scale = Math.min(1, maxDim / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        out.width = w; out.height = h;
        const ctx = out.getContext('2d');
        ctx.filter = 'none';
        ctx.drawImage(img, 0, 0, w, h);
        try {
            if (eijiPhotoMode === 'scan') eijiPhotoScan(out);
            else eijiPhotoEnhance(out);
        } catch (e) {
            console.error('Photo process error:', e);
        }
    }

    function eijiPhotoEnhance(canvas) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        // Salinan blur untuk unsharp mask
        const blur = eijiMakeCanvas(w, h);
        const bctx = blur.getContext('2d');
        bctx.filter = 'blur(2px)';
        bctx.drawImage(canvas, 0, 0);
        const orig = ctx.getImageData(0, 0, w, h);
        const bl = bctx.getImageData(0, 0, w, h);
        const d = orig.data, b = bl.data;
        // Levels: cari persentil terang/gelap dari histogram luminance
        const hist = new Uint32Array(256);
        for (let i = 0; i < d.length; i += 4) {
            const l = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
            hist[l < 0 ? 0 : l > 255 ? 255 : l]++;
        }
        const total = d.length / 4;
        const loCut = total * 0.005, hiCut = total * 0.005;
        let acc = 0, lo = 0, hi = 255;
        for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= loCut) { lo = i; break; } }
        acc = 0;
        for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= hiCut) { hi = i; break; } }
        if (hi <= lo) { lo = 0; hi = 255; }
        const range = (hi - lo) || 1;
        const sharpen = 0.8, sat = 1.15;
        for (let i = 0; i < d.length; i += 4) {
            let r = d[i] + sharpen * (d[i] - b[i]);
            let g = d[i + 1] + sharpen * (d[i + 1] - b[i + 1]);
            let bb = d[i + 2] + sharpen * (d[i + 2] - b[i + 2]);
            r = (r - lo) * 255 / range;
            g = (g - lo) * 255 / range;
            bb = (bb - lo) * 255 / range;
            const gray = r * 0.299 + g * 0.587 + bb * 0.114;
            d[i] = eijiClamp(gray + (r - gray) * sat);
            d[i + 1] = eijiClamp(gray + (g - gray) * sat);
            d[i + 2] = eijiClamp(gray + (bb - gray) * sat);
        }
        ctx.putImageData(orig, 0, 0);
    }

    function eijiPhotoScan(canvas) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        const img = ctx.getImageData(0, 0, w, h);
        const d = img.data;
        // grayscale
        for (let i = 0; i < d.length; i += 4) {
            const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
            d[i] = d[i + 1] = d[i + 2] = g;
        }
        ctx.putImageData(img, 0, 0);
        // Estimasi cahaya latar via blur besar, lalu bagi (hilangkan bayangan/warna kertas)
        const r = Math.max(8, Math.round(Math.max(w, h) / 25));
        const bg = eijiMakeCanvas(w, h);
        const bctx = bg.getContext('2d');
        bctx.filter = 'blur(' + r + 'px)';
        bctx.drawImage(canvas, 0, 0);
        const bgd = bctx.getImageData(0, 0, w, h).data;
        for (let i = 0; i < d.length; i += 4) {
            let v = (d[i] / (bgd[i] || 1)) * 255 * 1.02;
            v = (v - 128) * 1.45 + 128 + 6; // kontras + sedikit terang
            v = eijiClamp(v);
            d[i] = d[i + 1] = d[i + 2] = v;
        }
        ctx.putImageData(img, 0, 0);
    }

    function eijiPhotoDownload() {
        const canvas = document.getElementById('eijiPhotoCanvas');
        if (!canvas || !canvas.width) return;
        const isScan = eijiPhotoMode === 'scan';
        const a = document.createElement('a');
        a.download = (isScan ? 'scan' : 'foto-perbaikan') + '-' + Date.now() + (isScan ? '.png' : '.jpg');
        a.href = canvas.toDataURL(isScan ? 'image/png' : 'image/jpeg', 0.92);
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    function eijiPhotoPrint() {
        const canvas = document.getElementById('eijiPhotoCanvas');
        if (!canvas || !canvas.width) return;
        const url = canvas.toDataURL('image/png');
        const win = window.open('', '_blank');
        if (!win) { alert('Popup diblokir browser. Izinkan popup lalu coba Print lagi.'); return; }
        win.document.write('<html><head><title>Print</title></head><body style="margin:0;text-align:center;">' +
            '<img src="' + url + '" style="max-width:100%" ' +
            'onload="window.focus();window.print();" /></body></html>');
        win.document.close();
    }

    /* ══════════════════════════════════════════════════
       EIJI FILE CONVERTER (client-side, gratis)
       - Gambar: JPG / PNG / WEBP (via canvas)
       - Audio/Video -> MP3 / WAV (decode audio track via Web Audio, encode MP3 via lamejs)
         Termasuk MP4 -> MP3 (ambil audionya). Semua di browser, tanpa server.
       ══════════════════════════════════════════════════ */
    let eijiConvFile = null;
    let eijiConvCat = null;       // 'image' | 'audio'
    let eijiConvTarget = null;    // mime/format string
    let eijiConvBlobUrl = null;

    const EIJI_IMG_TARGETS = [
        { label: 'JPG', mime: 'image/jpeg', ext: 'jpg' },
        { label: 'PNG', mime: 'image/png', ext: 'png' },
        { label: 'WEBP', mime: 'image/webp', ext: 'webp' }
    ];
    const EIJI_AUDIO_TARGETS = [
        { label: 'MP3', mime: 'audio/mpeg', ext: 'mp3' },
        { label: 'WAV', mime: 'audio/wav', ext: 'wav' }
    ];

    function eijiOpenConv() {
        eijiConvReset();
        document.getElementById('eijiConvModal').classList.add('open');
    }

    function eijiConvClose() {
        document.getElementById('eijiConvModal').classList.remove('open');
        eijiConvReset();
    }

    function eijiConvReset() {
        eijiConvFile = null; eijiConvCat = null; eijiConvTarget = null;
        if (eijiConvBlobUrl) { try { URL.revokeObjectURL(eijiConvBlobUrl); } catch (e) {} eijiConvBlobUrl = null; }
        const info = document.getElementById('eijiConvInfo');
        const wrap = document.getElementById('eijiConvTargetWrap');
        const runBtn = document.getElementById('eijiConvRunBtn');
        const status = document.getElementById('eijiConvStatus');
        const dl = document.getElementById('eijiConvDownload');
        if (info) info.textContent = '';
        if (wrap) wrap.style.display = 'none';
        if (runBtn) runBtn.style.display = 'none';
        if (status) status.textContent = '';
        if (dl) dl.style.display = 'none';
    }

    function eijiConvHumanSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }

    function eijiConvHandle(input) {
        const file = input && input.files && input.files[0];
        if (!file) return;
        eijiConvFile = file;
        eijiConvBlobUrl && URL.revokeObjectURL(eijiConvBlobUrl);
        eijiConvBlobUrl = null;

        const type = file.type || '';
        if (/^image\//.test(type)) eijiConvCat = 'image';
        else if (/^audio\//.test(type) || /^video\//.test(type)) eijiConvCat = 'audio';
        else { eijiConvCat = null; }

        const info = document.getElementById('eijiConvInfo');
        const dl = document.getElementById('eijiConvDownload');
        const status = document.getElementById('eijiConvStatus');
        if (dl) dl.style.display = 'none';
        if (status) status.textContent = '';

        if (!eijiConvCat) {
            info.textContent = 'Format ini belum didukung. Pilih file gambar, audio, atau video.';
            document.getElementById('eijiConvTargetWrap').style.display = 'none';
            document.getElementById('eijiConvRunBtn').style.display = 'none';
            return;
        }

        info.textContent = file.name + '  •  ' + eijiConvHumanSize(file.size) +
            (eijiConvCat === 'audio' ? '  •  (video/audio → diambil audionya)' : '');

        const targets = eijiConvCat === 'image' ? EIJI_IMG_TARGETS : EIJI_AUDIO_TARGETS;
        const cont = document.getElementById('eijiConvTargets');
        cont.innerHTML = '';
        targets.forEach((t, idx) => {
            const b = document.createElement('button');
            b.className = 'eiji-photo-mode' + (idx === 0 ? ' active' : '');
            b.textContent = t.label;
            b.setAttribute('data-mime', t.mime);
            b.onclick = () => eijiConvSetTarget(t.mime);
            cont.appendChild(b);
        });
        eijiConvTarget = targets[0].mime;
        document.getElementById('eijiConvTargetWrap').style.display = 'block';
        document.getElementById('eijiConvRunBtn').style.display = 'block';
    }

    function eijiConvSetTarget(mime) {
        eijiConvTarget = mime;
        document.querySelectorAll('#eijiConvTargets .eiji-photo-mode').forEach(b =>
            b.classList.toggle('active', b.getAttribute('data-mime') === mime));
        const dl = document.getElementById('eijiConvDownload');
        if (dl) dl.style.display = 'none';
        document.getElementById('eijiConvStatus').textContent = '';
    }

    async function eijiConvRun() {
        if (!eijiConvFile || !eijiConvTarget) return;
        const status = document.getElementById('eijiConvStatus');
        const dl = document.getElementById('eijiConvDownload');
        dl.style.display = 'none';
        status.textContent = '⏳ Mengonversi... (file besar bisa butuh beberapa detik)';
        await new Promise(r => setTimeout(r, 60)); // biar status sempat tampil

        try {
            let blob, ext;
            if (eijiConvCat === 'image') {
                const meta = EIJI_IMG_TARGETS.find(t => t.mime === eijiConvTarget);
                ext = meta.ext;
                blob = await eijiConvertImage(eijiConvFile, eijiConvTarget);
            } else {
                const meta = EIJI_AUDIO_TARGETS.find(t => t.mime === eijiConvTarget);
                ext = meta.ext;
                blob = await eijiConvertAudio(eijiConvFile, ext);
            }
            if (!blob) throw new Error('Hasil konversi kosong.');
            if (eijiConvBlobUrl) { try { URL.revokeObjectURL(eijiConvBlobUrl); } catch (e) {} }
            eijiConvBlobUrl = URL.createObjectURL(blob);
            const base = (eijiConvFile.name || 'hasil').replace(/\.[^.]+$/, '') || 'hasil';
            dl.href = eijiConvBlobUrl;
            dl.setAttribute('download', base + '.' + ext);
            dl.style.display = 'block';
            status.textContent = '✅ Selesai (' + eijiConvHumanSize(blob.size) + '). Klik Download Hasil.';
        } catch (e) {
            console.error('Convert error:', e);
            status.textContent = '⚠️ Gagal konversi: ' + (e.message || 'format tidak didukung browser') +
                '. Untuk audio, pastikan file punya track audio yang bisa dibaca browser.';
        }
    }

    function eijiConvertImage(file, mime) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const c = document.createElement('canvas');
                c.width = img.naturalWidth; c.height = img.naturalHeight;
                const ctx = c.getContext('2d');
                if (mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
                ctx.drawImage(img, 0, 0);
                c.toBlob(b => b ? resolve(b) : reject(new Error('format tidak didukung')), mime, 0.92);
            };
            img.onerror = () => reject(new Error('gagal membuka gambar'));
            const r = new FileReader();
            r.onload = e => { img.src = e.target.result; };
            r.onerror = () => reject(new Error('gagal membaca file'));
            r.readAsDataURL(file);
        });
    }

    async function eijiConvertAudio(file, ext) {
        const arrayBuf = await file.arrayBuffer();
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) throw new Error('browser tidak mendukung Web Audio');
        const ac = new AC();
        let audioBuf;
        try {
            audioBuf = await ac.decodeAudioData(arrayBuf.slice(0));
        } finally {
            try { ac.close(); } catch (e) {}
        }
        if (ext === 'wav') return eijiAudioBufToWav(audioBuf);
        if (typeof lamejs === 'undefined') throw new Error('encoder MP3 belum termuat, refresh halaman');
        return eijiAudioBufToMp3(audioBuf);
    }

    function eijiFloatTo16(f) {
        const o = new Int16Array(f.length);
        for (let i = 0; i < f.length; i++) {
            const s = f[i] < -1 ? -1 : f[i] > 1 ? 1 : f[i];
            o[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return o;
    }

    function eijiAudioBufToMp3(ab) {
        const numCh = Math.min(2, ab.numberOfChannels);
        const enc = new lamejs.Mp3Encoder(numCh, ab.sampleRate, 128);
        const left = eijiFloatTo16(ab.getChannelData(0));
        const right = numCh > 1 ? eijiFloatTo16(ab.getChannelData(1)) : null;
        const block = 1152;
        const out = [];
        for (let i = 0; i < left.length; i += block) {
            const l = left.subarray(i, i + block);
            let buf;
            if (numCh > 1) buf = enc.encodeBuffer(l, right.subarray(i, i + block));
            else buf = enc.encodeBuffer(l);
            if (buf.length > 0) out.push(new Uint8Array(buf));
        }
        const fin = enc.flush();
        if (fin.length > 0) out.push(new Uint8Array(fin));
        return new Blob(out, { type: 'audio/mpeg' });
    }

    function eijiAudioBufToWav(ab) {
        const numCh = ab.numberOfChannels, sr = ab.sampleRate, len = ab.length;
        const blockAlign = numCh * 2;
        const dataLen = len * blockAlign;
        const buffer = new ArrayBuffer(44 + dataLen);
        const view = new DataView(buffer);
        const ws = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
        ws(0, 'RIFF'); view.setUint32(4, 36 + dataLen, true); ws(8, 'WAVE');
        ws(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
        view.setUint16(22, numCh, true); view.setUint32(24, sr, true);
        view.setUint32(28, sr * blockAlign, true); view.setUint16(32, blockAlign, true);
        view.setUint16(34, 16, true); ws(36, 'data'); view.setUint32(40, dataLen, true);
        const chans = [];
        for (let c = 0; c < numCh; c++) chans.push(ab.getChannelData(c));
        let off = 44;
        for (let i = 0; i < len; i++) {
            for (let c = 0; c < numCh; c++) {
                let s = chans[c][i]; s = s < -1 ? -1 : s > 1 ? 1 : s;
                view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true); off += 2;
            }
        }
        return new Blob([view], { type: 'audio/wav' });
    }

    /* ══════════════════════════════════════════════════
       HASH ROUTING
       Views are in-memory overlays, so a page refresh used to always
       drop the user back on the home page (felt like a crash, e.g. after
       opening Spot Trading and reloading). Reflect the open view in
       location.hash and restore it on load so refresh/shared links keep
       the user where they were.
    ══════════════════════════════════════════════════ */
    (function setupHashRouting() {
        // hash → original view function (captured before wrapping below)
        const routes = {
            '#portfolio': showPortfolio,
            '#trading':   showTradingHub,
            '#swap':      showSwap,
            '#bridge':    showBridge,
            '#spot':      showSpotTrade,
            '#pools':     showPools,
            '#lend':      showLend,
            '#stake':     showStake,
            '#admin':     showAdmin,
            '#eiji':      showEiji,
            '#home':      showHome,
            '':           showHome,
        };
        const hashFor = {
            showPortfolio: '#portfolio', showTradingHub: '#trading',
            showSwap: '#swap', showBridge: '#bridge', showSpotTrade: '#spot',
            showPools: '#pools', showLend: '#lend', showStake: '#stake',
            showAdmin: '#admin', showEiji: '#eiji', showHome: '#home',
        };

        let applying = false; // true while the router is opening a view (avoid loops)

        // Wrap each global view function so a normal nav click also records the
        // route in the URL. replaceState keeps history clean (no back-button spam)
        // and does NOT fire hashchange, so there's no re-entrancy.
        Object.keys(hashFor).forEach(name => {
            const original = window[name];
            if (typeof original !== 'function') return;
            window[name] = function (...args) {
                const result = original.apply(this, args);
                if (!applying && location.hash !== hashFor[name]) {
                    try { history.replaceState(null, '', hashFor[name]); }
                    catch { location.hash = hashFor[name]; }
                }
                return result;
            };
        });

        function applyRoute() {
            const fn = routes[location.hash] || showHome;
            applying = true;
            try { fn(); } finally { applying = false; }
        }

        // Manual URL edits / back-forward on the hash.
        window.addEventListener('hashchange', applyRoute);

        // Restore the view on initial load (script is deferred, DOM is ready).
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', applyRoute);
        } else {
            applyRoute();
        }
    })();
