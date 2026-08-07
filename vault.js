/* ═══════════════════════════════════════════════════════════════════════
   vault.js — ARCENTIC Vault module
   ---------------------------------------------------------------------
   Self-contained on purpose: it keeps its own provider/signer instead of
   sharing app.js's wallet state, because this view talks to a DIFFERENT
   contract (ArcenticVault) with real-money admin functions (pause, treasury,
   reward withdrawal...). Keeping it isolated means a bug in the rest of the
   dashboard's wallet handling can't accidentally touch this contract, and
   vice versa. It loads lazily — nothing here runs until showVault() is
   called for the first time.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    // ── Network / contract config ──────────────────────────────────────
    const VAULT_CONFIG = {
        address: '0xf3b0798A5363eEDDd2aB5ED23A023621a4d63621',
        chainIdDec: 5042002,
        chainIdHex: '0x' + (5042002).toString(16), // 0x4cef52
        chainName: 'Arc Network Testnet',
        // rpcUrl: dipakai untuk PEMBACAAN DATA dari JS halaman ini (lewat
        // ethers.js, lihat bootstrap() di bawah). Sengaja diarahkan ke
        // "/api/rpc" (proxy serverless di domain sendiri, lihat api/rpc.js),
        // BUKAN langsung ke endpoint Alchemy + API key. Sebelumnya key
        // Alchemy tertulis langsung di sini dan otomatis terkirim ke
        // browser SIAPA PUN yang buka halaman ini (bisa dilihat lewat View
        // Source) — itu API key kamu sendiri yang bisa dipakai/disalahgunakan
        // orang lain secara gratis. api/rpc.js sudah dibuat khusus untuk
        // menyembunyikan key ini di server, tapi vault.js ini modul
        // terpisah yang belum ikut memakainya — sekarang disamakan.
        //
        // rpcUrlFallback: RPC publik TANPA API key, jadi aman dipanggil
        // langsung dari mana saja. Dipakai untuk 2 hal: (1) fallback kalau
        // "/api/rpc" lambat/error, (2) dikirim ke wallet_addEthereumChain
        // di bawah — itu dipanggil LANGSUNG oleh MetaMask sendiri (bukan
        // oleh JS halaman ini), jadi tidak bisa lewat proxy "/api/rpc" kita
        // (MetaMask tidak tahu cara "menembus" proxy Vercel kita).
        rpcUrl: '/api/rpc',
        rpcUrlFallback: 'https://rpc.testnet.arc.network',
        // USDC pakai 6 desimal (bukan 18) — kalau salah, MetaMask bisa
        // salah tampilkan saldo gas user sampai meleset triliunan kali.
        nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
        explorerUrl: 'https://testnet.arcscan.app'
    };

    const VAULT_ABI = [
        'function earlyExitPenaltyBps() view returns (uint256)',
        'function supportedTokensLength() view returns (uint256)',
        'function supportedTokenAt(uint256) view returns (address)',
        'function tokenSupported(address) view returns (bool)',
        'function tiersLength(address) view returns (uint256)',
        'function tierAt(address,uint256) view returns (uint256 lockDuration, uint256 aprBps, bool active)',
        'function rewardPoolBalanceOf(address) view returns (uint256)',
        'function reservedRewardsOf(address) view returns (uint256)',
        'function totalStakedOf(address) view returns (uint256)',
        'function vaultLiquidityInPool(address) view returns (uint256)',
        'function stakeCountOf(address) view returns (uint256)',
        'function stakesOf(address,uint256) view returns (address token,uint256 tierId,uint256 amount,uint256 startTime,uint256 lockDuration,uint256 aprBps,uint256 claimedReward,uint256 reservedReward,bool withdrawn)',
        'function pendingReward(address,uint256) view returns (uint256)',
        'function isUnlocked(address,uint256) view returns (bool)',
        'function stake(address token,uint256 tierId,uint256 amount)',
        'function claimReward(uint256 stakeId)',
        'function unstake(uint256 stakeId)',
        'function emergencyUnstake(uint256 stakeId)'
    ];

    const ERC20_ABI = [
        'function symbol() view returns (string)',
        'function decimals() view returns (uint8)',
        'function balanceOf(address) view returns (uint256)',
        'function allowance(address owner, address spender) view returns (uint256)',
        'function approve(address spender, uint256 amount) returns (bool)'
    ];

    // ── RPC retry / concurrency helpers ────────────────────────────────
    // ethers' own fetchJson() ALREADY retries HTTP 429 internally (up to
    // 12x, with backoff) before it ever throws — completely invisible to
    // this file. That built-in retry was firing on top of two FallbackProvider
    // backends AND a long sequential for-loop of RPC calls (one per token,
    // one per tier, one per stake), so a single "load tokens" pass could
    // multiply into dozens/hundreds of underlying HTTP requests the moment
    // one public RPC got slow — which is exactly the storm of 429s in the
    // console and "Loading tiers…" hanging forever. Fix: disable ethers'
    // hidden retry per-provider (throttleLimit: 1, set in bootstrap()) and
    // do exactly ONE controlled retry loop ourselves, with capped
    // concurrency instead of blasting every call at once.
    function isTransientRpcError(err) {
        const msg = ((err && err.message) || '').toLowerCase();
        return msg.includes('429') || msg.includes('rate limit') ||
               msg.includes('timeout') || msg.includes('econnreset') ||
               msg.includes('network') || (err && err.code) === 'NETWORK_ERROR' ||
               (err && err.code) === 'TIMEOUT' || (err && err.code) === -32005 ||
               (err && err.code) === -32603 || (err && err.code) === -32000;
    }

    async function withRpcRetry(fn, retries, delayMs) {
        retries = retries == null ? 4 : retries;
        delayMs = delayMs == null ? 800 : delayMs;
        let lastErr;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try { return await fn(); }
            catch (err) {
                lastErr = err;
                if (!isTransientRpcError(err) || attempt === retries) throw err;
                await new Promise(function (r) { setTimeout(r, delayMs * (attempt + 1)); });
            }
        }
        throw lastErr;
    }

    // Runs `fn` over `items` with at most `limit` in flight at once instead
    // of firing every call simultaneously (which is what triggers 429s on
    // public RPCs in the first place).
    async function mapWithConcurrency(items, limit, fn) {
        const results = new Array(items.length);
        let nextIndex = 0;
        async function worker() {
            while (nextIndex < items.length) {
                const i = nextIndex++;
                results[i] = await fn(items[i], i);
            }
        }
        const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
        await Promise.all(workers);
        return results;
    }

    // Short-lived cache so flipping between tokens/tabs doesn't re-hit the
    // RPC for data that was just fetched a few seconds ago.
    const _cache = {}; // key -> { value, ts }
    const CACHE_TTL_MS = 20000;
    async function cached(key, fn) {
        const hit = _cache[key];
        if (hit && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.value;
        const value = await fn();
        _cache[key] = { value: value, ts: Date.now() };
        return value;
    }

    // ── State ───────────────────────────────────────────────────────────
    let readProvider = null;   // JsonRpcProvider — works without a wallet
    let webProvider = null;    // Web3Provider — only once wallet is connected
    let signer = null;
    let userAddress = null;
    let vaultRO = null;        // read-only contract (readProvider)
    let vaultRW = null;        // signer-connected contract (only after connect)
    let inited = false;

    let tokens = [];           // [{ address, symbol, decimals }]
    let tokenByAddr = {};       // lowercased address -> token meta
    let selectedToken = null;
    let tiers = [];             // [{ id, lockDuration, aprBps, active }]
    let selectedTierId = null;

    // ── Small helpers ───────────────────────────────────────────────────
    function shortAddr(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : '—'; }

    function fmtUnits(bn, decimals) {
        try { return Number(ethers.utils.formatUnits(bn, decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 }); }
        catch (e) { return '—'; }
    }

    function fmtDays(seconds) {
        const d = Math.round(seconds / 86400);
        return d + (d === 1 ? ' day' : ' days');
    }

    function fmtApr(bps) { return (bps / 100).toString().replace(/\.?0+$/, '') + '%'; }

    function fmtDate(unixSeconds) {
        return new Date(unixSeconds * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function parseErr(err) {
        // Walk through the various shapes MetaMask/ethers wrap revert reasons in
        // — a plain "Internal JSON-RPC error" with no message is usually just
        // the outermost layer; the real reason is often one level deeper.
        if (err && err.error && err.error.data && err.error.data.message) return err.error.data.message;
        if (err && err.error && err.error.message && err.error.message !== 'Internal JSON-RPC error.') return err.error.message;
        if (err && err.reason) return err.reason;
        if (err && err.data && err.data.message) return err.data.message;
        if (err && err.error && err.error.body) {
            try {
                const body = JSON.parse(err.error.body);
                if (body && body.error && body.error.message) return body.error.message;
            } catch (e) { /* not JSON, ignore */ }
        }
        if (err && err.message) return err.message.split('(')[0].trim();
        return 'Transaction failed.';
    }

    function toast(msg, isError) {
        let box = document.getElementById('vaultToastBox');
        if (!box) {
            box = document.createElement('div');
            box.id = 'vaultToastBox';
            box.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:400;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;';
            document.body.appendChild(box);
        }
        const el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = 'padding:10px 18px;border-radius:12px;font-size:.85rem;font-weight:600;max-width:90vw;' +
            (isError
                ? 'background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.4);color:#fca5a5;'
                : 'background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.4);color:#86efac;');
        box.appendChild(el);
        setTimeout(function () { el.remove(); }, 5000);
    }

    function setStatus(msg) {
        const el = document.getElementById('vaultStatus');
        if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
        el.classList.remove('hidden');
        el.textContent = msg;
    }

    function getReadContract() { return vaultRO || vaultRW; }

    // ── Networking: pick up the shared wallet from app.js ───────────────
    // vault.js no longer connects its own wallet. It reads whatever is
    // already connected via the site's main "Connect Wallet" button
    // (exposed on window.arcenticWallet by app.js) and reacts to the same
    // 'walletConnected' / disconnect signals the rest of the dashboard uses.
    async function ensureCorrectChain() {
        const net = await webProvider.getNetwork();
        if (net.chainId === VAULT_CONFIG.chainIdDec) return;
        try {
            await window.ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: VAULT_CONFIG.chainIdHex }]
            });
        } catch (switchErr) {
            if (switchErr.code === 4902) {
                await window.ethereum.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                        chainId: VAULT_CONFIG.chainIdHex,
                        chainName: VAULT_CONFIG.chainName,
                        // MetaMask memanggil URL ini SENDIRI secara langsung
                        // (bukan lewat JS halaman ini), jadi harus RPC
                        // publik absolut — bukan VAULT_CONFIG.rpcUrl yang
                        // sekarang berupa path proxy relatif "/api/rpc".
                        rpcUrls: [VAULT_CONFIG.rpcUrlFallback],
                        nativeCurrency: VAULT_CONFIG.nativeCurrency,
                        blockExplorerUrls: [VAULT_CONFIG.explorerUrl]
                    }]
                });
            } else {
                throw switchErr;
            }
        }
        webProvider = new ethers.providers.Web3Provider(window.ethereum, 'any');
        webProvider.polling = false;
    }

    function updateVaultWalletBadge() {
        const badge = document.getElementById('vaultWalletBadge');
        if (!badge) return;
        badge.textContent = userAddress ? shortAddr(userAddress) : 'Wallet not connected';
    }

    // Pulls in whatever wallet is currently connected on the main page
    // (window.arcenticWallet, set up by app.js). Safe to call repeatedly —
    // it's a no-op if nothing is connected yet, and cleans up state if the
    // wallet disconnects.
    async function syncWalletFromHome() {
        const shared = window.arcenticWallet;
        if (!shared || !shared.isConnected() || !shared.getProvider()) {
            webProvider = null; signer = null; userAddress = null; vaultRW = null;
            updateVaultWalletBadge();
            return;
        }
        try {
            webProvider = new ethers.providers.Web3Provider(shared.getProvider(), 'any');
            webProvider.polling = false;
            await ensureCorrectChain();
            signer = webProvider.getSigner();
            userAddress = shared.getAccount() || await signer.getAddress();
            vaultRW = new ethers.Contract(VAULT_CONFIG.address, VAULT_ABI, signer);
            updateVaultWalletBadge();
        } catch (err) {
            console.error(err);
            toast(parseErr(err), true);
        }
    }

    document.addEventListener('walletConnected', function () {
        syncWalletFromHome().then(function () {
            refreshTokenDependentUI();
            loadMyVaultStakesInternal();
        });
    });

    document.addEventListener('walletDisconnected', function () {
        webProvider = null; signer = null; userAddress = null; vaultRW = null;
        updateVaultWalletBadge();
        document.getElementById('myVaultStakesList').innerHTML =
            '<p class="text-gray-500 text-sm text-center py-6">Connect your wallet from the home page to see your stakes.</p>';
        refreshTokenDependentUI();
    });

    // ── Init / open view ────────────────────────────────────────────────
    window.showVault = function () {
        document.getElementById('vaultView').classList.add('open');
        if (!inited) {
            inited = true;
            bootstrap();
        }
    };

    async function bootstrap() {
        // Two independent RPCs, quorum 1: if the Alchemy endpoint (priority 1)
        // is slow or 429s, ethers automatically retries the same call against
        // the public Arc testnet RPC (priority 2) instead of the read failing.
        //
        // IMPORTANT: setting pollingInterval alone was not enough — under
        // sustained 429s, ethers' internal poll loop can reschedule itself
        // almost immediately instead of honoring the interval, producing a
        // tight retry storm against whatever public RPC is still up. Nothing
        // here listens for 'block' events, so we don't need block-polling at
        // all — fully disabling it (provider.polling = false) removes this
        // whole class of background traffic instead of just slowing it down.
        // throttleLimit: 1 turns off ethers' own hidden retry-on-429 for each
        // endpoint (default is up to 12 silent retries per call) — we handle
        // retries ourselves once, below, instead of two retry layers stacking.
        // Passing VAULT_CONFIG.chainIdDec explicitly as the network tells
        // ethers to skip its own eth_chainId auto-detect call. Without this,
        // ethers memoizes that ONE detection call's result forever — if it
        // happened to hit a 429, the provider got permanently stuck throwing
        // "could not detect network" (NETWORK_ERROR) on every future call,
        // even after the RPC recovered. This is what "Loading tiers…" /
        // repeated NETWORK_ERROR in the console was.
        // StaticJsonRpcProvider (not plain JsonRpcProvider) locks the network
        // in permanently — regular JsonRpcProvider can still re-run its
        // internal "is this network still the same?" check under certain
        // conditions even after you pass a network in, and if THAT check
        // lands during a 429 it re-triggers the same "could not detect
        // network" wedge. Static skips that check entirely.
        const alchemyProvider = new ethers.providers.StaticJsonRpcProvider({ url: VAULT_CONFIG.rpcUrl, throttleLimit: 1 }, VAULT_CONFIG.chainIdDec);
        const publicProvider = new ethers.providers.StaticJsonRpcProvider({ url: VAULT_CONFIG.rpcUrlFallback, throttleLimit: 1 }, VAULT_CONFIG.chainIdDec);
        alchemyProvider.polling = false;
        publicProvider.polling = false;
        readProvider = new ethers.providers.FallbackProvider([
            { provider: alchemyProvider, priority: 1, weight: 1, stallTimeout: 2500 },
            { provider: publicProvider, priority: 2, weight: 1, stallTimeout: 2500 }
        ], 1);
        readProvider.polling = false;
        vaultRO = new ethers.Contract(VAULT_CONFIG.address, VAULT_ABI, readProvider);

        const backBtn = document.querySelector('.vault-back-btn');
        if (backBtn) backBtn.addEventListener('click', function () {
            document.getElementById('vaultView').classList.remove('open');
        });

        document.getElementById('myVaultStakesList').addEventListener('click', onStakeListClick);

        // Pick up whatever wallet is already connected on the Home page
        // (or leave the vault in "not connected" state if none is) instead
        // of re-running our own eth_accounts/eth_requestAccounts flow.
        await Promise.all([
            loadTokenList(),
            syncWalletFromHome().then(function () { return loadMyVaultStakesInternal(); })
        ]);
    }

    // ── Tokens & tiers ──────────────────────────────────────────────────
    async function loadTokenList() {
        const picker = document.getElementById('vaultTokenPicker');
        try {
            const c = getReadContract();
            const n = (await withRpcRetry(function () { return c.supportedTokensLength(); })).toNumber();

            // Fetch each token's address + symbol/decimals with limited
            // concurrency instead of one-at-a-time — this used to be a fully
            // sequential for-loop (3 RPC round-trips per token, back to back),
            // which is slow AND, when a call failed, retried with no cap.
            const indices = Array.from({ length: n }, function (_, i) { return i; });
            const fetched = await mapWithConcurrency(indices, 3, async function (i) {
                const addr = await withRpcRetry(function () { return c.supportedTokenAt(i); });
                return cached('tokenmeta:' + addr.toLowerCase(), async function () {
                    const erc20 = new ethers.Contract(addr, ERC20_ABI, readProvider);
                    let symbol = '???', decimals = 18;
                    try { symbol = await withRpcRetry(function () { return erc20.symbol(); }); } catch (e) {}
                    try { decimals = await withRpcRetry(function () { return erc20.decimals(); }); } catch (e) {}
                    return { address: addr, symbol: symbol, decimals: decimals };
                });
            });

            tokens = [];
            tokenByAddr = {};
            fetched.forEach(function (meta) {
                tokens.push(meta);
                tokenByAddr[meta.address.toLowerCase()] = meta;
            });

            if (!tokens.length) {
                picker.innerHTML = '<option value="">No tokens whitelisted yet</option>';
                picker.disabled = true;
                return;
            }

            picker.innerHTML = tokens.map(function (t) {
                return '<option value="' + t.address + '">' + t.symbol + '</option>';
            }).join('');
            picker.disabled = false;
            await selectVaultToken(tokens[0].address);
        } catch (err) {
            console.error(err);
            picker.innerHTML = '<option value="">Failed to load tokens</option>';
            toast('Could not read whitelisted tokens from the vault. ' + parseErr(err), true);
        }
    }

    window.selectVaultToken = async function (addr) {
        if (!addr) return;
        selectedToken = addr;
        selectedTierId = null;
        document.getElementById('vaultTokenPicker').value = addr;
        document.querySelectorAll('.vault-token-unit').forEach(function (el) {
            const meta = tokenByAddr[addr.toLowerCase()];
            el.textContent = meta ? meta.symbol : '—';
        });
        await Promise.all([loadTiers(addr), refreshTokenDependentUI()]);
        updateVaultPreview();
    };

    async function loadTiers(tokenAddr) {
        const grid = document.getElementById('vaultTierGrid');
        grid.innerHTML = '<div class="tier-card text-center text-gray-500 text-sm col-span-3">Loading tiers…</div>';
        try {
            const c = getReadContract();
            tiers = await cached('tiers:' + tokenAddr.toLowerCase(), async function () {
                const n = (await withRpcRetry(function () { return c.tiersLength(tokenAddr); })).toNumber();
                const indices = Array.from({ length: n }, function (_, i) { return i; });
                return mapWithConcurrency(indices, 3, async function (i) {
                    const t = await withRpcRetry(function () { return c.tierAt(tokenAddr, i); });
                    return { id: i, lockDuration: t.lockDuration.toNumber(), aprBps: t.aprBps.toNumber(), active: t.active };
                });
            });
            if (!tiers.length) {
                grid.innerHTML = '<div class="tier-card text-center text-gray-500 text-sm col-span-3">No lock tiers yet for this token.</div>';
                return;
            }
            grid.innerHTML = tiers.map(function (t) {
                return '<div class="tier-card' + (t.active ? '' : ' opacity-40') + '" data-tier-id="' + t.id + '"' +
                    (t.active ? ' onclick="selectVaultTier(' + t.id + ')"' : '') + '>' +
                    '<div class="font-black text-lg">' + fmtApr(t.aprBps) + ' APR</div>' +
                    '<div class="text-gray-400 text-xs mt-1">' + fmtDays(t.lockDuration) + ' lock</div>' +
                    (t.active ? '' : '<div class="text-red-400 text-xs mt-1">Inactive</div>') +
                    '</div>';
            }).join('');
        } catch (err) {
            console.error(err);
            grid.innerHTML = '<div class="tier-card text-center text-gray-500 text-sm col-span-3">Failed to load tiers.</div>';
        }
    }

    window.selectVaultTier = function (tierId) {
        selectedTierId = tierId;
        document.querySelectorAll('#vaultTierGrid .tier-card').forEach(function (el) {
            el.classList.toggle('tier-active', Number(el.getAttribute('data-tier-id')) === tierId);
        });
        updateVaultPreview();
    };

    async function refreshTokenDependentUI() {
        if (!selectedToken) return;
        const meta = tokenByAddr[selectedToken.toLowerCase()];
        const c = getReadContract();
        try {
            const [totalStaked, penaltyBps] = await Promise.all([
                withRpcRetry(function () { return c.totalStakedOf(selectedToken); }),
                withRpcRetry(function () { return c.earlyExitPenaltyBps(); })
            ]);
            document.getElementById('vaultTotalStaked').textContent = fmtUnits(totalStaked, meta.decimals);
            document.getElementById('vaultPenaltyDisplay').textContent = fmtApr(penaltyBps.toNumber());
        } catch (err) { console.error(err); }

        try {
            const [liq, staked] = await Promise.all([
                withRpcRetry(function () { return c.vaultLiquidityInPool(selectedToken); }),
                withRpcRetry(function () { return c.totalStakedOf(selectedToken); })
            ]);
            const mismatchEl = document.getElementById('vaultPoolMismatch');
            if (!liq.eq(staked)) {
                mismatchEl.textContent = '⚠ Vault liquidity in the pool (' + fmtUnits(liq, meta.decimals) + ' ' + meta.symbol +
                    ') doesn\'t match total staked (' + fmtUnits(staked, meta.decimals) + ' ' + meta.symbol +
                    '). This can happen if the pool owner pulled reserves out — see the contract notes.';
                mismatchEl.classList.remove('hidden');
            } else {
                mismatchEl.classList.add('hidden');
            }
        } catch (err) { /* non-fatal */ }

        if (userAddress) {
            try {
                const erc20 = new ethers.Contract(selectedToken, ERC20_ABI, readProvider);
                const bal = await erc20.balanceOf(userAddress);
                document.getElementById('vaultTokenBal').textContent = fmtUnits(bal, meta.decimals);
            } catch (err) { console.error(err); }
        } else {
            document.getElementById('vaultTokenBal').textContent = '—';
        }
    }

    window.setVaultMax = async function () {
        if (!selectedToken || !userAddress) { toast('Connect your wallet from the home page first.', true); return; }
        const meta = tokenByAddr[selectedToken.toLowerCase()];
        const erc20 = new ethers.Contract(selectedToken, ERC20_ABI, readProvider);
        const bal = await withRpcRetry(function () { return erc20.balanceOf(userAddress); });
        document.getElementById('vaultAmount').value = ethers.utils.formatUnits(bal, meta.decimals);
        updateVaultPreview();
    };

    window.updateVaultPreview = function () {
        const unlockEl = document.getElementById('vaultPreviewUnlock');
        const rewardEl = document.getElementById('vaultPreviewReward');
        const amountStr = document.getElementById('vaultAmount').value;
        const amount = parseFloat(amountStr);

        if (selectedTierId === null || !tiers.length || !amount || amount <= 0) {
            unlockEl.textContent = '—';
            rewardEl.textContent = '—';
            return;
        }
        const tier = tiers.find(function (t) { return t.id === selectedTierId; });
        if (!tier) { unlockEl.textContent = '—'; rewardEl.textContent = '—'; return; }

        const nowSec = Math.floor(Date.now() / 1000);
        unlockEl.textContent = fmtDate(nowSec + tier.lockDuration);

        const meta = tokenByAddr[selectedToken.toLowerCase()];
        const reward = amount * (tier.aprBps / 10000) * (tier.lockDuration / (365 * 86400));
        rewardEl.textContent = reward.toLocaleString(undefined, { maximumFractionDigits: 6 }) + ' ' + (meta ? meta.symbol : '');
    };

    // ── Stake ───────────────────────────────────────────────────────────
    window.doVaultStake = async function () {
        if (!userAddress) { toast('Connect your wallet from the home page first.', true); return; }
        if (!selectedToken) { toast('Pick a token first.', true); return; }
        if (selectedTierId === null) { toast('Pick a lock tier first.', true); return; }
        const amountStr = document.getElementById('vaultAmount').value;
        const amount = parseFloat(amountStr);
        if (!amount || amount <= 0) { toast('Enter an amount to stake.', true); return; }

        const meta = tokenByAddr[selectedToken.toLowerCase()];
        const amountWei = ethers.utils.parseUnits(amountStr, meta.decimals);
        const btn = document.getElementById('btnVaultStake');
        btn.disabled = true;

        try {
            const erc20 = new ethers.Contract(selectedToken, ERC20_ABI, signer);
            const allowance = await erc20.allowance(userAddress, VAULT_CONFIG.address);
            if (allowance.lt(amountWei)) {
                setStatus('Approving ' + meta.symbol + '…');
                const approveTx = await erc20.approve(VAULT_CONFIG.address, amountWei);
                await approveTx.wait();
            }

            setStatus('Staking…');
            // Simulate first via callStatic: this surfaces the contract's actual
            // revert reason (e.g. "insufficient reward pool") instead of the
            // generic "Internal JSON-RPC error" MetaMask shows when it can't
            // decode revert data from the real transaction attempt.
            await vaultRW.callStatic.stake(selectedToken, selectedTierId, amountWei);
            const tx = await vaultRW.stake(selectedToken, selectedTierId, amountWei);
            await tx.wait();

            setStatus('');
            if (typeof showSuccessModal === 'function') {
                showSuccessModal('Staked!', 'Locked ' + amountStr + ' ' + meta.symbol + ' in the vault.');
            } else {
                toast('Staked ' + amountStr + ' ' + meta.symbol + ' successfully.', false);
            }
            document.getElementById('vaultAmount').value = '';
            updateVaultPreview();
            await refreshTokenDependentUI();
            await loadMyVaultStakesInternal();
        } catch (err) {
            console.error(err);
            setStatus('');
            toast(parseErr(err), true);
        } finally {
            btn.disabled = false;
        }
    };

    // ── My stakes ───────────────────────────────────────────────────────
    window.loadMyVaultStakes = function () { return loadMyVaultStakesInternal(); };

    async function loadMyVaultStakesInternal() {
        const list = document.getElementById('myVaultStakesList');
        if (!userAddress) {
            list.innerHTML = '<p class="text-gray-500 text-sm text-center py-6">Connect your wallet from the home page to see your stakes.</p>';
            return;
        }
        list.innerHTML = '<p class="text-gray-500 text-sm text-center py-6">Loading your stakes…</p>';
        try {
            const c = getReadContract();
            const count = (await withRpcRetry(function () { return c.stakeCountOf(userAddress); })).toNumber();
            if (!count) {
                list.innerHTML = '<p class="text-gray-500 text-sm text-center py-6">No stakes yet.</p>';
                return;
            }
            // Fetch each stake's details with limited concurrency instead of
            // fully sequential (3 RPC calls per stake, one stake at a time).
            const indices = Array.from({ length: count }, function (_, i) { return i; });
            const stakeData = await mapWithConcurrency(indices, 3, async function (i) {
                const s = await withRpcRetry(function () { return c.stakesOf(userAddress, i); });
                const unlocked = await withRpcRetry(function () { return c.isUnlocked(userAddress, i); });
                const pending = s.withdrawn ? ethers.BigNumber.from(0) : await withRpcRetry(function () { return c.pendingReward(userAddress, i); });
                return { i: i, s: s, unlocked: unlocked, pending: pending };
            });

            const rows = [];
            for (const entry of stakeData) {
                const i = entry.i, s = entry.s, unlocked = entry.unlocked, pending = entry.pending;
                let meta = tokenByAddr[s.token.toLowerCase()];
                if (!meta) {
                    meta = await cached('tokenmeta:' + s.token.toLowerCase(), async function () {
                        const erc20 = new ethers.Contract(s.token, ERC20_ABI, readProvider);
                        let symbol = '???', decimals = 18;
                        try { symbol = await withRpcRetry(function () { return erc20.symbol(); }); decimals = await withRpcRetry(function () { return erc20.decimals(); }); } catch (e) {}
                        return { address: s.token, symbol: symbol, decimals: decimals };
                    });
                    tokenByAddr[s.token.toLowerCase()] = meta;
                }

                let statusText, actions = '';
                if (s.withdrawn) {
                    statusText = 'Withdrawn';
                } else if (unlocked) {
                    statusText = 'Unlocked';
                    actions += '<button class="glass px-3 py-1.5 rounded-lg text-xs" data-action="claim" data-id="' + i + '">Claim Reward</button>' +
                        '<button class="glass px-3 py-1.5 rounded-lg text-xs" data-action="unstake" data-id="' + i + '">Unstake</button>';
                } else {
                    statusText = 'Locked until ' + fmtDate(s.startTime.toNumber() + s.lockDuration.toNumber());
                    actions += '<button class="glass px-3 py-1.5 rounded-lg text-xs" data-action="claim" data-id="' + i + '">Claim Reward</button>' +
                        '<button class="glass px-3 py-1.5 rounded-lg text-xs text-red-400" data-action="emergency" data-id="' + i + '">Emergency Unstake</button>';
                }

                rows.push(
                    '<div class="stake-row">' +
                    '<div>' +
                    '<div class="font-bold">' + fmtUnits(s.amount, meta.decimals) + ' ' + meta.symbol + '</div>' +
                    '<div class="text-gray-400 text-xs mt-0.5">' + fmtApr(s.aprBps) + ' APR · ' + fmtDays(s.lockDuration.toNumber()) + ' · ' + statusText + '</div>' +
                    (pending.gt(0) ? '<div class="text-green-400 text-xs mt-0.5">Pending reward: ' + fmtUnits(pending, meta.decimals) + ' ' + meta.symbol + '</div>' : '') +
                    '</div>' +
                    '<div class="flex gap-2 flex-wrap">' + actions + '</div>' +
                    '</div>'
                );
            }
            list.innerHTML = rows.join('');
        } catch (err) {
            console.error(err);
            list.innerHTML = '<p class="text-gray-500 text-sm text-center py-6">Failed to load your stakes.</p>';
            toast(parseErr(err), true);
        }
    }

    async function onStakeListClick(ev) {
        const btn = ev.target.closest('button[data-action]');
        if (!btn) return;
        const id = Number(btn.getAttribute('data-id'));
        const action = btn.getAttribute('data-action');
        if (!userAddress) { toast('Connect your wallet from the home page first.', true); return; }

        if (action === 'emergency') {
            const ok = window.confirm('Exit before unlock? You will forfeit accrued/reserved reward for this stake and may pay an early-exit penalty.');
            if (!ok) return;
        }

        btn.disabled = true;
        try {
            let tx;
            if (action === 'claim') tx = await vaultRW.claimReward(id);
            else if (action === 'unstake') tx = await vaultRW.unstake(id);
            else if (action === 'emergency') tx = await vaultRW.emergencyUnstake(id);
            setStatus('Confirming transaction…');
            await tx.wait();
            setStatus('');
            const doneTitle = action === 'claim' ? 'Reward Claimed!' : action === 'unstake' ? 'Unstaked!' : 'Exited!';
            if (typeof showSuccessModal === 'function') {
                showSuccessModal(doneTitle, 'Transaction confirmed.');
            } else {
                toast('Done.', false);
            }
            await loadMyVaultStakesInternal();
            await refreshTokenDependentUI();
        } catch (err) {
            console.error(err);
            setStatus('');
            toast(parseErr(err), true);
        } finally {
            btn.disabled = false;
        }
    }

})();
