const { ethers } = require("hardhat");
const Redis = require("ioredis");
const TelegramBot = require('node-telegram-bot-api');
require("dotenv").config();

// --- CONFIGURAZIONE PARAMETRIZZATA ---
const CONFIG = {
    botAddress: process.env.MY_BOT_ADDRESS,
    aavePool: process.env.AAVE_POOL_ADDRESS,
    oracle: process.env.AAVE_ORACLE_ADDRESS,
    subgraph: "https://gateway.thegraph.com/api/6b738150c4a938c5f590d65b32e015d3/subgraphs/id/4xyasj—RpuNPf",
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

// --- GESTORE PROVIDER (Multi-RPC) ---
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

// --- NOTIFICHE ---
function logAndNotify(message) {
    const ts = new Date().toLocaleTimeString('it-IT');
    console.log(`[${ts}] ${message.replace(/<[^>]*>?/gm, '')}`);
    activityLog.unshift(`[${ts}] ${message}`);
    if (activityLog.length > 5) activityLog.pop();
    if (telegramBot && CONFIG.tgChatId) {
        telegramBot.sendMessage(CONFIG.tgChatId, message, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(()=>{});
    }
}

// --- 1. SINCRONIZZAZIONE (RPC REAL-TIME) ---
async function syncUser(user) {
    try {
        const data = await pManager.execute(async (prov) => {
            const pool = new ethers.Contract(CONFIG.aavePool, ["function getUserAccountData(address) view returns (uint256 col, uint256 debt, uint256, uint256 thr, uint256, uint256 hf)"], prov);
            return await pool.getUserAccountData(user);
        });
        if (data.debt === 0n) {
            await redis.del(`user:${user.toLowerCase()}`); // Rimuovi chi ha chiuso il debito
            return;
        }
        await redis.hset(`user:${user.toLowerCase()}`, {
            col: ethers.formatUnits(data.col, 8),
            debt: ethers.formatUnits(data.debt, 8),
            thr: (Number(data.thr) / 10000).toString(),
            lastSync: Date.now().toString()
        });
    } catch (e) {}
}

// --- 2. DISCOVERY INTELLIGENTE (AUTO-REFILL) ---
async function runDiscovery() {
    const keys = await redis.keys('user:*');
    if (keys.length < 500) {
        const needed = 2000 - keys.length;
        logAndNotify(`🕸️ [DISCOVERY] DB a quota ${keys.length}. Caricamento di ${needed} nuovi target ${CONFIG.debtSymbol}...`);
        
        const query = `{
            users(first: ${needed}, where: {borrowedReservesCount_gt: 0, borrows_: {reserve_: {symbol: "${CONFIG.debtSymbol}"}}}) { id }
        }`;

        try {
            const res = await fetch(CONFIG.subgraph, { method: "POST", body: JSON.stringify({ query }) });
            const json = await res.json();
            if (!json.data) return;
            for (let u of json.data.users) await syncUser(u.id);
            logAndNotify(`✅ Database ricaricato a ${await redis.keys('user:*').then(k => k.length)} utenti.`);
        } catch (e) { console.error("Discovery Error"); }
    }
}

// --- 3. SIMULAZIONE E SPARO ---
async function runSimulation(botContract) {
    if (currentEthPrice <= 0) return;
    const keys = await redis.keys('user:*');
    
    for (const key of keys) {
        const state = await redis.hgetall(key);
        const user = key.replace('user:', '');
        
        // Calcolo HF Simulato localmente (veloce)
        const simHF = (parseFloat(state.col) * parseFloat(state.thr)) / parseFloat(state.debt);

        // REQUISITO: Sincronizza solo se si avvicina al rischio
        if (simHF < 1.10) {
            // Aggiorna i dati reali se sono passati più di 5 minuti dall'ultimo sync
            if (Date.now() - parseInt(state.lastSync) > 300000) {
                await syncUser(user);
            }
        }

        // REQUISITO: Se HF < 1.02 -> Verifica RPC e Spara
        if (simHF < 1.02) {
            const blacklisted = await redis.exists(`blacklist:${user}`);
            if (blacklisted) continue;

            try {
                const data = await pManager.execute(async (prov) => {
                    const pool = new ethers.Contract(CONFIG.aavePool, ["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256 hf)"], prov);
                    return await pool.getUserAccountData(user);
                });
                const realHF = parseFloat(ethers.formatUnits(data.hf, 18));

                if (realHF < 1.0) {
                    // BLACKLIST IMMEDIATA (per 12 ore)
                    await redis.set(`blacklist:${user}`, "1", "EX", 43200);
                    
                    const amount = ethers.parseUnits("1200", CONFIG.debtDecimals);
                    const tx = await botContract.requestFlashLoan(CONFIG.debtAsset, amount, CONFIG.collateralAsset, user, { gasLimit: 1000000 });
                    logAndNotify(`🔫 <b>COLPO LANCIATO!</b>\nUser: ${user}\n<a href="https://arbiscan.io/tx/${tx.hash}">Vedi su Arbiscan</a>`);
                }
            } catch (e) {
                // Se lo sparo fallisce per qualsiasi motivo (es. battuti sul tempo) -> Blacklist 1 ora
                await redis.set(`blacklist:${user}`, "1", "EX", 3600);
            }
        }
    }
}

async function main() {
    console.log(`🦅 [OMNI-BOT 6.0] Sistemi in avvio su Chain ${CONFIG.chainId}...`);
    
    await runDiscovery();

    // Provider per blocchi (Usa il paracadute pubblico per stabilità)
    const eventProvider = new ethers.JsonRpcProvider("https://arb1.arbitrum.io/rpc", CONFIG.chainId, { staticNetwork: true });
    const botContract = await ethers.getContractAt("AaveLiquidator", CONFIG.botAddress, new ethers.Wallet(process.env.PRIVATE_KEY, eventProvider));

    if (CONFIG.tgToken) {
        telegramBot = new TelegramBot(CONFIG.tgToken, { polling: { autoStart: true, params: { drop_pending_updates: true } } });
        telegramBot.onText(/\/status/, async () => {
            const count = (await redis.keys('user:*')).length;
            const bl = (await redis.keys('blacklist:*')).length;
            telegramBot.sendMessage(CONFIG.tgChatId, `✅ <b>Bot Online</b>\n🎯 Target: ${count}\n🚫 Blacklist: ${bl}\n💰 ETH: ${currentEthPrice}$\n📦 Blocco: ${lastBlockProcessed}`, {parse_mode: 'HTML'});
        });
    }

    // A. MONITORAGGIO PREZZO (Trigger Simulazione)
    setInterval(async () => {
        try {
            const priceData = await pManager.execute(async (prov) => {
                const oracle = new ethers.Contract(CONFIG.oracle, ["function getAssetPrice(address) view returns (uint256)"], prov);
                return await oracle.getAssetPrice(CONFIG.collateralAsset);
            });
            currentEthPrice = Number(ethers.formatUnits(priceData, 8));
            if (currentEthPrice > 0) runSimulation(botContract);
        } catch (e) { console.log("⚠️ Oracolo irraggiungibile."); }
    }, 5000);

    // B. DISCOVERY AUTO-REFILL (Ogni 30 minuti)
    setInterval(runDiscovery, 1800000);

    eventProvider.on("block", (bn) => { 
        lastBlockProcessed = bn; 
        if (bn % 40 === 0) console.log(`💓 Heartbeat: Blocco ${bn} | ETH: ${currentEthPrice}$ | Targets: ${usersStateSize || 'Redis'}`);
    });

    logAndNotify("🚀 <b>Bot Operativo.</b>\nPronto a calcolare e colpire.");
}

main().catch(console.error);