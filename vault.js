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
        rpcUrl: 'https://arc-testnet.g.alchemy.com/v2/ujJWV8UeW1N9-LcH7aXK8',
        nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
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
        if (err && err.error && err.error.message) return err.error.message;
        if (err && err.reason) return err.reason;
        if (err && err.data && err.data.message) return err.data.message;
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

    function getReadContract() { return vaultRW || vaultRO; }

    // ── Networking: connect / switch chain ─────────────────────────────
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
                        rpcUrls: [VAULT_CONFIG.rpcUrl],
                        nativeCurrency: VAULT_CONFIG.nativeCurrency,
                        blockExplorerUrls: [VAULT_CONFIG.explorerUrl]
                    }]
                });
            } else {
                throw switchErr;
            }
        }
        // MetaMask needs a moment to swap networks before we re-read it.
        webProvider = new ethers.providers.Web3Provider(window.ethereum, 'any');
    }

    window.connectVaultWallet = async function () {
        if (!window.ethereum) {
            toast('Install a wallet like MetaMask first.', true);
            return;
        }
        const btn = document.getElementById('btnVaultConnect');
        const prevLabel = btn.textContent;
        btn.textContent = 'Connecting…';
        btn.disabled = true;
        try {
            await window.ethereum.request({ method: 'eth_requestAccounts' });
            webProvider = new ethers.providers.Web3Provider(window.ethereum, 'any');
            await ensureCorrectChain();
            signer = webProvider.getSigner();
            userAddress = await signer.getAddress();
            vaultRW = new ethers.Contract(VAULT_CONFIG.address, VAULT_ABI, signer);

            btn.textContent = shortAddr(userAddress);
            btn.disabled = false;

            if (!window.__vaultListenersBound) {
                window.__vaultListenersBound = true;
                window.ethereum.on('accountsChanged', function (accts) {
                    if (!accts || !accts.length) {
                        userAddress = null; signer = null; vaultRW = null;
                        document.getElementById('btnVaultConnect').textContent = 'Connect Wallet';
                        document.getElementById('btnVaultConnect').disabled = false;
                        document.getElementById('myVaultStakesList').innerHTML =
                            '<p class="text-gray-500 text-sm text-center py-6">Connect your wallet to see your stakes.</p>';
                        refreshTokenDependentUI();
                    } else {
                        window.connectVaultWallet();
                    }
                });
                window.ethereum.on('chainChanged', function () { window.location.reload(); });
            }

            await refreshTokenDependentUI();
            await loadMyVaultStakesInternal();
        } catch (err) {
            console.error(err);
            toast(parseErr(err), true);
            btn.textContent = prevLabel;
            btn.disabled = false;
        }
    };

    // ── Init / open view ────────────────────────────────────────────────
    window.showVault = function () {
        document.getElementById('vaultView').classList.add('open');
        if (!inited) {
            inited = true;
            bootstrap();
        }
    };

    async function bootstrap() {
        readProvider = new ethers.providers.JsonRpcProvider(VAULT_CONFIG.rpcUrl);
        vaultRO = new ethers.Contract(VAULT_CONFIG.address, VAULT_ABI, readProvider);

        const backBtn = document.querySelector('.vault-back-btn');
        if (backBtn) backBtn.addEventListener('click', function () {
            document.getElementById('vaultView').classList.remove('open');
        });

        document.getElementById('myVaultStakesList').addEventListener('click', onStakeListClick);

        await loadTokenList();

        // Silent reconnect if this site already has permission (no popup).
        if (window.ethereum) {
            try {
                const accts = await window.ethereum.request({ method: 'eth_accounts' });
                if (accts && accts.length) await window.connectVaultWallet();
            } catch (e) { /* ignore — user can click Connect manually */ }
        }
    }

    // ── Tokens & tiers ──────────────────────────────────────────────────
    async function loadTokenList() {
        const picker = document.getElementById('vaultTokenPicker');
        try {
            const c = getReadContract();
            const n = (await c.supportedTokensLength()).toNumber();
            tokens = [];
            tokenByAddr = {};
            for (let i = 0; i < n; i++) {
                const addr = await c.supportedTokenAt(i);
                const erc20 = new ethers.Contract(addr, ERC20_ABI, readProvider);
                let symbol = '???', decimals = 18;
                try { symbol = await erc20.symbol(); } catch (e) {}
                try { decimals = await erc20.decimals(); } catch (e) {}
                const meta = { address: addr, symbol: symbol, decimals: decimals };
                tokens.push(meta);
                tokenByAddr[addr.toLowerCase()] = meta;
            }

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
            const n = (await c.tiersLength(tokenAddr)).toNumber();
            tiers = [];
            for (let i = 0; i < n; i++) {
                const t = await c.tierAt(tokenAddr, i);
                tiers.push({ id: i, lockDuration: t.lockDuration.toNumber(), aprBps: t.aprBps.toNumber(), active: t.active });
            }
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
                c.totalStakedOf(selectedToken),
                c.earlyExitPenaltyBps()
            ]);
            document.getElementById('vaultTotalStaked').textContent = fmtUnits(totalStaked, meta.decimals);
            document.getElementById('vaultPenaltyDisplay').textContent = fmtApr(penaltyBps.toNumber());
        } catch (err) { console.error(err); }

        try {
            const liq = await c.vaultLiquidityInPool(selectedToken);
            const staked = await c.totalStakedOf(selectedToken);
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
        if (!selectedToken || !userAddress) { toast('Connect your wallet first.', true); return; }
        const meta = tokenByAddr[selectedToken.toLowerCase()];
        const erc20 = new ethers.Contract(selectedToken, ERC20_ABI, readProvider);
        const bal = await erc20.balanceOf(userAddress);
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
        if (!userAddress) { toast('Connect your wallet first.', true); return; }
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
            const tx = await vaultRW.stake(selectedToken, selectedTierId, amountWei);
            await tx.wait();

            setStatus('');
            toast('Staked ' + amountStr + ' ' + meta.symbol + ' successfully.', false);
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
            list.innerHTML = '<p class="text-gray-500 text-sm text-center py-6">Connect your wallet to see your stakes.</p>';
            return;
        }
        list.innerHTML = '<p class="text-gray-500 text-sm text-center py-6">Loading your stakes…</p>';
        try {
            const c = getReadContract();
            const count = (await c.stakeCountOf(userAddress)).toNumber();
            if (!count) {
                list.innerHTML = '<p class="text-gray-500 text-sm text-center py-6">No stakes yet.</p>';
                return;
            }
            const rows = [];
            for (let i = 0; i < count; i++) {
                const s = await c.stakesOf(userAddress, i);
                const unlocked = await c.isUnlocked(userAddress, i);
                const pending = s.withdrawn ? ethers.BigNumber.from(0) : await c.pendingReward(userAddress, i);
                let meta = tokenByAddr[s.token.toLowerCase()];
                if (!meta) {
                    const erc20 = new ethers.Contract(s.token, ERC20_ABI, readProvider);
                    let symbol = '???', decimals = 18;
                    try { symbol = await erc20.symbol(); decimals = await erc20.decimals(); } catch (e) {}
                    meta = { address: s.token, symbol: symbol, decimals: decimals };
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
        if (!userAddress) { toast('Connect your wallet first.', true); return; }

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
            toast('Done.', false);
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
