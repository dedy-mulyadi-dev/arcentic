/* ============================================================================
   ArcenticVault frontend module — SELF-CONTAINED.
   ----------------------------------------------------------------------------
   Kenapa file ini terpisah dan tidak menyentuh app.js:
   app.js (file yang mengurus Swap/Pools/Lend/Stake/Admin yang sudah ada) tidak
   ikut diberikan saat fitur ini dibuat, jadi modul ini TIDAK mengasumsikan
   variabel/fungsi global apa pun dari app.js (tidak ada shared provider/signer).
   Ia membuka koneksi wallet-nya sendiri (silent eth_accounts saat load, lalu
   eth_requestAccounts saat tombol "Connect Wallet" khusus Vault ditekan).

   Konsekuensi yang perlu diketahui pemilik proyek:
   - Status "connected" di halaman Vault TIDAK otomatis sinkron dengan status
     connect di bagian lain situs (Swap/Stake/dll di app.js). Kalau wallet
     sudah pernah diberi izin (eth_accounts non-kosong), halaman ini akan
     auto-connect; kalau belum, user perlu klik connect di sini juga.
   - Alamat kontrak di bawah (VAULT_ADDRESS) diisi sesuai yang diberikan:
     0xf3b0798A5363eEDDd2aB5ED23A023621a4d63621 — SAYA TIDAK MEMVERIFIKASI
     bytecode on-chain-nya cocok dengan ArcenticVault.sol yang diberikan.
     Cek sendiri di block explorer sebelum production.
   - Tidak ada pemaksaan chain/network (chainId) di sini karena tidak
     diketahui RPC/chainId ARC Testnet. Modul ini percaya wallet user sudah
     berada di network yang benar, sama seperti asumsi yang tampaknya dipakai
     bagian lain situs ini juga.
   - Teks di halaman ini sengaja TIDAK ikut sistem i18n EN/ID yang sudah ada
     (ditandai data-no-i18n) supaya tidak perlu menebak-nebak isi kamus
     terjemahan punya app.js. Semua teks di sini bahasa Inggris saja.
   ============================================================================ */

(function () {
    'use strict';

    // ─────────────────────────── Config ───────────────────────────
    var VAULT_ADDRESS = '0xf3b0798A5363eEDDd2aB5ED23A023621a4d63621';

    var VAULT_ABI = [
        'function owner() view returns (address)',
        'function pool() view returns (address)',
        'function treasury() view returns (address)',
        'function earlyExitPenaltyBps() view returns (uint256)',
        'function paused() view returns (bool)',
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
        'function stakesOf(address,uint256) view returns (address token, uint256 tierId, uint256 amount, uint256 startTime, uint256 lockDuration, uint256 aprBps, uint256 claimedReward, uint256 reservedReward, bool withdrawn)',
        'function pendingReward(address,uint256) view returns (uint256)',
        'function isUnlocked(address,uint256) view returns (bool)',
        'function addToken(address) external',
        'function setTokenSupported(address,bool) external',
        'function addTier(address,uint256,uint256) external',
        'function setTier(address,uint256,uint256,bool) external',
        'function setTreasury(address) external',
        'function setEarlyExitPenaltyBps(uint256) external',
        'function pause() external',
        'function unpause() external',
        'function fundRewards(address,uint256) external',
        'function withdrawUnreservedRewards(address,uint256) external',
        'function stake(address,uint256,uint256) external',
        'function claimReward(uint256) external',
        'function unstake(uint256) external',
        'function emergencyUnstake(uint256) external'
    ];

    var ERC20_ABI = [
        'function name() view returns (string)',
        'function symbol() view returns (string)',
        'function decimals() view returns (uint8)',
        'function balanceOf(address) view returns (uint256)',
        'function allowance(address,address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)'
    ];

    var BPS_DENOMINATOR = ethersBN(10000);
    var SECONDS_PER_YEAR = ethersBN(365 * 24 * 60 * 60);

    function ethersBN(v) { return window.ethers.BigNumber.from(v); }

    // ─────────────────────────── State ───────────────────────────
    var readProvider = null;   // works even without a connected account
    var signer = null;         // set once wallet is connected
    var account = null;
    var vaultRead = null;      // contract instance bound to readProvider
    var vaultWrite = null;     // contract instance bound to signer

    var tokens = [];           // [{address, symbol, decimals, supported}]
    var selectedToken = null;  // address
    var selectedTierId = null;
    var isOwner = false;

    // ─────────────────────────── View open/close ───────────────────────────
    // All other overlay views on this site (#stakeView, #poolsView, #swapView,
    // #adminView, #portfolioView, #lendView, #bridgeView, #tradingHubView,
    // #spotTradeView) share the same "position:fixed + .open class" pattern.
    // We mirror that pattern for #vaultView, and additionally watch for any
    // of those OTHER views getting `.open` added (e.g. user clicks "Home" or
    // "Stake" in the main nav, handled by app.js, which has no idea #vaultView
    // exists) so this view auto-closes in sync rather than getting stuck open
    // on top of everything else.
    var OTHER_VIEW_IDS = [
        'homeView', 'portfolioView', 'adminView', 'spotTradeView',
        'tradingHubView', 'swapView', 'poolsView', 'lendView',
        'stakeView', 'bridgeView'
    ];

    function closeVaultView() {
        var el = document.getElementById('vaultView');
        if (el) el.classList.remove('open');
    }

    function openVaultView() {
        OTHER_VIEW_IDS.forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.classList.remove('open');
        });
        var el = document.getElementById('vaultView');
        if (el) el.classList.add('open');
    }

    function watchForOtherViewsOpening() {
        var obs = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var t = mutations[i].target;
                if (t && t.id && t.id !== 'vaultView' && OTHER_VIEW_IDS.indexOf(t.id) !== -1) {
                    if (t.classList.contains('open')) { closeVaultView(); return; }
                }
            }
        });
        OTHER_VIEW_IDS.forEach(function (id) {
            var el = document.getElementById(id);
            if (el) obs.observe(el, { attributes: true, attributeFilter: ['class'] });
        });
    }

    window.showVault = function () {
        openVaultView();
        ensureReadProvider();
        refreshVaultStaticData();
        if (account) loadMyVaultStakes();
    };

    // Wire the back button + nav buttons after DOM is ready.
    document.addEventListener('DOMContentLoaded', function () {
        watchForOtherViewsOpening();
        var backBtn = document.querySelector('#vaultView .vault-back-btn');
        if (backBtn) backBtn.addEventListener('click', function () {
            closeVaultView();
            if (typeof window.showHome === 'function') window.showHome();
        });
        silentlyReconnect();
    });

    // ─────────────────────────── Wallet ───────────────────────────
    function ensureReadProvider() {
        if (readProvider) return readProvider;
        if (!window.ethereum) {
            setVaultStatus('No wallet extension detected (e.g. MetaMask). Install one to use the Vault.', true);
            return null;
        }
        readProvider = new window.ethers.providers.Web3Provider(window.ethereum);
        vaultRead = new window.ethers.Contract(VAULT_ADDRESS, VAULT_ABI, readProvider);
        return readProvider;
    }

    function silentlyReconnect() {
        if (!window.ethereum) return;
        window.ethereum.request({ method: 'eth_accounts' }).then(function (accts) {
            if (accts && accts.length) hydrateAccount(accts[0]);
        }).catch(function () {});
        window.ethereum.on && window.ethereum.on('accountsChanged', function (accts) {
            if (accts && accts.length) hydrateAccount(accts[0]);
            else disconnectVaultWallet();
        });
        window.ethereum.on && window.ethereum.on('chainChanged', function () {
            window.location.reload();
        });
    }

    window.connectVaultWallet = function () {
        if (!window.ethereum) {
            setVaultStatus('No wallet extension detected (e.g. MetaMask). Install one to use the Vault.', true);
            return;
        }
        window.ethereum.request({ method: 'eth_requestAccounts' }).then(function (accts) {
            if (accts && accts.length) hydrateAccount(accts[0]);
        }).catch(function (err) {
            setVaultStatus('Wallet connection rejected.', true);
        });
    };

    function hydrateAccount(addr) {
        ensureReadProvider();
        account = addr;
        signer = readProvider.getSigner();
        vaultWrite = new window.ethers.Contract(VAULT_ADDRESS, VAULT_ABI, signer);
        var btn = document.getElementById('btnVaultConnect');
        if (btn) btn.textContent = shortAddr(addr);
        checkOwner();
        refreshVaultStaticData();
        loadMyVaultStakes();
    }

    function disconnectVaultWallet() {
        account = null;
        signer = null;
        vaultWrite = null;
        isOwner = false;
        var btn = document.getElementById('btnVaultConnect');
        if (btn) btn.textContent = 'Connect Wallet';
        var panel = document.getElementById('vaultAdminPanel');
        if (panel) panel.style.display = 'none';
        var list = document.getElementById('myVaultStakesList');
        if (list) list.innerHTML = '<p class="text-gray-500 text-sm text-center py-6">Connect your wallet to see your stakes.</p>';
    }

    function checkOwner() {
        if (!vaultRead || !account) return;
        vaultRead.owner().then(function (o) {
            isOwner = o.toLowerCase() === account.toLowerCase();
            var panel = document.getElementById('vaultAdminPanel');
            if (panel) panel.style.display = isOwner ? 'block' : 'none';
            if (isOwner) loadVaultAdminOverview();
        }).catch(function () {});
    }

    function shortAddr(a) { return a.slice(0, 6) + '…' + a.slice(-4); }

    function setVaultStatus(msg, isError) {
        var el = document.getElementById('vaultStatus');
        if (!el) return;
        el.textContent = msg;
        el.style.color = isError ? '#f87171' : '#9ca3af';
        el.classList.remove('hidden');
    }

    // ─────────────────────────── Load tokens / tiers ───────────────────────────
    function refreshVaultStaticData() {
        if (!vaultRead) return;
        var picker = document.getElementById('vaultTokenPicker');
        if (picker) picker.innerHTML = '<option value="">Loading tokens…</option>';

        vaultRead.supportedTokensLength().then(function (lenBN) {
            var len = lenBN.toNumber();
            var addrPromises = [];
            for (var i = 0; i < len; i++) addrPromises.push(vaultRead.supportedTokenAt(i));
            return Promise.all(addrPromises);
        }).then(function (addrs) {
            return Promise.all(addrs.map(function (addr) {
                var erc20 = new window.ethers.Contract(addr, ERC20_ABI, readProvider);
                return Promise.all([
                    vaultRead.tokenSupported(addr),
                    erc20.symbol().catch(function () { return '???'; }),
                    erc20.decimals().catch(function () { return 18; })
                ]).then(function (r) {
                    return { address: addr, supported: r[0], symbol: r[1], decimals: r[2] };
                });
            }));
        }).then(function (list) {
            tokens = list.filter(function (t) { return t.supported; });
            renderVaultTokenPicker();
        }).catch(function (err) {
            setVaultStatus('Failed to load token list: ' + (err && err.message ? err.message : err), true);
        });
    }

    function renderVaultTokenPicker() {
        var picker = document.getElementById('vaultTokenPicker');
        if (!picker) return;
        if (!tokens.length) {
            picker.innerHTML = '<option value="">No tokens whitelisted yet</option>';
            picker.disabled = true;
            return;
        }
        picker.disabled = false;
        picker.innerHTML = tokens.map(function (t) {
            return '<option value="' + t.address + '">' + t.symbol + '</option>';
        }).join('');
        selectVaultToken(tokens[0].address);
    }

    window.selectVaultToken = function (addr) {
        selectedToken = addr;
        selectedTierId = null;
        var picker = document.getElementById('vaultTokenPicker');
        if (picker) picker.value = addr;
        loadVaultTokenStats();
        loadVaultTiers();
        refreshVaultBalance();
    };

    function currentTokenMeta() {
        return tokens.filter(function (t) { return t.address === selectedToken; })[0] || null;
    }

    function loadVaultTokenStats() {
        if (!vaultRead || !selectedToken) return;
        var meta = currentTokenMeta();
        Promise.all([
            vaultRead.totalStakedOf(selectedToken),
            vaultRead.vaultLiquidityInPool(selectedToken)
        ]).then(function (r) {
            var totalStaked = r[0], liqInPool = r[1];
            setText('vaultTotalStaked', meta ? fmt(totalStaked, meta.decimals) : '—');
            document.querySelectorAll('#vaultView .vault-token-unit').forEach(function (el) {
                el.textContent = meta ? meta.symbol : '—';
            });
            var mismatchEl = document.getElementById('vaultPoolMismatch');
            if (mismatchEl) {
                if (!totalStaked.eq(liqInPool)) {
                    mismatchEl.classList.remove('hidden');
                    mismatchEl.textContent = '⚠ Vault liquidity in pool (' + fmt(liqInPool, meta ? meta.decimals : 18) +
                        ') does not match total staked (' + fmt(totalStaked, meta ? meta.decimals : 18) +
                        '). This can happen if the pool owner called emergencyWithdraw() on ArcenticMultiPool — withdrawals for this token may fail or return less than expected.';
                } else {
                    mismatchEl.classList.add('hidden');
                }
            }
        }).catch(function () {});
    }

    function loadVaultTiers() {
        var grid = document.getElementById('vaultTierGrid');
        if (!grid || !vaultRead || !selectedToken) return;
        grid.innerHTML = '<div class="tier-card text-center text-gray-500 text-sm col-span-3">Loading tiers…</div>';
        vaultRead.tiersLength(selectedToken).then(function (lenBN) {
            var len = lenBN.toNumber();
            var promises = [];
            for (var i = 0; i < len; i++) promises.push(vaultRead.tierAt(selectedToken, i));
            return Promise.all(promises);
        }).then(function (tiers) {
            var activeTiers = [];
            tiers.forEach(function (t, i) { if (t.active) activeTiers.push({ id: i, lockDuration: t.lockDuration, aprBps: t.aprBps }); });
            if (!activeTiers.length) {
                grid.innerHTML = '<div class="tier-card text-center text-gray-500 text-sm col-span-3">No active lock tiers for this token yet.</div>';
                return;
            }
            grid.innerHTML = activeTiers.map(function (t) {
                var days = Math.round(t.lockDuration.toNumber() / 86400);
                var aprPct = (t.aprBps.toNumber() / 100).toFixed(2);
                return '<div class="tier-card" data-tier="' + t.id + '" onclick="selectVaultTier(' + t.id + ',' + t.lockDuration.toString() + ',' + t.aprBps.toString() + ')">' +
                    '<div class="font-black text-lg">' + days + 'd</div>' +
                    '<div class="text-green-400 text-sm font-bold">' + aprPct + '% APR</div>' +
                    '</div>';
            }).join('');
            selectVaultTier(activeTiers[0].id, activeTiers[0].lockDuration.toString(), activeTiers[0].aprBps.toString());
        }).catch(function (err) {
            grid.innerHTML = '<div class="tier-card text-center text-red-400 text-sm col-span-3">Failed to load tiers.</div>';
        });
    }

    var currentTierLock = null, currentTierApr = null;
    window.selectVaultTier = function (id, lockDuration, aprBps) {
        selectedTierId = id;
        currentTierLock = window.ethers.BigNumber.from(lockDuration);
        currentTierApr = window.ethers.BigNumber.from(aprBps);
        document.querySelectorAll('#vaultTierGrid .tier-card').forEach(function (el) {
            el.classList.toggle('tier-active', el.getAttribute('data-tier') === String(id));
        });
        updateVaultPreview();
    };

    function refreshVaultBalance() {
        var meta = currentTokenMeta();
        var balEl = document.getElementById('vaultTokenBal');
        if (!meta || !account || !readProvider) { if (balEl) balEl.textContent = '—'; return; }
        var erc20 = new window.ethers.Contract(meta.address, ERC20_ABI, readProvider);
        erc20.balanceOf(account).then(function (bal) {
            if (balEl) balEl.textContent = fmt(bal, meta.decimals);
        }).catch(function () {});
    }

    window.setVaultMax = function () {
        var meta = currentTokenMeta();
        var balEl = document.getElementById('vaultTokenBal');
        var amountEl = document.getElementById('vaultAmount');
        if (meta && balEl && amountEl && balEl.textContent !== '—') amountEl.value = balEl.textContent;
        updateVaultPreview();
    };

    window.updateVaultPreview = function () {
        var amountEl = document.getElementById('vaultAmount');
        var unlockEl = document.getElementById('vaultPreviewUnlock');
        var rewardEl = document.getElementById('vaultPreviewReward');
        var meta = currentTokenMeta();
        if (!amountEl || !unlockEl || !rewardEl) return;
        if (!meta || currentTierLock == null || !amountEl.value || Number(amountEl.value) <= 0) {
            unlockEl.textContent = '—';
            rewardEl.textContent = '—';
            return;
        }
        try {
            var amountBN = window.ethers.utils.parseUnits(amountEl.value, meta.decimals);
            var reward = amountBN.mul(currentTierApr).mul(currentTierLock).div(BPS_DENOMINATOR).div(SECONDS_PER_YEAR);
            rewardEl.textContent = fmt(reward, meta.decimals) + ' ' + meta.symbol;
            var unlockDate = new Date((Date.now() / 1000 + currentTierLock.toNumber()) * 1000);
            unlockEl.textContent = unlockDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        } catch (e) {
            unlockEl.textContent = '—';
            rewardEl.textContent = '—';
        }
    };

    // ─────────────────────────── Stake / claim / unstake ───────────────────────────
    window.doVaultStake = function () {
        if (!vaultWrite || !account) { window.connectVaultWallet(); return; }
        var meta = currentTokenMeta();
        var amountEl = document.getElementById('vaultAmount');
        if (!meta || selectedTierId == null) { setVaultStatus('Pick a token and a lock tier first.', true); return; }
        if (!amountEl.value || Number(amountEl.value) <= 0) { setVaultStatus('Enter an amount.', true); return; }

        var amountBN = window.ethers.utils.parseUnits(amountEl.value, meta.decimals);
        var erc20 = new window.ethers.Contract(meta.address, ERC20_ABI, signer);
        var btn = document.getElementById('btnVaultStake');
        if (btn) btn.disabled = true;
        setVaultStatus('Checking allowance…');

        erc20.allowance(account, VAULT_ADDRESS).then(function (allowance) {
            if (allowance.lt(amountBN)) {
                setVaultStatus('Approving ' + meta.symbol + '…');
                return erc20.approve(VAULT_ADDRESS, amountBN).then(function (tx) { return tx.wait(); });
            }
        }).then(function () {
            setVaultStatus('Staking… confirm in your wallet.');
            return vaultWrite.stake(meta.address, selectedTierId, amountBN);
        }).then(function (tx) {
            setVaultStatus('Processing…');
            return tx.wait();
        }).then(function () {
            setVaultStatus('Staked successfully.');
            amountEl.value = '';
            updateVaultPreview();
            refreshVaultBalance();
            loadVaultTokenStats();
            loadMyVaultStakes();
        }).catch(function (err) {
            setVaultStatus(shortErr(err), true);
        }).finally(function () {
            if (btn) btn.disabled = false;
        });
    };

    function loadMyVaultStakes() {
        var list = document.getElementById('myVaultStakesList');
        if (!list || !vaultRead || !account) return;
        list.innerHTML = '<p class="text-gray-500 text-sm text-center py-6">Loading your stakes…</p>';

        vaultRead.stakeCountOf(account).then(function (countBN) {
            var count = countBN.toNumber();
            if (!count) {
                list.innerHTML = '<p class="text-gray-500 text-sm text-center py-6">No stakes yet.</p>';
                return;
            }
            var promises = [];
            for (var i = 0; i < count; i++) {
                promises.push(Promise.all([
                    vaultRead.stakesOf(account, i),
                    vaultRead.pendingReward(account, i),
                    vaultRead.isUnlocked(account, i)
                ]).then(function (r) { return { info: r[0], pending: r[1], unlocked: r[2] }; }));
            }
            return Promise.all(promises);
        }).then(function (stakes) {
            if (!stakes) return;
            renderMyVaultStakes(stakes);
        }).catch(function (err) {
            list.innerHTML = '<p class="text-red-400 text-sm text-center py-6">Failed to load stakes.</p>';
        });
    }
    window.loadMyVaultStakes = loadMyVaultStakes;

    function tokenMetaFor(addr) {
        return tokens.filter(function (t) { return t.address.toLowerCase() === addr.toLowerCase(); })[0]
            || { symbol: addr.slice(0, 6) + '…', decimals: 18 };
    }

    function renderMyVaultStakes(stakes) {
        var list = document.getElementById('myVaultStakesList');
        var rows = [];
        stakes.forEach(function (s, id) {
            var info = s.info;
            if (info.withdrawn) return;
            var meta = tokenMetaFor(info.token);
            var days = Math.round(info.lockDuration.toNumber() / 86400);
            var aprPct = (info.aprBps.toNumber() / 100).toFixed(2);
            var unlockDate = new Date((info.startTime.toNumber() + info.lockDuration.toNumber()) * 1000);
            var penaltyBps = window.__vaultPenaltyBps || 0;

            var actions = '';
            if (s.unlocked) {
                actions += '<button class="glass px-4 py-2 rounded-xl text-xs sm:text-sm font-bold hover:border-white/30 transition" onclick="unstakeVault(' + id + ')">Unstake</button>';
            } else {
                actions += '<button class="glass px-4 py-2 rounded-xl text-xs sm:text-sm font-bold hover:border-white/30 transition" style="color:#f87171;border-color:rgba(239,68,68,.35);" onclick="emergencyUnstakeVault(' + id + ',' + penaltyBps + ')">Emergency Exit</button>';
            }
            if (s.pending.gt(0)) {
                actions += '<button class="gradient px-4 py-2 rounded-xl text-xs sm:text-sm font-bold glow" onclick="claimVaultReward(' + id + ')">Claim ' + fmt(s.pending, meta.decimals) + '</button>';
            }

            rows.push(
                '<div class="stake-row">' +
                    '<div>' +
                        '<div class="font-bold">' + fmt(info.amount, meta.decimals) + ' ' + meta.symbol + '</div>' +
                        '<div class="text-gray-400 text-xs mt-0.5">' + days + 'd lock · ' + aprPct + '% APR · ' +
                            (s.unlocked ? 'Unlocked' : 'Unlocks ' + unlockDate.toLocaleDateString()) +
                        '</div>' +
                    '</div>' +
                    '<div style="display:flex;gap:8px;flex-wrap:wrap;">' + actions + '</div>' +
                '</div>'
            );
        });
        list.innerHTML = rows.length ? rows.join('') : '<p class="text-gray-500 text-sm text-center py-6">No open stakes.</p>';
    }

    window.claimVaultReward = function (stakeId) {
        if (!vaultWrite) return;
        setVaultStatus('Claiming reward…');
        vaultWrite.claimReward(stakeId).then(function (tx) { return tx.wait(); }).then(function () {
            setVaultStatus('Reward claimed.');
            loadMyVaultStakes();
        }).catch(function (err) { setVaultStatus(shortErr(err), true); });
    };

    window.unstakeVault = function (stakeId) {
        if (!vaultWrite) return;
        setVaultStatus('Unstaking…');
        vaultWrite.unstake(stakeId).then(function (tx) { return tx.wait(); }).then(function () {
            setVaultStatus('Unstaked successfully.');
            loadMyVaultStakes();
            loadVaultTokenStats();
            refreshVaultBalance();
        }).catch(function (err) { setVaultStatus(shortErr(err), true); });
    };

    window.emergencyUnstakeVault = function (stakeId, penaltyBps) {
        var pct = (penaltyBps / 100).toFixed(2);
        var ok = window.confirm(
            'This stake is still locked. Emergency exit forfeits ALL accrued/reserved reward for ' +
            'this stake, and charges a ' + pct + '% early-exit penalty on your principal, sent to the treasury. Continue?'
        );
        if (!ok || !vaultWrite) return;
        setVaultStatus('Processing emergency exit…');
        vaultWrite.emergencyUnstake(stakeId).then(function (tx) { return tx.wait(); }).then(function () {
            setVaultStatus('Emergency exit complete.');
            loadMyVaultStakes();
            loadVaultTokenStats();
            refreshVaultBalance();
        }).catch(function (err) { setVaultStatus(shortErr(err), true); });
    };

    // ─────────────────────────── Admin (owner-only) ───────────────────────────
    function loadVaultAdminOverview() {
        if (!vaultRead) return;
        Promise.all([
            vaultRead.pool(), vaultRead.treasury(), vaultRead.earlyExitPenaltyBps(), vaultRead.paused()
        ]).then(function (r) {
            window.__vaultPenaltyBps = r[2].toNumber();
            setText('vaultAdminPool', r[0]);
            setText('vaultAdminTreasury', r[1]);
            setText('vaultAdminPenalty', (r[2].toNumber() / 100).toFixed(2) + '%');
            setText('vaultAdminPaused', r[3] ? '⏸ Paused' : '▶ Live');
        }).catch(function () {});
    }

    window.vaultAdminAddToken = function () {
        var addr = document.getElementById('vaultAdminNewTokenAddr').value.trim();
        if (!vaultWrite || !addr) return;
        setVaultStatus('Adding token…');
        vaultWrite.addToken(addr).then(function (tx) { return tx.wait(); }).then(function () {
            setVaultStatus('Token added. Enable it and add a lock tier before users can stake it.');
            refreshVaultStaticData();
        }).catch(function (err) { setVaultStatus(shortErr(err), true); });
    };

    window.vaultAdminSetSupported = function (supported) {
        var addr = document.getElementById('vaultAdminTokenAddr').value.trim();
        if (!vaultWrite || !addr) return;
        setVaultStatus((supported ? 'Enabling' : 'Disabling') + ' token…');
        vaultWrite.setTokenSupported(addr, supported).then(function (tx) { return tx.wait(); }).then(function () {
            setVaultStatus('Done.');
            refreshVaultStaticData();
        }).catch(function (err) { setVaultStatus(shortErr(err), true); });
    };

    window.vaultAdminAddTier = function () {
        if (!vaultWrite || !selectedToken) { setVaultStatus('Select a token first.', true); return; }
        var days = Number(document.getElementById('vaultAdminTierDays').value);
        var aprPct = Number(document.getElementById('vaultAdminTierApr').value);
        if (!days || !aprPct) { setVaultStatus('Enter lock days and APR %.', true); return; }
        var lockDuration = Math.round(days * 86400);
        var aprBps = Math.round(aprPct * 100);
        setVaultStatus('Adding tier…');
        vaultWrite.addTier(selectedToken, lockDuration, aprBps).then(function (tx) { return tx.wait(); }).then(function () {
            setVaultStatus('Tier added.');
            loadVaultTiers();
        }).catch(function (err) { setVaultStatus(shortErr(err), true); });
    };

    window.vaultAdminSetTier = function (active) {
        if (!vaultWrite || !selectedToken) { setVaultStatus('Select a token first.', true); return; }
        var tierId = Number(document.getElementById('vaultAdminTierId').value);
        var aprPct = Number(document.getElementById('vaultAdminTierNewApr').value);
        if (isNaN(tierId) || !aprPct) { setVaultStatus('Enter tier ID and new APR %.', true); return; }
        var aprBps = Math.round(aprPct * 100);
        setVaultStatus('Updating tier…');
        vaultWrite.setTier(selectedToken, tierId, aprBps, active).then(function (tx) { return tx.wait(); }).then(function () {
            setVaultStatus('Tier updated.');
            loadVaultTiers();
        }).catch(function (err) { setVaultStatus(shortErr(err), true); });
    };

    window.vaultAdminFundRewards = function () {
        var meta = currentTokenMeta();
        var amtEl = document.getElementById('vaultAdminFundAmt');
        if (!vaultWrite || !meta || !amtEl.value) return;
        var amountBN = window.ethers.utils.parseUnits(amtEl.value, meta.decimals);
        var erc20 = new window.ethers.Contract(meta.address, ERC20_ABI, signer);
        setVaultStatus('Approving reward funding…');
        erc20.allowance(account, VAULT_ADDRESS).then(function (allowance) {
            if (allowance.lt(amountBN)) return erc20.approve(VAULT_ADDRESS, amountBN).then(function (tx) { return tx.wait(); });
        }).then(function () {
            setVaultStatus('Funding reward pool…');
            return vaultWrite.fundRewards(meta.address, amountBN);
        }).then(function (tx) { return tx.wait(); }).then(function () {
            setVaultStatus('Reward pool funded.');
            amtEl.value = '';
        }).catch(function (err) { setVaultStatus(shortErr(err), true); });
    };

    window.vaultAdminWithdrawUnreserved = function () {
        var meta = currentTokenMeta();
        var amtEl = document.getElementById('vaultAdminWithdrawAmt');
        if (!vaultWrite || !meta || !amtEl.value) return;
        var amountBN = window.ethers.utils.parseUnits(amtEl.value, meta.decimals);
        setVaultStatus('Withdrawing unreserved rewards…');
        vaultWrite.withdrawUnreservedRewards(meta.address, amountBN).then(function (tx) { return tx.wait(); }).then(function () {
            setVaultStatus('Withdrawn.');
            amtEl.value = '';
        }).catch(function (err) { setVaultStatus(shortErr(err), true); });
    };

    window.vaultAdminSetTreasury = function () {
        var addr = document.getElementById('vaultAdminTreasuryAddr').value.trim();
        if (!vaultWrite || !addr) return;
        setVaultStatus('Updating treasury…');
        vaultWrite.setTreasury(addr).then(function (tx) { return tx.wait(); }).then(function () {
            setVaultStatus('Treasury updated.');
            loadVaultAdminOverview();
        }).catch(function (err) { setVaultStatus(shortErr(err), true); });
    };

    window.vaultAdminSetPenalty = function () {
        var pct = Number(document.getElementById('vaultAdminPenaltyInput').value);
        if (!vaultWrite || isNaN(pct)) return;
        var bps = Math.round(pct * 100);
        if (bps > 3000) { setVaultStatus('Penalty cannot exceed 30%.', true); return; }
        setVaultStatus('Updating penalty…');
        vaultWrite.setEarlyExitPenaltyBps(bps).then(function (tx) { return tx.wait(); }).then(function () {
            setVaultStatus('Penalty updated.');
            loadVaultAdminOverview();
        }).catch(function (err) { setVaultStatus(shortErr(err), true); });
    };

    window.vaultAdminTogglePause = function (pause) {
        if (!vaultWrite) return;
        setVaultStatus(pause ? 'Pausing…' : 'Unpausing…');
        var call = pause ? vaultWrite.pause() : vaultWrite.unpause();
        call.then(function (tx) { return tx.wait(); }).then(function () {
            setVaultStatus(pause ? 'Vault paused.' : 'Vault unpaused.');
            loadVaultAdminOverview();
        }).catch(function (err) { setVaultStatus(shortErr(err), true); });
    };

    // ─────────────────────────── Helpers ───────────────────────────
    function fmt(bn, decimals) {
        var s = window.ethers.utils.formatUnits(bn, decimals);
        var num = Number(s);
        if (isNaN(num)) return s;
        return num.toLocaleString(undefined, { maximumFractionDigits: 6 });
    }

    function setText(id, val) {
        var el = document.getElementById(id);
        if (el) el.textContent = val;
    }

    function shortErr(err) {
        if (!err) return 'Transaction failed.';
        var msg = (err.error && err.error.message) || err.reason || err.message || String(err);
        if (err.code === 4001 || /user rejected/i.test(msg)) return 'Transaction rejected in wallet.';
        var m = msg.match(/reason="([^"]+)"/);
        if (m) return m[1];
        return msg.length > 140 ? msg.slice(0, 140) + '…' : msg;
    }
})();
