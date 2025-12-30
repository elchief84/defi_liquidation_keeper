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

// --- MULTI-PROVIDER ---
const rpcUrls = [
    process.env.RPC_1,
    process.env.RPC_2,
    process.env.RPC_3,
    "https://arb1.arbitrum.io/rpc",
    "https://arbitrum.llamarpc.com"
].filter(url => url);

class SmartProviderManager {
    constructor(urls) {
        this.providers = urls.map(url => new ethers.JsonRpcProvider(url, 42161, { staticNetwork: true }));
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
                if (i < this.providers.length - 1) continue;
                throw err;
            }
        }
    }
}
const pManager = new SmartProviderManager(rpcUrls);

function logAndNotify(message) {
    const timestamp = new Date().toLocaleTimeString('it-IT');
    activityLog.unshift(`[${timestamp}] ${message}`);
    if (activityLog.length > 3) activityLog.pop();
    if (telegramBot && chatId) {
        telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch(() => {});
    }
}

// --- PROTEZIONE GLOBALE (Evita il crash del processo) ---
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Errore RPC catturato (Rejection):', reason.message || reason);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️ Errore critico catturato (Exception):', err.message);
});

async function main() {
    console.log("🦅 AVVIO BOT LIQUIDATORE...");

    // 1. Telegram con ritardo all'avvio (Evita errore 409)
    await new Promise(r => setTimeout(r, 5000)); 
    if (process.env.TELEGRAM_BOT_TOKEN && chatId) {
        telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { 
            polling: { autoStart: true, params: { drop_pending_updates: true } } 
        });
        
        telegramBot.onText(/\/status/, () => {
            telegramBot.sendMessage(chatId, `✅ <b>Bot Online</b>\n🎯 Targets: ${targets.size}\n📦 Blocco: ${lastBlockProcessed}`, {parse_mode: 'HTML'});
        });
        
        telegramBot.onText(/\/activity/, () => {
            let reply = "📋 <b>ATTIVITÀ</b>\n\n" + activityLog.join("\n\n");
            telegramBot.sendMessage(chatId, reply, {parse_mode: 'HTML'});
        });
    }

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    try { if (fs.existsSync(DB_FILE)) JSON.parse(fs.readFileSync(DB_FILE)).forEach(t => targets.add(t)); } catch(e){}

    // 2. Setup Wallet e Contratto (usando un provider che funziona)
    const activeProvider = this.providers ? this.providers[3] : pManager.providers[3]; // Fallback sul pubblico per iniziare
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, activeProvider);
    const botContract = await ethers.getContractAt("AaveLiquidator", MY_BOT_ADDRESS, wallet);

    logAndNotify("🚀 <b>Bot Avviato!</b>");

    // 3. HEARTBEAT RESILIENTE (Non crasha se l'RPC fallisce)
    const runScan = async (blockNumber) => {
        try {
            lastBlockProcessed = blockNumber;
            const arr = Array.from(targets);
            if (arr.length === 0) return;

            const BATCH = 10;
            const start = (blockNumber * BATCH) % arr.length;
            const batch = arr.slice(start, start + BATCH);

            for (const user of batch) {
                const now = Date.now();
                const cached = userCache.get(user);
                let waitTime = 20 * 60 * 1000;
                if (cached && cached.hf < 1.1) waitTime = 0;

                if (!cached || (now - cached.lastCheck) > waitTime) {
                    checkUser(user, botContract).catch(()=>{});
                }
            }
        } catch (e) { console.error("Errore nel loop blocchi:", e.message); }
    };

    // Ascolta i blocchi su TUTTI i provider a rotazione per non sovraccaricare il pubblico
    pManager.providers.forEach(p => {
        p.on("block", runScan);
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
            logAndNotify(`🚨 <b>TARGET VULNERABILE:</b> ${user}`);
            botContract.requestFlashLoan(USDC, ethers.parseUnits("1500", 6), WETH, user).catch(()=>{});
        }
    } catch (e) {}
}

main().catch(console.error);