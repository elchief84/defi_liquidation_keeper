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
let telegramBot = null; // Inizializzato dopo

// --- PROVIDER MANAGER ---
const rpcUrls = [
    process.env.RPC_1,
    process.env.RPC_2,
    process.env.RPC_3,
    "https://arb1.arbitrum.io/rpc",
    "https://arbitrum.llamarpc.com"
].filter(url => url);

class SmartProviderManager {
    constructor(urls) {
        // Forza Arbitrum (42161) e staticNetwork per evitare chiamate extra all'avvio
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
                if (i === this.providers.length - 1) throw err;
            }
        }
    }

    async getFirstWorking() {
        for (let p of this.providers) {
            try {
                await p.getBlockNumber();
                return p;
            } catch (e) { continue; }
        }
        return this.providers[0];
    }
}

async function main() {
    console.log("🦅 AVVIO BOT LIQUIDATORE...");
    
    const pManager = new SmartProviderManager(rpcUrls);
    
    // 1. Inizializzazione Telegram DENTRO Main con protezione
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (token && chatId) {
        try {
            telegramBot = new TelegramBot(token, { 
                polling: { 
                    autoStart: true,
                    params: { drop_pending_updates: true } // Pulisce i vecchi messaggi al riavvio
                } 
            });
            console.log("📡 Telegram Bot Connesso.");
            
            telegramBot.onText(/\/status/, (msg) => {
                if (msg.chat.id.toString() !== chatId) return;
                telegramBot.sendMessage(chatId, `✅ <b>Bot Online</b>\n🎯 Targets: ${targets.size}\n📦 Blocco: ${lastBlockProcessed}`, {parse_mode: 'HTML'});
            });
        } catch (e) {
            console.log("⚠️ Errore inizializzazione Telegram:", e.message);
        }
    }

    // 2. Setup Filesystem
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
        try { JSON.parse(fs.readFileSync(DB_FILE)).forEach(t => targets.add(t)); } catch(e) {}
    }

    // 3. Connessione Blockchain
    const activeProvider = await pManager.getFirstWorking();
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, activeProvider);
    const botContract = await ethers.getContractAt("AaveLiquidator", MY_BOT_ADDRESS, wallet);
    
    console.log(`📡 Network pronto. Monitoraggio avviato.`);

    // 4. Listener Eventi
    const aave = new ethers.Contract(AAVE_POOL, ["event Borrow(address indexed reserve, address indexed user, address indexed onBehalfOf, uint256 amount, uint256 interestRateMode, uint256 borrowRate, uint16 referralCode)"], activeProvider);
    aave.on("Borrow", (res, user) => targets.add(user));

    // 5. Loop sui blocchi
    activeProvider.on("block", async (blockNumber) => {
        lastBlockProcessed = blockNumber;
        const arr = Array.from(targets);
        if (arr.length === 0) return;

        const BATCH = 10;
        const start = (blockNumber * BATCH) % arr.length;
        const batch = arr.slice(start, start + BATCH);

        for (const user of batch) {
            const now = Date.now();
            const cached = userCache.get(user);
            let waitTime = 30 * 60 * 1000;
            if (cached && cached.hf < 1.1) waitTime = 0;

            if (!cached || (now - cached.lastCheck) > waitTime) {
                checkUser(user, botContract, pManager, chatId);
            }
        }
    });

    setInterval(() => {
        fs.writeFileSync(DB_FILE, JSON.stringify(Array.from(targets)));
    }, 300000);
}

async function checkUser(user, botContract, pManager, chatId) {
    try {
        const data = await pManager.execute(async (prov) => {
            const pool = new ethers.Contract(AAVE_POOL, ["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256 hf)"], prov);
            return await pool.getUserAccountData(user);
        });

        const hf = parseFloat(ethers.formatUnits(data.hf, 18));
        userCache.set(user, { hf: hf, lastCheck: Date.now() });

        if (hf < 1.0 && data.hf > 0n) {
            const alert = `🚨 <b>VULNERABILE:</b> ${user}\nHF: ${hf.toFixed(4)}`;
            if (telegramBot) telegramBot.sendMessage(chatId, alert, {parse_mode: 'HTML'});
            
            // Tentativo liquidazione rapido
            botContract.requestFlashLoan(USDC, ethers.parseUnits("1500", 6), WETH, user).catch(() => {});
        }
    } catch (e) {
        // Errore ignorato, passerà al prossimo provider
    }
}

main().catch(console.error);