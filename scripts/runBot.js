const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');
require("dotenv").config();

// --- CONFIGURAZIONE ---
const MY_BOT_ADDRESS = "0x647Aa5C5321bD53E9B43CFB95213541d2945A684";
const DATA_DIR = path.join(__dirname, "../data");
const DB_FILE = path.join(DATA_DIR, "targets.json");

// INDIRIZZI ARBITRUM
const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

// --- STATO E CACHE ---
let targets = new Set();
const userCache = new Map(); // Memorizza { hf: numero, lastCheck: timestamp }
let lastBlockProcessed = 0;
let activityLog = [];

// --- GESTORE PROVIDER MULTI-LIVELLO ---
const rpcUrls = [
    process.env.RPC_1, // Primario (es. Alchemy)
    process.env.RPC_2, // Secondario (es. QuickNode)
    process.env.RPC_3, // Terziario (es. Ankr/DRPC)
    "https://arb1.arbitrum.io/rpc",    // Pubblico Arbitrum (Backup)
    "https://arbitrum.llamarpc.com"    // Pubblico Llama (Backup)
].filter(url => url);

class SmartProviderManager {
    constructor(urls) {
        this.providers = urls.map(url => new ethers.JsonRpcProvider(url));
        this.index = 0;
    }

    // Prova una chiamata. Se fallisce, ruota e riprova subito con un altro provider.
    async execute(task) {
        let lastErr;
        for (let i = 0; i < this.providers.length; i++) {
            const currentProvider = this.providers[this.index];
            try {
                const result = await task(currentProvider);
                // Dopo un successo, ruotiamo comunque per il prossimo task (Round Robin)
                this.index = (this.index + 1) % this.providers.length;
                return result;
            } catch (err) {
                lastErr = err;
                console.log(`⚠️ Nodo ${this.index} in errore, provo il prossimo...`);
                this.index = (this.index + 1) % this.providers.length;
                // Se l'errore è un limite di velocità, continuiamo il ciclo for
            }
        }
        throw lastErr;
    }
}
const pManager = new SmartProviderManager(rpcUrls);

// --- TELEGRAM ---
const tBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

function notify(msg) {
    console.log(`[BOT] ${msg.replace(/<[^>]*>?/gm, '')}`);
    activityLog.unshift(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (activityLog.length > 5) activityLog.pop();
    if (process.env.TELEGRAM_CHAT_ID) {
        tBot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'HTML' }).catch(() => {});
    }
}

// --- LOGICA PRINCIPALE ---
async function main() {
    console.log(`🦅 CECCHINO DeFi AVVIATO CON ${rpcUrls.length} NODI`);
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    loadTargets();

    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, pManager.providers[0]);
    const botContract = await ethers.getContractAt("AaveLiquidator", MY_BOT_ADDRESS, wallet);

    // Listener nuovi prestiti (usiamo il primo provider come listener)
    const aave = new ethers.Contract(AAVE_POOL, ["event Borrow(address indexed reserve, address indexed user, address indexed onBehalfOf, uint256 amount, uint256 interestRateMode, uint256 borrowRate, uint16 referralCode)"], pManager.providers[0]);
    aave.on("Borrow", (res, user) => { 
        if (!targets.has(user)) {
            targets.add(user);
            console.log(`🆕 Nuovo Target intercettato: ${user}`);
        }
    });

    // Loop sui blocchi
    pManager.providers[0].on("block", async (blockNumber) => {
        lastBlockProcessed = blockNumber;
        const arr = Array.from(targets);
        if (arr.length === 0) return;

        // Controlliamo un batch per blocco
        const BATCH_SIZE = 15;
        const start = (blockNumber * BATCH_SIZE) % arr.length;
        const batch = arr.slice(start, start + BATCH_SIZE);

        console.log(`📦 Blocco ${blockNumber} | Scansione Batch: ${batch.length} utenti`);

        for (const user of batch) {
            const now = Date.now();
            const cached = userCache.get(user);

            // LOGICA SMART CACHE (Priorità)
            let waitTime = 30 * 60 * 1000; // 30 min per utenti sicuri
            if (cached) {
                if (cached.hf < 1.02) waitTime = 0;               // PERICOLO IMMINENTE: Ogni blocco
                else if (cached.hf < 1.10) waitTime = 15 * 1000;  // 15 secondi
                else if (cached.hf < 1.50) waitTime = 5 * 60 * 1000; // 5 minuti
            }

            if (!cached || (now - cached.lastCheck) > waitTime) {
                checkAndLiquidate(user, botContract).catch(() => {});
            }
        }
    });

    // Comandi Telegram
    tBot.onText(/\/status/, (msg) => {
        const status = `✅ <b>Bot Operativo</b>\n🎯 Targets: ${targets.size}\n📦 Ultimo Blocco: ${lastBlockProcessed}\n📡 Nodi Attivi: ${rpcUrls.length}`;
        tBot.sendMessage(msg.chat.id, status, { parse_mode: 'HTML' });
    });
}

async function checkAndLiquidate(user, botContract) {
    try {
        // Usiamo il gestore intelligente per la chiamata getUserAccountData
        const data = await pManager.execute(async (provider) => {
            const pool = new ethers.Contract(AAVE_POOL, ["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256 hf)"], provider);
            return await pool.getUserAccountData(user);
        });

        const hf = parseFloat(ethers.formatUnits(data.hf, 18));
        userCache.set(user, { hf: hf, lastCheck: Date.now() });

        if (hf < 1.0 && data.hf > 0n) {
            notify(`🚨 <b>TARGET VULNERABILE!</b>\nUser: <code>${user}</code>\nHF: ${hf.toFixed(4)}`);
            
            // Tenta liquidazione
            const feeData = await pManager.providers[0].getFeeData();
            const tx = await botContract.requestFlashLoan(USDC, ethers.parseUnits("1500", 6), WETH, user, {
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 2n
            });
            notify(`🔫 <b>TX Inviata!</b>\nHash: <a href="https://arbiscan.io/tx/${tx.hash}">Vedi Arbiscan</a>`);
        }
    } catch (e) {
        // Silenzioso: riproverà al prossimo ciclo utile
    }
}

// Persistenza Database
function loadTargets() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = JSON.parse(fs.readFileSync(DB_FILE));
            data.forEach(t => targets.add(t));
        }
    } catch (e) { console.log("⚠️ Database non trovato, inizio pulito."); }
}

function saveTargets() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(Array.from(targets)));
    } catch (e) {}
}
setInterval(saveTargets, 300000); // Ogni 5 minuti

main().catch(console.error);