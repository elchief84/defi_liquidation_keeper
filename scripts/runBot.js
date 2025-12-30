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
let telegramBot = null;

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID ? process.env.TELEGRAM_CHAT_ID.trim() : null;

// --- 1. TELEGRAM SETUP (Immediato) ---
if (token && chatId) {
    telegramBot = new TelegramBot(token, { polling: { autoStart: true, params: { drop_pending_updates: true } } });
    console.log("🟢 [SYSTEM] Telegram Bot inizializzato.");

    telegramBot.onText(/\/status/, (msg) => {
        if (msg.chat.id.toString() !== chatId) return;
        const statusMsg = `🤖 <b>STATO BOT</b>\n━━━━━━━━━━━━━━\n✅ Attivo: ${isBotEnabled ? 'SÌ' : 'NO'}\n🎯 Targets: ${targets.size}\n🚫 Blacklist: ${blacklist.size}\n📦 Blocco: ${lastBlockProcessed}`;
        telegramBot.sendMessage(chatId, statusMsg, { parse_mode: 'HTML' });
    });

    telegramBot.onText(/\/stop/, () => { isBotEnabled = false; telegramBot.sendMessage(chatId, "🛑 Bot sospeso."); });
    telegramBot.onText(/\/start/, () => { isBotEnabled = true; telegramBot.sendMessage(chatId, "🚀 Bot riattivato."); });
}

// --- 2. MULTI-PROVIDER MANAGER ---
const rpcUrls = [
    process.env.RPC_2,
    process.env.RPC_3,
    "https://arb1.arbitrum.io/rpc",
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
                console.log(`⚠️ [RPC] Nodo ${this.index} in difficoltà, ruoto...`);
                this.index = (this.index + 1) % this.providers.length;
                if (i === this.providers.length - 1) throw err;
            }
        }
    }
}
const pManager = new SmartProviderManager(rpcUrls);

// --- 3. HELPER NOTIFICHE ---
function logAndNotify(message) {
    const timestamp = new Date().toLocaleTimeString('it-IT');
    console.log(`✨ [EVENTO] ${message.replace(/<[^>]*>?/gm, '')}`);
    if (telegramBot && chatId) {
        telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch(() => {});
    }
}

// --- 4. FUNZIONE PRINCIPALE ---
async function main() {
    console.log("🦅 [START] Avvio logica Cecchino DeFi...");

    // Caricamento Dati
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
        try { 
            const t = JSON.parse(fs.readFileSync(DB_FILE));
            t.forEach(addr => targets.add(addr.toLowerCase()));
            console.log(`📂 [DB] Caricati ${targets.size} target.`);
        } catch(e) { console.log("❌ [DB] Errore caricamento targets.json"); }
    }
    if (fs.existsSync(BLACKLIST_FILE)) {
        try { 
            const b = JSON.parse(fs.readFileSync(BLACKLIST_FILE));
            blacklist = new Map(Object.entries(b));
            console.log(`📂 [DB] Caricata blacklist: ${blacklist.size} utenti.`);
        } catch(e) { console.log("❌ [DB] Errore caricamento blacklist.json"); }
    }

    const eventProvider = new ethers.JsonRpcProvider("https://arb1.arbitrum.io/rpc", 42161, { staticNetwork: true });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, eventProvider);
    const botContract = await ethers.getContractAt("AaveLiquidator", MY_BOT_ADDRESS, wallet);

    console.log("🔗 [NETWORK] Connesso ad Arbitrum. In attesa di blocchi...");
    logAndNotify("🚀 <b>Bot Online</b> - Inizio scansione.");

    eventProvider.on("block", async (blockNumber) => {
        if (!isBotEnabled) return;

        // Log ogni 10 blocchi per mostrare che il bot è vivo
        if (blockNumber % 10 === 0) {
            console.log(`💓 [HEARTBEAT] Blocco: ${blockNumber} | Target monitorati: ${targets.size}`);
        }

        // Scansione ogni 5 blocchi
        if (blockNumber % 5 !== 0) return;
        lastBlockProcessed = blockNumber;
        
        const arr = Array.from(targets);
        if (arr.length === 0) return;

        const startIdx = (blockNumber * 12) % arr.length;
        const batch = arr.slice(startIdx, startIdx + 12);

        // console.log(`🔍 [SCAN] Controllo batch da ${startIdx} a ${startIdx + batch.length}`);

        for (const user of batch) {
            checkUser(user, botContract);
        }
    });

    // Salvataggio periodico
    setInterval(() => {
        try {
            fs.writeFileSync(DB_FILE, JSON.stringify(Array.from(targets)));
            fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(Object.fromEntries(blacklist)));
            console.log("💾 [SYSTEM] Backup database eseguito.");
        } catch (e) { console.log("❌ [SYSTEM] Errore backup."); }
    }, 300000); // 5 minuti
}

async function checkUser(user, botContract) {
    const userAddr = user.toLowerCase();
    const now = Date.now();

    if (blacklist.has(userAddr)) {
        if (now - blacklist.get(userAddr) < 24 * 60 * 60 * 1000) return;
        else {
            blacklist.delete(userAddr);
            console.log(`♻️ [BLACKLIST] Utente ${userAddr} rimosso (tempo scaduto).`);
        }
    }

    try {
        const data = await pManager.execute(async (prov) => {
            const pool = new ethers.Contract(AAVE_POOL, ["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256 hf)"], prov);
            return await pool.getUserAccountData(userAddr);
        });

        const hf = parseFloat(ethers.formatUnits(data.hf, 18));
        
        // Log se un utente è "caldo" (HF basso ma non ancora liquidabile)
        if (hf < 1.10 && hf > 1.0) {
            console.log(`🔥 [ALERT] Utente a rischio: ${userAddr} | HF: ${hf.toFixed(4)}`);
        }

        if (hf < 1.0 && data.hf > 0n) {
            blacklist.set(userAddr, now);
            logAndNotify(`🚨 <b>TARGET TROVATO!</b>\nUser: <code>${userAddr}</code>\nHF: ${hf.toFixed(4)}`);
            
            try {
                const fee = await pManager.providers[2].getFeeData();
                const tx = await botContract.requestFlashLoan(USDC, ethers.parseUnits("1200", 6), WETH, userAddr, {
                    gasLimit: 1100000,
                    maxPriorityFeePerGas: fee.maxPriorityFeePerGas * 6n,
                    maxFeePerGas: fee.maxFeePerGas * 2n
                });
                logAndNotify(`🔫 <b>COLPO LANCIATO!</b>\n<a href="https://arbiscan.io/tx/${tx.hash}">Dettagli</a>`);
            } catch (err) {
                console.log(`❌ [TX] Fallimento invio per ${userAddr}: ${err.message.substring(0, 50)}`);
            }
        }
    } catch (e) {
        // Errore RPC già loggato dal manager
    }
}

main().catch(console.error);