const { ethers } = require("hardhat");
const Redis = require("ioredis");
const TelegramBot = require('node-telegram-bot-api');
require("dotenv").config();

// --- CONFIGURAZIONE ---
const CONFIG = {
    botAddress: process.env.MY_BOT_ADDRESS,
    aavePool: process.env.AAVE_POOL_ADDRESS,
    oracle: process.env.AAVE_ORACLE_ADDRESS,
    subgraph: process.env.THE_GRAPH_URL,
    theGraphAPiKey: process.env.THE_GRAPH_API_KEY,
    debtAsset: process.env.DEBT_ASSET_ADDRESS,
    debtSymbol: process.env.DEBT_ASSET_SYMBOL || "USDC",
    debtDecimals: parseInt(process.env.DEBT_ASSET_DECIMALS || "6"),
    collateralAsset: process.env.COLLATERAL_ASSET_ADDRESS,
    chainId: parseInt(process.env.CHAIN_ID || "42161"),
    redisUrl: process.env.REDIS_URL,
    tgToken: process.env.TELEGRAM_BOT_TOKEN,
    tgChatId: process.env.TELEGRAM_CHAT_ID
};

const redis = new Redis(CONFIG.redisUrl, { maxRetriesPerRequest: null });
let currentEthPrice = 0;
let lastBlockProcessed = 0;
let telegramBot = null;
let activityLog = [];
let lastHeartbeatTime = Date.now();

// --- GESTORE PROVIDER ---
const rpcUrls = [process.env.RPC_2, process.env.RPC_3, "https://arb1.arbitrum.io/rpc", process.env.RPC_1].filter(url => url);
class SmartProviderManager {
    constructor(urls) {
        this.providers = urls.map(url => new ethers.JsonRpcProvider(url, CONFIG.chainId, { staticNetwork: true }));
        this.index = 0;
    }
    async execute(task) {
        for (let i = 0; i < this.providers.length; i++) {
            try {
                const res = await task(this.providers[this.index]);
                this.index = (this.index + 1) % this.providers.length;
                return res;
            } catch (err) {
                this.index = (this.index + 1) % this.providers.length;
                if (i === this.providers.length - 1) throw err;
            }
        }
    }
}
const pManager = new SmartProviderManager(rpcUrls);

// --- NOTIFICHE TELEGRAM ---
function logAndNotify(message, silent = false) {
    const ts = new Date().toLocaleTimeString('it-IT');
    console.log(`[${ts}] ${message.replace(/<[^>]*>?/gm, '')}`);
    if (telegramBot && CONFIG.tgChatId) {
        telegramBot.sendMessage(CONFIG.tgChatId, message, { 
            parse_mode: 'HTML', 
            disable_web_page_preview: true,
            disable_notification: silent // Le notifiche di heartbeat sono silenziose (senza suono)
        }).catch(()=>{});
    }
}

// --- SINCRONIZZAZIONE ---
async function syncUser(user) {
    try {
        const data = await pManager.execute(async (prov) => {
            const pool = new ethers.Contract(CONFIG.aavePool, ["function getUserAccountData(address) view returns (uint256 col, uint256 debt, uint256, uint256 thr, uint256, uint256 hf)"], prov);
            return await pool.getUserAccountData(user);
        });
        const userAddr = user.toLowerCase();
        if (data.debt === 0n) {
            await redis.del(`user:${userAddr}`);
            return;
        }
        await redis.hset(`user:${userAddr}`, {
            col: ethers.formatUnits(data.col, 8),
            debt: ethers.formatUnits(data.debt, 8),
            thr: (Number(data.thr) / 10000).toString(),
            lastSync: Date.now().toString()
        });
    } catch (e) {}
}

// --- DISCOVERY ---
async function runDiscovery() {
    try {
        const keys = await redis.keys('user:*');
        if (keys.length < 500) {
            const limit = 1000;
            logAndNotify(`🕸️ <b>Discovery:</b> DB basso (${keys.length}). Scarico ${limit} utenti...`);
            
            const query = JSON.stringify({
                query: `{
                  positions(
                    first: ${limit}, 
                    where: {side: BORROWER, balance_gt: 0, asset_: {symbol: "${CONFIG.debtSymbol}"}},
                    orderBy: balance, orderDirection: desc
                  ) { account { id } }
                }`
            });

            const res = await fetch(CONFIG.subgraph, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CONFIG.theGraphAPiKey}` },
                body: query
            });

            const json = await res.json();
            if (json.errors) throw new Error(json.errors[0].message);

            const positions = json.data.positions;
            let newCount = 0;

            for (let i = 0; i < positions.length; i++) {
                const userAddr = positions[i].account.id.toLowerCase();
                const exists = await redis.exists(`user:${userAddr}`);
                if (!exists) {
                    await syncUser(userAddr);
                    newCount++;
                }

                // Messaggio Telegram ogni 200 utenti per non lasciarti nel dubbio
                if ((i + 1) % 200 === 0) {
                    logAndNotify(`⏳ Discovery in corso: ${i + 1}/${positions.length}...`, true);
                }
            }
            logAndNotify(`✅ <b>Discovery completata!</b>\nTarget nel database: ${await redis.keys('user:*').then(k => k.length)}`);
        }
    } catch (e) {
        logAndNotify(`⚠️ Discovery fallita: ${e.message.substring(0, 50)}`);
    }
}

// --- SIMULAZIONE ---
async function runSimulation(botContract) {
    if (currentEthPrice <= 0) return;
    const keys = await redis.keys('user:*');
    for (const key of keys) {
        const state = await redis.hgetall(key);
        const user = key.replace('user:', '');
        const simHF = (parseFloat(state.col) * parseFloat(state.thr)) / parseFloat(state.debt);

        if (simHF < 1.10) {
            if (Date.now() - parseInt(state.lastSync) > 300000) {
                await syncUser(user);
            }
        }

        if (simHF < 1.02) {
            if (await redis.exists(`blacklist:${user}`)) continue;
            try {
                const data = await pManager.execute(async (prov) => {
                    const pool = new ethers.Contract(CONFIG.aavePool, ["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256 hf)"], prov);
                    return await pool.getUserAccountData(user);
                });
                const realHF = parseFloat(ethers.formatUnits(data.hf, 18));
                if (realHF < 1.0) {
                    await redis.set(`blacklist:${user}`, "1", "EX", 43200);
                    const tx = await botContract.requestFlashLoan(CONFIG.debtAsset, ethers.parseUnits("1200", CONFIG.debtDecimals), CONFIG.collateralAsset, user, { gasLimit: 1100000 });
                    logAndNotify(`🔫 <b>LIQUIDAZIONE!</b>\nUser: ${user}\n<a href="https://arbiscan.io/tx/${tx.hash}">Vedi Arbiscan</a>`);
                }
            } catch (e) {
                await redis.set(`blacklist:${user}`, "1", "EX", 3600);
            }
        }
    }
}

async function main() {
    console.log("🦅 [OMNI-BOT 6.3] Sistemi avviati.");
    
    // Inizializzazione Telegram
    if (CONFIG.tgToken) {
        telegramBot = new TelegramBot(CONFIG.tgToken, { polling: { autoStart: true, params: { drop_pending_updates: true } } });
        telegramBot.onText(/\/status/, async () => {
            const count = (await redis.keys('user:*')).length;
            telegramBot.sendMessage(CONFIG.tgChatId, `✅ <b>Bot Online</b>\n🎯 Target: ${count}\n💰 ETH: ${currentEthPrice.toFixed(2)}$\n📦 Blocco: ${lastBlockProcessed}`, {parse_mode: 'HTML'});
        });
    }

    await runDiscovery();

    const eventProvider = new ethers.JsonRpcProvider("https://arb1.arbitrum.io/rpc", CONFIG.chainId, { staticNetwork: true });
    const botContract = await ethers.getContractAt("AaveLiquidator", CONFIG.botAddress, new ethers.Wallet(process.env.PRIVATE_KEY, eventProvider));

    // A. MONITORAGGIO PREZZO (Trigger Simulazione)
    setInterval(async () => {
        try {
            const priceData = await pManager.execute(async (prov) => {
                const oracle = new ethers.Contract(CONFIG.oracle, ["function getAssetPrice(address) view returns (uint256)"], prov);
                return await oracle.getAssetPrice(CONFIG.collateralAsset);
            });
            currentEthPrice = Number(ethers.formatUnits(priceData, 8));
            if (currentEthPrice > 0) runSimulation(botContract);
        } catch (e) {}
    }, 10000);

    // B. HEARTBEAT OGNI 60 SECONDI
    setInterval(async () => {
        const count = (await redis.keys('user:*')).length;
        logAndNotify(`💓 <b>Heartbeat</b>\nETH: ${currentEthPrice.toFixed(2)}$ | DB: ${count} | Block: ${lastBlockProcessed}`, true);
    }, 60000);

    // C. DISCOVERY AUTO-REFILL (Ogni 12 ore)
    setInterval(runDiscovery, 12 * 3600000);

    eventProvider.on("block", (bn) => { lastBlockProcessed = bn; });
    logAndNotify("🚀 <b>Bot Online.</b>\nMonitoraggio volatilità attivo.");
}

main().catch(console.error);