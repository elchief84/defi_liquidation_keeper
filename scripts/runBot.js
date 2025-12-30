const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');
require("dotenv").config();

// --- CONFIG ---
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
let activityLog = []; // Storico ultime 3 attività
let telegramBot = null;
const chatId = process.env.TELEGRAM_CHAT_ID;

// --- PROVIDER MANAGER ---
const dataRpcUrls = [
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
                const result = await task(this.providers[this.index]);
                this.index = (this.index + 1) % this.providers.length;
                return result;
            } catch (err) {
                this.index = (this.index + 1) % this.providers.length;
                const msg = err.message.toLowerCase();
                if (msg.includes("429") || msg.includes("400") || msg.includes("not available")) continue;
                if (i === this.providers.length - 1) throw err;
            }
        }
    }
}

const dataManager = new SmartProviderManager(dataRpcUrls);

// --- FUNZIONE LOG E NOTIFICA ---
function logAndNotify(message) {
    const timestamp = new Date().toLocaleTimeString('it-IT');
    console.log(`[${timestamp}] ${message.replace(/<[^>]*>?/gm, '')}`);
    
    // Aggiorna lo storico attività (max 3)
    activityLog.unshift(`[${timestamp}] ${message}`);
    if (activityLog.length > 3) activityLog.pop();

    // Invia a Telegram
    if (telegramBot && chatId) {
        telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(()=>{});
    }
}

async function main() {
    console.log("🦅 AVVIO BOT LIQUIDATORE...");

    // 1. Inizializzazione Telegram
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (token && chatId) {
        telegramBot = new TelegramBot(token, { polling: { autoStart: true, params: { drop_pending_updates: true } } });

        // Comando /status
        telegramBot.onText(/\/status/, () => {
            const statusMsg = `✅ <b>Bot Operativo</b>\n🎯 Targets: ${targets.size}\n📦 Blocco: ${lastBlockProcessed}\n📡 Nodi: ${dataRpcUrls.length}`;
            telegramBot.sendMessage(chatId, statusMsg, { parse_mode: 'HTML' });
        });

        // Comando /activity
        telegramBot.onText(/\/activity/, () => {
            if (activityLog.length === 0) {
                telegramBot.sendMessage(chatId, "📭 Nessuna attività recente.");
                return;
            }
            let reply = "📋 <b>ULTIME 3 ATTIVITÀ</b>\n\n";
            activityLog.forEach((log, i) => reply += `${i+1}. ${log}\n\n`);
            telegramBot.sendMessage(chatId, reply, { parse_mode: 'HTML', disable_web_page_preview: true });
        });
    }

    // 2. Setup Files e Database
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
        try { JSON.parse(fs.readFileSync(DB_FILE)).forEach(t => targets.add(t)); } catch(e) {}
    }

    // 3. Connessione Blockchain (Usa nodo pubblico per eventi/blocchi)
    const eventProvider = new ethers.JsonRpcProvider("https://arb1.arbitrum.io/rpc", 42161, { staticNetwork: true });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, eventProvider);
    const botContract = await ethers.getContractAt("AaveLiquidator", MY_BOT_ADDRESS, wallet);

    // Messaggio di avvio
    logAndNotify("🚀 <b>Bot Avviato correttamente!</b>\nMonitoraggio Arbitrum attivo.");

    // 4. Listener Eventi Borrow
    const aave = new ethers.Contract(AAVE_POOL, ["event Borrow(address indexed, address indexed user, address, uint256, uint256, uint256, uint16)"], eventProvider);
    aave.on("Borrow", (res, user) => {
        if (!targets.has(user)) {
            targets.add(user);
            console.log(`🆕 Nuovo Target: ${user}`);
        }
    });

    // 5. Loop sui blocchi
    eventProvider.on("block", async (blockNumber) => {
        lastBlockProcessed = blockNumber;
        const arr = Array.from(targets);
        if (arr.length === 0) return;

        const BATCH = 12;
        const start = (blockNumber * BATCH) % arr.length;
        const batch = arr.slice(start, start + BATCH);

        for (const user of batch) {
            const now = Date.now();
            const cached = userCache.get(user);
            let waitTime = 30 * 60 * 1000;
            if (cached && cached.hf < 1.1) waitTime = 0;

            if (!cached || (now - cached.lastCheck) > waitTime) {
                checkUser(user, botContract, dataManager);
            }
        }
    });

    setInterval(() => {
        if (targets.size > 0) fs.writeFileSync(DB_FILE, JSON.stringify(Array.from(targets)));
    }, 300000);
}

async function checkUser(user, botContract, manager) {
    try {
        const data = await manager.execute(async (prov) => {
            const pool = new ethers.Contract(AAVE_POOL, ["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256 hf)"], prov);
            return await pool.getUserAccountData(user);
        });

        const hf = parseFloat(ethers.formatUnits(data.hf, 18));
        userCache.set(user, { hf: hf, lastCheck: Date.now() });

        if (hf < 1.0 && data.hf > 0n) {
            logAndNotify(`🚨 <b>TARGET VULNERABILE!</b>\nUser: <code>${user}</code>\nHF: ${hf.toFixed(4)}`);
            
            // Tentativo liquidazione
            botContract.requestFlashLoan(USDC, ethers.parseUnits("1500", 6), WETH, user)
                .then(tx => logAndNotify(`🔫 <b>TX Inviata!</b>\n<a href="https://arbiscan.io/tx/${tx.hash}">Vedi su Arbiscan</a>`))
                .catch(() => {});
        }
    } catch (e) {}
}

main().catch(console.error);