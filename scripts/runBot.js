const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');
require("dotenv").config();

// --- CONFIGURAZIONE ---
const MY_BOT_ADDRESS = "0x647Aa5C5321bD53E9B43CFB95213541d2945A684";
const DATA_DIR = path.join(__dirname, "../data");
const DB_FILE = path.join(DATA_DIR, "targets.json");
const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

// --- STATO ---
let targets = new Set();
const userCache = new Map();
let lastBlockProcessed = 0;
let activityLog = [];
let telegramBot = null;
const chatId = process.env.TELEGRAM_CHAT_ID;
let isPaused = false; // Per gestire il cooldown da 429

// --- MULTI-PROVIDER ---
const rpcUrls = [
    process.env.RPC_2, // QuickNode (Speriamo sia attivo)
    process.env.RPC_3, // Ankr/DRPC
    "https://arbitrum.llamarpc.com", // Llama (Alternativa al pubblico standard)
    "https://arb1.arbitrum.io/rpc",
    process.env.RPC_1  // Alchemy (Messo per ultimo se esaurito)
].filter(url => url);

class SmartProviderManager {
    constructor(urls) {
        this.providers = urls.map(url => new ethers.JsonRpcProvider(url, 42161, { staticNetwork: true }));
        this.index = 0;
    }
    async execute(task) {
        if (isPaused) throw new Error("Bot in pausa per rate limit");
        for (let i = 0; i < this.providers.length; i++) {
            try {
                const res = await task(this.providers[this.index]);
                this.index = (this.index + 1) % this.providers.length;
                return res;
            } catch (err) {
                this.index = (this.index + 1) % this.providers.length;
                if (err.message.includes("429")) {
                    console.log("⚠️ Nodo limitato, salto...");
                    continue;
                }
                if (i === this.providers.length - 1) throw err;
            }
        }
    }
}
const pManager = new SmartProviderManager(rpcUrls);

function logAndNotify(message) {
    const timestamp = new Date().toLocaleTimeString('it-IT');
    activityLog.unshift(`[${timestamp}] ${message}`);
    if (activityLog.length > 5) activityLog.pop();
    if (telegramBot && chatId) {
        telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch(()=>{});
    }
}

// Protezione globale
process.on('unhandledRejection', (e) => {
    if (e.message?.includes("429")) {
        if (!isPaused) {
            console.log("🛑 Rate limit colpito. Pausa di 30 secondi...");
            isPaused = true;
            setTimeout(() => { isPaused = false; }, 30000);
        }
    }
});

async function main() {
    console.log("🦅 AVVIO BOT LIQUIDATORE (RESILIENT MODE)...");

    // Inizializzazione Telegram
    if (process.env.TELEGRAM_BOT_TOKEN && chatId) {
        telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { 
            polling: { autoStart: true, params: { drop_pending_updates: true } } 
        });
        telegramBot.onText(/\/status/, () => {
            telegramBot.sendMessage(chatId, `✅ <b>Bot Online</b>\n🎯 Targets: ${targets.size}\n📦 Blocco: ${lastBlockProcessed}\n⏸ Pausa: ${isPaused}`, {parse_mode: 'HTML'});
        });
    }

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
        try { JSON.parse(fs.readFileSync(DB_FILE)).forEach(t => targets.add(t.toLowerCase())); } catch(e){}
    }

    // Cerchiamo un provider per il listener blocchi che non sia quello pubblico intasato
    const listenerProvider = pManager.providers[0]; 
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, listenerProvider);
    const botContract = await ethers.getContractAt("AaveLiquidator", MY_BOT_ADDRESS, wallet);

    logAndNotify("🚀 <b>Bot Online</b>\nScansione ottimizzata avviata.");

    // Loop sui blocchi
    listenerProvider.on("block", async (blockNumber) => {
        // --- OTTIMIZZAZIONE RITMO ---
        // Scansioniamo solo 1 blocco ogni 4 (circa ogni 1-2 secondi)
        // Questo riduce drasticamente il carico sugli RPC
        if (blockNumber % 4 !== 0 || isPaused) return;

        lastBlockProcessed = blockNumber;
        const arr = Array.from(targets);
        const BATCH = 10;
        const start = (blockNumber * BATCH) % arr.length;
        const batch = arr.slice(start, start + BATCH);

        console.log(`📦 Blocco ${blockNumber} | Controllo batch...`);

        for (const user of batch) {
            const now = Date.now();
            const cached = userCache.get(user);
            let waitTime = 60 * 60 * 1000; // 1 ora per sicuri
            if (cached) {
                if (cached.hf < 1.1) waitTime = 0;
                else if (cached.hf < 1.5) waitTime = 5 * 60 * 1000;
            }

            if (!cached || (now - cached.lastCheck) > waitTime) {
                checkUser(user, botContract).catch(()=>{});
            }
        }
    });

    setInterval(() => {
        if (targets.size > 0) fs.writeFileSync(DB_FILE, JSON.stringify(Array.from(targets)));
    }, 300000);
}

async function checkUser(user, botContract) {
    try {
        const data = await pManager.execute(async (prov) => {
            const pool = new ethers.Contract(AAVE_POOL, ["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256 hf)"], prov);
            return await pool.getUserAccountData(user);
        });

        const hf = parseFloat(ethers.formatUnits(data.hf, 18));
        userCache.set(user, { hf, lastCheck: Date.now() });

        if (hf < 1.0 && data.hf > 0n) {
            logAndNotify(`🚨 <b>TARGET VULNERABILE:</b> ${user}\nHF: ${hf.toFixed(4)}`);
            // Sparo con gas fisso per non simulare (risparmia RPC)
            botContract.requestFlashLoan(USDC, ethers.parseUnits("1500", 6), WETH, user, { gasLimit: 800000 }).catch(()=>{});
        }
    } catch (e) {}
}

main().catch(console.error);