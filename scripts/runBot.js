const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');
require("dotenv").config();

// --- CONFIGURAZIONE ---
const MY_BOT_ADDRESS = "0x647Aa5C5321bD53E9B43CFB95213541d2945A684";
const DATA_DIR = path.join(__dirname, "../data");
const DB_FILE = path.join(DATA_DIR, "targets.json");
const BLACKLIST_FILE = path.join(DATA_DIR, "blacklist.json");
const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

// --- STATO ---
let isBotEnabled = true;
let targets = new Set();
let blacklist = new Map();
let lastBlockProcessed = 0;
let activityLog = [];
let telegramBot = null;

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID ? process.env.TELEGRAM_CHAT_ID.trim() : null;

// --- 1. INIZIALIZZAZIONE TELEGRAM IMMEDIATA ---
if (token && chatId) {
    telegramBot = new TelegramBot(token, { 
        polling: { autoStart: true, params: { drop_pending_updates: true } } 
    });

    console.log("📡 Servizio Telegram avviato...");

    // Filtro Sicurezza
    telegramBot.on('message', (msg) => {
        if (msg.chat.id.toString() !== chatId) {
            console.log(`⚠️ Accesso negato per ID: ${msg.chat.id}`);
            return;
        }
    });

    telegramBot.onText(/\/status/, (msg) => {
        const statusMsg = `
🤖 <b>STATO BOT</b>
━━━━━━━━━━━━━━
✅ <b>Attivo:</b> ${isBotEnabled ? 'SÌ' : 'NO'}
🎯 <b>Targets:</b> ${targets.size}
🚫 <b>Blacklist:</b> ${blacklist.size}
📦 <b>Ultimo Blocco:</b> ${lastBlockProcessed}
`;
        telegramBot.sendMessage(chatId, statusMsg, { parse_mode: 'HTML' });
    });

    telegramBot.onText(/\/stop/, () => {
        isBotEnabled = false;
        telegramBot.sendMessage(chatId, "🛑 <b>Bot fermato.</b>");
    });

    telegramBot.onText(/\/start/, () => {
        isBotEnabled = true;
        telegramBot.sendMessage(chatId, "🚀 <b>Bot riattivato.</b>");
    });
}

// --- 2. GESTORE PROVIDER RESILIENTE ---
const rpcUrls = [
    process.env.RPC_2,
    process.env.RPC_3,
    "https://arb1.arbitrum.io/rpc",
    "https://arbitrum.llamarpc.com",
    process.env.RPC_1
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

// --- 3. LOGICA DI NOTIFICA ---
function logAndNotify(message) {
    const timestamp = new Date().toLocaleTimeString('it-IT');
    console.log(`[${timestamp}] ${message.replace(/<[^>]*>?/gm, '')}`);
    if (telegramBot && chatId) {
        telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch(() => {});
    }
}

// --- 4. FUNZIONE PRINCIPALE ---
async function main() {
    console.log("🦅 Avvio logica blockchain...");
    
    // Caricamento Dati
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
        try { JSON.parse(fs.readFileSync(DB_FILE)).forEach(t => targets.add(t.toLowerCase())); } catch(e){}
    }
    if (fs.existsSync(BLACKLIST_FILE)) {
        try { blacklist = new Map(Object.entries(JSON.parse(fs.readFileSync(BLACKLIST_FILE)))); } catch(e){}
    }

    // Usiamo un nodo pubblico per l'ascolto blocchi (più stabile)
    const eventProvider = new ethers.JsonRpcProvider("https://arb1.arbitrum.io/rpc", 42161, { staticNetwork: true });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, eventProvider);
    const botContract = await ethers.getContractAt("AaveLiquidator", MY_BOT_ADDRESS, wallet);

    logAndNotify("🚀 <b>Bot Online!</b> Sistemi pronti.");

    eventProvider.on("block", async (blockNumber) => {
        if (!isBotEnabled || blockNumber % 5 !== 0) return;
        lastBlockProcessed = blockNumber;
        
        const arr = Array.from(targets);
        const start = (blockNumber * 12) % arr.length;
        const batch = arr.slice(start, start + 12);

        for (const user of batch) {
            checkUser(user, botContract);
        }
    });

    setInterval(() => {
        try {
            fs.writeFileSync(DB_FILE, JSON.stringify(Array.from(targets)));
            fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(Object.fromEntries(blacklist)));
        } catch (e) {}
    }, 60000);
}

async function checkUser(user, botContract) {
    const now = Date.now();
    if (blacklist.has(user)) {
        if (now - blacklist.get(user) < 24 * 60 * 60 * 1000) return;
    }

    try {
        const data = await pManager.execute(async (prov) => {
            const pool = new ethers.Contract(AAVE_POOL, ["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256 hf)"], prov);
            return await pool.getUserAccountData(user);
        });

        const hf = parseFloat(ethers.formatUnits(data.hf, 18));
        if (hf < 1.0 && data.hf > 0n) {
            blacklist.set(user, now);
            logAndNotify(`🚨 <b>TARGET:</b> ${user}\nHF: ${hf.toFixed(4)}`);
            
            try {
                const fee = await pManager.providers[2].getFeeData();
                const tx = await botContract.requestFlashLoan(USDC, ethers.parseUnits("1000", 6), WETH, user, {
                    gasLimit: 1000000,
                    maxPriorityFeePerGas: fee.maxPriorityFeePerGas * 5n,
                    maxFeePerGas: fee.maxFeePerGas * 2n
                });
                logAndNotify(`🔫 <b>COLPO!</b> <a href="https://arbiscan.io/tx/${tx.hash}">Link</a>`);
            } catch (e) {
                console.log("Errore invio TX");
            }
        }
    } catch (e) {}
}

main().catch(console.error);