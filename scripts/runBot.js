const { ethers } = require("hardhat");
const Redis = require("ioredis");
const TelegramBot = require('node-telegram-bot-api');
require("dotenv").config();

// --- PARAMETRI DA .ENV ---
const CONFIG = {
    botAddress: process.env.MY_BOT_ADDRESS,
    aavePool: process.env.AAVE_POOL_ADDRESS,
    oracle: process.env.AAVE_ORACLE_ADDRESS,
    subgraph: "https://api.thegraph.com/subgraphs/name/messari/aave-v3-arbitrum",
    debtAsset: process.env.DEBT_ASSET_ADDRESS,
    debtSymbol: process.env.DEBT_ASSET_SYMBOL || "USDC",
    debtDecimals: parseInt(process.env.DEBT_ASSET_DECIMALS || "6"),
    collateralAsset: process.env.COLLATERAL_ASSET_ADDRESS,
    chainId: 42161,
    redisUrl: process.env.REDIS_URL,
    tgToken: process.env.TELEGRAM_BOT_TOKEN,
    tgChatId: process.env.TELEGRAM_CHAT_ID
};

const redis = new Redis(CONFIG.redisUrl, { maxRetriesPerRequest: null });
let currentEthPrice = 0;
let lastBlockProcessed = 0;
let telegramBot = null;
let activityLog = [];

// --- GESTORE RPC (DIFENSIVO) ---
const rpcUrls = [
    process.env.RPC_2, 
    process.env.RPC_3, 
    "https://arb1.arbitrum.io/rpc", 
    process.env.RPC_1
].filter(url => url);

class SmartProviderManager {
    constructor(urls) {
        this.providers = urls.map(url => new ethers.JsonRpcProvider(url, CONFIG.chainId, { staticNetwork: true }));
        this.index = 0;
    }
    async execute(task) {
        let lastErr;
        for (let i = 0; i < this.providers.length; i++) {
            try {
                const res = await task(this.providers[this.index]);
                this.index = (this.index + 1) % this.providers.length;
                return res;
            } catch (err) {
                lastErr = err;
                this.index = (this.index + 1) % this.providers.length;
                if (!err.message.includes("429")) break; // Se non è un limite di velocità, fermati
            }
        }
        throw lastErr;
    }
}
const pManager = new SmartProviderManager(rpcUrls);

// --- 1. SINCRONIZZAZIONE UTENTE ---
async function syncUser(user) {
    try {
        const data = await pManager.execute(async (prov) => {
            const pool = new ethers.Contract(CONFIG.aavePool, ["function getUserAccountData(address) view returns (uint256 col, uint256 debt, uint256, uint256 thr, uint256, uint256 hf)"], prov);
            return await pool.getUserAccountData(user);
        });
        if (data.debt === 0n) return;
        await redis.hset(`user:${user.toLowerCase()}`, {
            col: ethers.formatUnits(data.col, 8),
            debt: ethers.formatUnits(data.debt, 8),
            thr: (Number(data.thr) / 10000).toString()
        });
    } catch (e) {}
}

// --- 2. DISCOVERY (VERIFICATA) ---
async function runDiscovery() {
    try {
        const keys = await redis.keys('user:*');
        if (keys.length < 500) {
            const needed = 2000 - keys.length;
            console.log(`🕸️ Scansione Discovery per ${needed} utenti...`);
            
            // Query specifica per il subgraph di Messari
            const query = `{
                accounts(first: ${needed}, where: {borrowCount_gt: 0}) { id }
            }`;

            const res = await fetch(CONFIG.subgraph, {
                method: "POST",
                body: JSON.stringify({ query })
            });
            const json = await res.json();
            
            if (json.data && json.data.accounts) {
                for (let acc of json.data.accounts) {
                    await syncUser(acc.id);
                }
                console.log(`✅ Database Redis aggiornato a ${await redis.keys('user:*').then(k => k.length)} utenti.`);
            }
        }
    } catch (e) {
        console.log("⚠️ Errore Discovery (The Graph probabilmente limitato)");
    }
}

// --- 3. SIMULAZIONE MATEMATICA ---
async function runSimulation(botContract) {
    if (currentEthPrice <= 0) return;
    const keys = await redis.keys('user:*');
    
    for (const key of keys) {
        const state = await redis.hgetall(key);
        const user = key.replace('user:', '');
        
        // HF = (Collaterale * Soglia) / Debito
        const simulatedHF = (parseFloat(state.col) * parseFloat(state.thr)) / parseFloat(state.debt);

        if (simulatedHF < 1.02) {
            if (await redis.exists(`blacklist:${user}`)) continue;

            try {
                const data = await pManager.execute(async (prov) => {
                    const pool = new ethers.Contract(CONFIG.aavePool, ["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256 hf)"], prov);
                    return await pool.getUserAccountData(user);
                });
                const realHF = parseFloat(ethers.formatUnits(data.hf, 18));

                if (realHF < 1.0) {
                    await redis.set(`blacklist:${user}`, "1", "EX", 3600);
                    const tx = await botContract.requestFlashLoan(CONFIG.debtAsset, ethers.parseUnits("1200", CONFIG.debtDecimals), CONFIG.collateralAsset, user, { gasLimit: 1000000 });
                    notify(`🔫 <b>LIQUIDAZIONE!</b>\nUser: ${user}\n<a href="https://arbiscan.io/tx/${tx.hash}">Vedi Arbiscan</a>`);
                }
            } catch (e) {}
        }
    }
}

function notify(msg) {
    console.log(`[BOT] ${msg.replace(/<[^>]*>?/gm, '')}`);
    if (telegramBot && CONFIG.tgChatId) {
        telegramBot.sendMessage(CONFIG.tgChatId, msg, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(()=>{});
    }
}

async function main() {
    console.log("🦅 [OMNI-BOT 5.0] Sistemi in fase di avvio...");
    
    // Inizializzazione Telegram
    if (CONFIG.tgToken && CONFIG.tgChatId) {
        telegramBot = new TelegramBot(CONFIG.tgToken, { polling: { autoStart: true, params: { drop_pending_updates: true } } });
        telegramBot.onText(/\/status/, async () => {
            const count = (await redis.keys('user:*')).length;
            telegramBot.sendMessage(CONFIG.tgChatId, `✅ <b>Status</b>\n🎯 Target: ${count}\n💰 ETH: ${currentEthPrice}$\n📦 Blocco: ${lastBlockProcessed}`, {parse_mode: 'HTML'});
        });
    }

    await runDiscovery();

    const eventProvider = new ethers.JsonRpcProvider("https://arb1.arbitrum.io/rpc", 42161, { staticNetwork: true });
    const botContract = await ethers.getContractAt("AaveLiquidator", CONFIG.botAddress, new ethers.Wallet(process.env.PRIVATE_KEY, eventProvider));

    // A. Monitoraggio Prezzo ETH
    setInterval(async () => {
        try {
            const priceData = await pManager.execute(async (prov) => {
                const oracle = new ethers.Contract(CONFIG.oracle, ["function getAssetPrice(address) view returns (uint256)"], prov);
                return await oracle.getAssetPrice(CONFIG.collateralAsset);
            });
            currentEthPrice = Number(ethers.formatUnits(priceData, 8));
            if (currentEthPrice > 0) runSimulation(botContract);
        } catch (e) { console.log("⚠️ Errore lettura prezzo."); }
    }, 10000);

    // B. Re-Sync (15 utenti ogni minuto)
    setInterval(async () => {
        const keys = await redis.keys('user:*');
        const key = keys[Math.floor(Math.random() * keys.length)];
        if (key) await syncUser(key.replace('user:', ''));
    }, 60000);

    eventProvider.on("block", (bn) => { lastBlockProcessed = bn; });
    notify("🚀 <b>Bot Operativo.</b>");
}

main().catch(console.error);