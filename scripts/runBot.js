const { ethers } = require("hardhat");
const Redis = require("ioredis");
const TelegramBot = require('node-telegram-bot-api');
require("dotenv").config();

const CONFIG = {
    botAddress: process.env.MY_BOT_ADDRESS?.toLowerCase(),
    aavePool: process.env.AAVE_POOL_ADDRESS?.toLowerCase(),
    oracle: process.env.AAVE_ORACLE_ADDRESS?.toLowerCase(),
    subgraph: process.env.THE_GRAPH_URL,
    theGraphAPiKey: process.env.THE_GRAPH_API_KEY,
    debtAsset: process.env.DEBT_ASSET_ADDRESS?.toLowerCase(),
    debtSymbol: process.env.DEBT_ASSET_SYMBOL || "USDC",
    debtDecimals: parseInt(process.env.DEBT_ASSET_DECIMALS || "6"),
    collateralAsset: process.env.COLLATERAL_ASSET_ADDRESS?.toLowerCase(),
    chainId: parseInt(process.env.CHAIN_ID || "42161"),
    redisUrl: process.env.REDIS_URL,
    tgToken: process.env.TELEGRAM_BOT_TOKEN,
    tgChatId: process.env.TELEGRAM_CHAT_ID ? process.env.TELEGRAM_CHAT_ID.trim() : null
};

const redis = new Redis(CONFIG.redisUrl, { maxRetriesPerRequest: null });
let currentEthPrice = 0;
let lastBlockProcessed = 0;
let isBotEnabled = true;
let isSyncPaused = false;
let telegramBot = null;
let activityLog = [];

// --- GESTORE PROVIDER ---
const rpcUrls = [process.env.RPC_2, process.env.RPC_3, "https://arb1.arbitrum.io/rpc", process.env.RPC_1].filter(url => url);
class SmartProviderManager {
    constructor(urls) {
        this.providers = urls.map(url => {
            const inst = new ethers.JsonRpcProvider(url, CONFIG.chainId, { staticNetwork: true });
            const poolContract = new ethers.Contract(CONFIG.aavePool, ["function getUserAccountData(address) view returns (uint256 col, uint256 debt, uint256, uint256 thr, uint256, uint256 hf)"], inst);
            return { inst, poolContract };
        });
        this.index = 0;
    }
    async execute(task) {
        for (let i = 0; i < this.providers.length; i++) {
            const p = this.providers[this.index];
            this.index = (this.index + 1) % this.providers.length;
            try { return await task(p); } catch (err) {
                if (i === this.providers.length - 1) throw err;
                continue;
            }
        }
    }
}
const pManager = new SmartProviderManager(rpcUrls);

// --- NOTIFICHE (CON OPZIONE SILENZIOSO) ---
function logAndNotify(message, silent = false) {
    const ts = new Date().toLocaleTimeString('it-IT');
    console.log(`[${ts}] ${message.replace(/<[^>]*>?/gm, '')}`);
    activityLog.unshift(`[${ts}] ${message}`);
    if (activityLog.length > 5) activityLog.pop();
    if (telegramBot && CONFIG.tgChatId) {
        telegramBot.sendMessage(CONFIG.tgChatId, message, { 
            parse_mode: 'HTML', 
            disable_web_page_preview: true, 
            disable_notification: silent // TRUE = Il messaggio arriva in silenzio
        }).catch(()=>{});
    }
}

async function getDbStats() {
    const keys = await redis.keys('user:*');
    let synced = 0;
    for (const key of keys) {
        const lastSync = await redis.hget(key, 'lastSync');
        if (lastSync !== "0") synced++;
    }
    return { total: keys.length, synced: synced };
}

async function syncUser(user) {
    const userAddr = user.toLowerCase();
    try {
        const data = await pManager.execute(async (p) => await p.poolContract.getUserAccountData(userAddr));
        if (!data || data.debt === 0n) {
            await redis.del(`user:${userAddr}`);
            return false;
        }
        await redis.hset(`user:${userAddr}`, {
            col: ethers.formatUnits(data.col, 8),
            debt: ethers.formatUnits(data.debt, 8),
            thr: (Number(data.thr) / 10000).toString(),
            lastSync: Date.now().toString(),
            // Resettiamo l'ultimo alert HF se l'utente ha cambiato posizione
            lastAlertHF: "0" 
        });
        return true;
    } catch (e) { return false; }
}

async function runDiscovery() {
    try {
        const stats = await getDbStats();
        if (stats.total < 1000) {
            const limit = 1000;
            logAndNotify(`🕸️ <b>Discovery:</b> Recupero ${limit} target...`, true); // Silenzioso
            const query = JSON.stringify({
                query: `{ positions(first: ${limit}, where: {side: BORROWER, balance_gt: 0, asset_: {symbol: "${CONFIG.debtSymbol}"}}, orderBy: balance, orderDirection: desc) { account { id } } }`
            });
            const res = await fetch(CONFIG.subgraph, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CONFIG.theGraphAPiKey}` },
                body: query
            });
            const json = await res.json();
            const positions = json.data.positions;
            let added = 0;
            for (let p of positions) {
                const addr = p.account.id.toLowerCase();
                const exists = await redis.exists(`user:${addr}`);
                if (!exists) {
                    await redis.hset(`user:${addr}`, { col: "0", debt: "0", thr: "0", lastSync: "0", lastAlertHF: "0" });
                    added++;
                }
            }
            logAndNotify(`✅ Discovery: ${added} target messi in coda.`, true); // Silenzioso
        }
    } catch (e) { console.error("Discovery error:", e.message); }
}

async function runSimulation(botContract) {
    if (!isBotEnabled || currentEthPrice <= 0) return;
    const keys = await redis.keys('user:*');
    for (const key of keys) {
        const state = await redis.hgetall(key);
        const user = key.replace('user:', '');
        const debt = parseFloat(state.debt);
        if (debt === 0) continue;

        const simHF = (parseFloat(state.col) * parseFloat(state.thr)) / debt;

        if (state.lastSync === "0" || (simHF < 1.10 && (Date.now() - parseInt(state.lastSync) > 120000))) {
            await syncUser(user);
        }

        if (simHF < 1.02) {
            if (await redis.exists(`blacklist:${user}`)) continue;
            
            // --- LOGICA ANTI-SPAM ALERT ---
            const currentHFFormatted = simHF.toFixed(4);
            if (state.lastAlertHF !== currentHFFormatted) {
                console.log(`⚠️ <b>ALERT:</b> Target vulnerabile!\nUser: <code>${user}</code>\nHF: ${currentHFFormatted}`); // Silenzioso
                await redis.hset(key, "lastAlertHF", currentHFFormatted);
            }

            try {
                const data = await pManager.execute(async (p) => await p.poolContract.getUserAccountData(user));
                const realHF = parseFloat(ethers.formatUnits(data.hf, 18));

                if (realHF < 1.0) {
                    await redis.set(`blacklist:${user}`, "1", "EX", 43200); 

                    const tx = await botContract.requestFlashLoan(CONFIG.debtAsset, ethers.parseUnits("1000", CONFIG.debtDecimals), CONFIG.collateralAsset, user, { gasLimit: 1100000 });
                    
                    // NOTIFICA SONORA (Sparo)
                    logAndNotify(`🔫 <b>COLPO LANCIATO!</b>\nTarget: <code>${user}</code>\nHF Reale: ${realHF.toFixed(4)}\n<a href="https://arbiscan.io/tx/${tx.hash}">Vedi su Arbiscan</a>`, false);

                    tx.wait().then(receipt => {
                        if (receipt.status === 1) {
                            logAndNotify(`💰 <b>VITTORIA!</b> Liquidazione confermata.`, false);
                        } else {
                            logAndNotify(`❌ <b>REVERT:</b> Battuto sul tempo.`, false);
                        }
                    }).catch(() => {});
                }
            } catch (e) {
                await redis.set(`blacklist:${user}`, "1", "EX", 3600);
            }
        }
    }
}

async function main() {
    console.log(`🦅 [OMNI-BOT 7.1] Sistemi in avvio...`);
    await runDiscovery();

    const eventProvider = new ethers.JsonRpcProvider("https://arb1.arbitrum.io/rpc", CONFIG.chainId, { staticNetwork: true });
    const botWallet = new ethers.Wallet(process.env.PRIVATE_KEY, eventProvider);
    const botContract = await ethers.getContractAt("AaveLiquidator", CONFIG.botAddress, botWallet);

    if (CONFIG.tgToken && CONFIG.tgChatId) {
        telegramBot = new TelegramBot(CONFIG.tgToken, { polling: { autoStart: true, params: { drop_pending_updates: true } } });
        telegramBot.onText(/\/status/, async () => {
            const stats = await getDbStats();
            const perc = ((stats.synced / stats.total) * 100).toFixed(1);
            telegramBot.sendMessage(CONFIG.tgChatId, `✅ <b>Bot Online</b>\n🎯 Target: ${stats.synced}/${stats.total} (${perc}%)\n💰 ETH: ${currentEthPrice.toFixed(2)}$\n📦 Blocco: ${lastBlockProcessed}`, {parse_mode: 'HTML'});
        });
        telegramBot.onText(/\/activity/, () => {
            telegramBot.sendMessage(CONFIG.tgChatId, `📋 <b>ATTIVITÀ</b>\n\n${activityLog.join('\n\n')}`, {parse_mode: 'HTML'});
        });
        telegramBot.onText(/\/stop/, () => { isBotEnabled = false; logAndNotify("🛑 Bot sospeso.", true); });
        telegramBot.onText(/\/start/, () => { isBotEnabled = true; logAndNotify("🚀 Bot riattivato.", true); });
    }

    // Monitoraggio Prezzo
    setInterval(async () => {
        try {
            const priceData = await pManager.execute(async (p) => {
                const oracle = new ethers.Contract(CONFIG.oracle, ["function getAssetPrice(address) view returns (uint256)"], p.inst);
                return await oracle.getAssetPrice(CONFIG.collateralAsset);
            });
            currentEthPrice = Number(ethers.formatUnits(priceData, 8));
            if (currentEthPrice > 0) runSimulation(botContract);
        } catch (e) {
            isSyncPaused = true;
            setTimeout(() => { isSyncPaused = false; }, 30000);
        }
    }, 10000);

    // Sync Engine
    setInterval(async () => {
        if (isSyncPaused || !isBotEnabled) return;
        const keys = await redis.keys('user:*');
        let processed = 0;
        for (let key of keys) {
            if (processed >= 5) break;
            const lastSync = await redis.hget(key, 'lastSync');
            if (lastSync === "0") {
                await syncUser(key.replace('user:', ''));
                processed++;
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }, 15000);

    setInterval(runDiscovery, 3600000); 
    eventProvider.on("block", (bn) => { lastBlockProcessed = bn; });
    logAndNotify("🚀 <b>Bot Online.</b> Monitoraggio attivo.", true); // Messaggio avvio silenzioso
}

main().catch(console.error);