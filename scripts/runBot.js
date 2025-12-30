const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');
require("dotenv").config();

// --- CONFIGURAZIONE CORE ---
const MY_BOT_ADDRESS = "0x647Aa5C5321bD53E9B43CFB95213541d2945A684";
const DATA_DIR = path.join(__dirname, "../data");
const DB_FILE = path.join(DATA_DIR, "targets.json");
const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

// --- STATO DEL BOT ---
let isBotEnabled = true;     // IL NOSTRO KILL SWITCH
let targets = new Set();
const userCache = new Map(); 
const blacklist = new Map(); 
let activityLog = [];        
let lastBlockProcessed = 0;
let telegramBot = null;
const chatId = process.env.TELEGRAM_CHAT_ID;

// --- GESTORE PROVIDER ---
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
                if (err.message.toLowerCase().includes("429") || err.message.toLowerCase().includes("400")) continue;
                if (i === this.providers.length - 1) throw err;
            }
        }
    }
}
const pManager = new SmartProviderManager(rpcUrls);

// --- NOTIFICHE ---
function logAndNotify(message) {
    const timestamp = new Date().toLocaleTimeString('it-IT');
    console.log(`[${timestamp}] ${message.replace(/<[^>]*>?/gm, '')}`);
    activityLog.unshift(`[${timestamp}] ${message}`);
    if (activityLog.length > 5) activityLog.pop();
    if (telegramBot && chatId) {
        telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(()=>{});
    }
}

// --- PROTEZIONE CRASH ---
process.on('unhandledRejection', (reason) => console.error('⚠️ Errore RPC:', reason.message || reason));
process.on('uncaughtException', (err) => console.error('⚠️ Errore critico:', err.message));

async function main() {
    console.log("🦅 BOT LIQUIDATORE 2.0 CON KILL SWITCH");

    // 1. SETUP TELEGRAM
    if (process.env.TELEGRAM_BOT_TOKEN && chatId) {
        telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: { autoStart: true, params: { drop_pending_updates: true } } });

        // Sicurezza: risponde solo a te
        telegramBot.on('message', (msg) => {
            if (msg.chat.id.toString() !== chatId.toString()) return;
        });

        // COMANDO STOP
        telegramBot.onText(/\/stop/, () => {
            isBotEnabled = false;
            logAndNotify("🛑 <b>BOT FERMATO</b>. La scansione è stata sospesa.");
        });

        // COMANDO START
        telegramBot.onText(/\/start/, () => {
            isBotEnabled = true;
            logAndNotify("🚀 <b>BOT RIAVVIATO</b>. La scansione è ripresa.");
        });

        // COMANDO STATUS
        telegramBot.onText(/\/status/, () => {
            const status = isBotEnabled ? "🟢 ATTIVO" : "🔴 FERMO";
            telegramBot.sendMessage(chatId, `Stato: ${status}\n🎯 Targets: ${targets.size}\n📦 Blocco: ${lastBlockProcessed}`, { parse_mode: 'HTML' });
        });

        // COMANDO ACTIVITY
        telegramBot.onText(/\/activity/, () => {
            let reply = "📋 <b>ATTIVITÀ</b>\n\n" + activityLog.join("\n\n");
            telegramBot.sendMessage(chatId, reply, { parse_mode: 'HTML' });
        });
    }

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
        try { JSON.parse(fs.readFileSync(DB_FILE)).forEach(t => targets.add(t.toLowerCase())); } catch(e){}
    }

    const eventProvider = new ethers.JsonRpcProvider("https://arb1.arbitrum.io/rpc", 42161, { staticNetwork: true });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, eventProvider);
    const botContract = await ethers.getContractAt("AaveLiquidator", MY_BOT_ADDRESS, wallet);

    logAndNotify("🚀 <b>Bot Online</b>. Usa /stop per fermarlo in ogni momento.");

    // 2. LOOP SCANSIONE
    eventProvider.on("block", async (blockNumber) => {
        // KILL SWITCH: Se isBotEnabled è false, non fa nulla
        if (!isBotEnabled) return;
        
        if (blockNumber % 3 !== 0) return; // Respira
        lastBlockProcessed = blockNumber;

        const arr = Array.from(targets);
        if (arr.length === 0) return;

        const BATCH = 15;
        const start = (blockNumber * BATCH) % arr.length;
        const batch = arr.slice(start, start + BATCH);

        for (const user of batch) {
            checkUser(user, botContract).catch(()=>{});
        }
    });

    setInterval(() => {
        if (targets.size > 0) fs.writeFileSync(DB_FILE, JSON.stringify(Array.from(targets)));
    }, 300000);
}

async function checkUser(user, botContract) {
    const now = Date.now();
    if (blacklist.has(user)) {
        if (now - blacklist.get(user) < 12 * 60 * 60 * 1000) return;
        else blacklist.delete(user);
    }

    try {
        const data = await pManager.execute(async (prov) => {
            const pool = new ethers.Contract(AAVE_POOL, ["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256 hf)"], prov);
            return await pool.getUserAccountData(user);
        });

        const hf = parseFloat(ethers.formatUnits(data.hf, 18));
        userCache.set(user, { hf, lastCheck: now });

        if (hf < 1.0 && data.hf > 0n && isBotEnabled) {
            blacklist.set(user, now);
            logAndNotify(`🚨 <b>TARGET VULNERABILE!</b>\nUser: ${user}\nHF: ${hf.toFixed(4)}`);

            try {
                const feeData = await pManager.providers[0].getFeeData();
                const tx = await botContract.requestFlashLoan(USDC, ethers.parseUnits("1500", 6), WETH, user, {
                    gasLimit: 1100000,
                    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 5n, // Più aggressivo per vincere
                    maxFeePerGas: feeData.maxFeePerGas * 2n
                });
                
                logAndNotify(`🔫 <b>TX INVIATA!</b>\n<a href="https://arbiscan.io/tx/${tx.hash}">Vedi su Arbiscan</a>`);
            } catch (err) {
                console.log("Errore sparo silenzioso.");
            }
        }
    } catch (e) {}
}

main().catch(console.error);