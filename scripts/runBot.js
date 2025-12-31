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
    debtAsset: process.env.DEBT_ASSET_ADDRESS,
    debtSymbol: process.env.DEBT_ASSET_SYMBOL || "USDC",
    debtDecimals: parseInt(process.env.DEBT_ASSET_DECIMALS || "6"),
    collateralAsset: process.env.COLLATERAL_ASSET_ADDRESS,
    chainId: parseInt(process.env.CHAIN_ID || "42161"),
    redisUrl: process.env.REDIS_URL,
    tgToken: process.env.TELEGRAM_BOT_TOKEN,
    tgChatId: process.env.TELEGRAM_CHAT_ID
};

const redis = new Redis(CONFIG.redisUrl);
let currentEthPrice = 0;
let lastBlockProcessed = 0;
let telegramBot = null;
let activityLog = []; // Ripristinato lo storico

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

// --- NOTIFICHE E LOG ---
function logAndNotify(message) {
    const timestamp = new Date().toLocaleTimeString('it-IT');
    console.log(`[${timestamp}] ${message.replace(/<[^>]*>?/gm, '')}`);
    activityLog.unshift(`[${timestamp}] ${message}`);
    if (activityLog.length > 5) activityLog.pop();
    if (telegramBot && CONFIG.tgChatId) {
        telegramBot.sendMessage(CONFIG.tgChatId, message, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(()=>{});
    }
}

// --- LOGICA CORE ---
async function syncUser(user) {
    try {
        const data = await pManager.execute(async (prov) => {
            const pool = new ethers.Contract(CONFIG.aavePool, ["function getUserAccountData(address) view returns (uint256 col, uint256 debt, uint256, uint256 thr, uint256, uint256 hf)"], prov);
            return await pool.getUserAccountData(user);
        });
        if (data.debt === 0n) return;
        await redis.hset(`user:${user.toLowerCase()}`, {
            collateralBase: ethers.formatUnits(data.col, 8),
            debtBase: ethers.formatUnits(data.debt, 8),
            threshold: (Number(data.thr) / 10000).toString(),
            lastSync: Date.now().toString()
        });
    } catch (e) {}
}

async function runDiscovery() {
    const keys = await redis.keys('user:*');
    if (keys.length < 500) {
        const needed = 2000 - keys.length;
        logAndNotify(`🕸️ <b>Discovery:</b> Recupero ${needed} nuovi utenti...`);
        const query = `{ users(first: ${needed}, where: {borrows_: {reserve_: {symbol: "${CONFIG.debtSymbol}"}}}) { id } }`;
        try {
            const res = await fetch(CONFIG.subgraph, { method: "POST", body: JSON.stringify({ query }) });
            const json = await res.json();
            for (let u of json.data.users) await syncUser(u.id);
            logAndNotify(`✅ Database ricaricato a ${await redis.keys('user:*').then(k => k.length)} utenti.`);
        } catch (e) { console.error("Discovery Fallita."); }
    }
}

async function runSimulation(botContract) {
    if (currentEthPrice === 0) return;
    const stream = redis.scanStream({ match: 'user:*', count: 100 });
    stream.on('data', async (keys) => {
        for (const key of keys) {
            const state = await redis.hgetall(key);
            const user = key.replace('user:', '');
            const simulatedHF = (parseFloat(state.collateralBase) * parseFloat(state.threshold)) / parseFloat(state.debtBase);

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
                        const tx = await botContract.requestFlashLoan(CONFIG.debtAsset, ethers.parseUnits("1000", CONFIG.debtDecimals), CONFIG.collateralAsset, user, { gasLimit: 1000000 });
                        logAndNotify(`🔫 <b>COLPO!</b> User: ${user}\n<a href="https://arbiscan.io/tx/${tx.hash}">Dettagli</a>`);
                    }
                } catch (e) {}
            }
        }
    });
}

async function main() {
    console.log(`🦅 [OMNI-BOT] Avvio Chain: ${CONFIG.chainId}`);
    await runDiscovery();

    const eventProvider = new ethers.JsonRpcProvider(rpcUrls[0], CONFIG.chainId, { staticNetwork: true });
    const botContract = await ethers.getContractAt("AaveLiquidator", CONFIG.botAddress, new ethers.Wallet(process.env.PRIVATE_KEY, eventProvider));

    if (CONFIG.tgToken) {
        telegramBot = new TelegramBot(CONFIG.tgToken, { polling: true });
        telegramBot.onText(/\/status/, async () => {
            const count = (await redis.keys('user:*')).length;
            telegramBot.sendMessage(CONFIG.tgChatId, `✅ <b>Bot Online</b>\n🎯 Target: ${count}\n💰 ETH: ${currentEthPrice}$\n📦 Blocco: ${lastBlockProcessed}`, {parse_mode: 'HTML'});
        });
        telegramBot.onText(/\/activity/, () => {
            telegramBot.sendMessage(CONFIG.tgChatId, `📋 <b>ATTIVITÀ</b>\n\n${activityLog.join('\n\n')}`, {parse_mode: 'HTML'});
        });
    }

    logAndNotify("🚀 <b>Sistemi Operativi.</b>");

    // Monitoraggio Prezzo
    setInterval(async () => {
        try {
            const priceData = await pManager.execute(async (prov) => {
                const oracle = new ethers.Contract(CONFIG.oracle, ["function getAssetPrice(address) view returns (uint256)"], prov);
                return await oracle.getAssetPrice(CONFIG.collateralAsset);
            });
            currentEthPrice = Number(ethers.formatUnits(priceData, 8));
            runSimulation(botContract);
        } catch (e) {}
    }, 5000);

    // Re-Sync Periodico
    setInterval(runDiscovery, 10 * 60 * 1000);
    setInterval(async () => {
        const keys = await redis.keys('user:*');
        for (let i = 0; i < 15; i++) {
            const key = keys[Math.floor(Math.random() * keys.length)];
            if (key) await syncUser(key.replace('user:', ''));
        }
    }, 60000);

    eventProvider.on("block", (bn) => { 
        lastBlockProcessed = bn; 
        if (bn % 20 === 0) console.log(`💓 Heartbeat: Blocco ${bn} | ETH: ${currentEthPrice}$`);
    });
}

main().catch(console.error);