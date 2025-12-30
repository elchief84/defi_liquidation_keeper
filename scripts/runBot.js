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

// --- STATO E CACHE ---
let targets = new Set();
const userCache = new Map();
let lastBlockProcessed = 0;

// --- GESTORE PROVIDER INTELLIGENTE ---
const rpcUrls = [
    process.env.RPC_1,
    process.env.RPC_2,
    process.env.RPC_3,
    "https://arb1.arbitrum.io/rpc",
    "https://arbitrum.llamarpc.com"
].filter(url => url);

class SmartProviderManager {
    constructor(urls) {
        // OTTIMIZZAZIONE: staticNetwork: true impedisce ad ethers di chiamare il provider all'avvio
        this.providers = urls.map(url => 
            new ethers.JsonRpcProvider(url, 42161, { staticNetwork: true })
        );
        this.index = 0;
    }

    async execute(task) {
        for (let i = 0; i < this.providers.length; i++) {
            const currentProvider = this.providers[this.index];
            try {
                const result = await task(currentProvider);
                this.index = (this.index + 1) % this.providers.length;
                return result;
            } catch (err) {
                // Se l'errore è 429 (limite Alchemy), passiamo oltre senza pietà
                this.index = (this.index + 1) % this.providers.length;
                continue;
            }
        }
        throw new Error("Tutti i provider sono offline o limitati.");
    }

    // Trova il primo provider che risponde davvero per le funzioni di ascolto
    async getFirstWorkingProvider() {
        for (let p of this.providers) {
            try {
                await p.getBlockNumber();
                return p;
            } catch (e) { continue; }
        }
        return this.providers[0];
    }
}
const pManager = new SmartProviderManager(rpcUrls);

// --- TELEGRAM ---
const tBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

async function main() {
    console.log(`🦅 CECCHINO DeFi AVVIATO`);
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    loadTargets();

    // Troviamo un provider che funzioni per inizializzare il bot
    const activeProvider = await pManager.getFirstWorkingProvider();
    console.log(`📡 Connesso a un nodo funzionante per l'avvio.`);

    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, activeProvider);
    const botContract = await ethers.getContractAt("AaveLiquidator", MY_BOT_ADDRESS, wallet);

    // Listener eventi (usiamo il provider attivo trovato)
    const aave = new ethers.Contract(AAVE_POOL, ["event Borrow(address indexed reserve, address indexed user, address indexed onBehalfOf, uint256 amount, uint256 interestRateMode, uint256 borrowRate, uint16 referralCode)"], activeProvider);
    aave.on("Borrow", (res, user) => { 
        if (!targets.has(user)) {
            targets.add(user);
            console.log(`🆕 Nuovo Target: ${user}`);
        }
    });

    // Loop sui blocchi
    activeProvider.on("block", async (blockNumber) => {
        lastBlockProcessed = blockNumber;
        const arr = Array.from(targets);
        if (arr.length === 0) return;

        const BATCH_SIZE = 10; // Ridotto un po' per sicurezza
        const start = (blockNumber * BATCH_SIZE) % arr.length;
        const batch = arr.slice(start, start + BATCH_SIZE);

        for (const user of batch) {
            const now = Date.now();
            const cached = userCache.get(user);
            let waitTime = 30 * 60 * 1000;
            if (cached) {
                if (cached.hf < 1.05) waitTime = 0;
                else if (cached.hf < 1.15) waitTime = 60 * 1000;
            }

            if (!cached || (now - cached.lastCheck) > waitTime) {
                checkAndLiquidate(user, botContract).catch(() => {});
            }
        }
    });

    // Telegram Status
    tBot.onText(/\/status/, (msg) => {
        tBot.sendMessage(msg.chat.id, `✅ <b>Bot Operativo</b>\n🎯 Targets: ${targets.size}\n📦 Blocco: ${lastBlockProcessed}\n📡 Nodi configurati: ${rpcUrls.length}`, {parse_mode: 'HTML'});
    });
}

async function checkAndLiquidate(user, botContract) {
    try {
        const data = await pManager.execute(async (provider) => {
            const pool = new ethers.Contract(AAVE_POOL, ["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256 hf)"], provider);
            return await pool.getUserAccountData(user);
        });

        const hf = parseFloat(ethers.formatUnits(data.hf, 18));
        userCache.set(user, { hf: hf, lastCheck: Date.now() });

        if (hf < 1.0 && data.hf > 0n) {
            // Se troviamo un bersaglio, notifichiamo
            const msg = `🚨 <b>TARGET VULNERABILE!</b>\nUser: <code>${user}</code>\nHF: ${hf.toFixed(4)}`;
            tBot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, {parse_mode: 'HTML'});
            
            // Tenta liquidazione
            const feeData = await pManager.providers[0].getFeeData().catch(() => ({maxPriorityFeePerGas: 100000000n}));
            botContract.requestFlashLoan(USDC, ethers.parseUnits("1500", 6), WETH, user, {
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 2n
            }).catch(() => {});
        }
    } catch (e) {}
}

function loadTargets() {
    try { if (fs.existsSync(DB_FILE)) { JSON.parse(fs.readFileSync(DB_FILE)).forEach(t => targets.add(t)); } } catch (e) {}
}
function saveTargets() {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(Array.from(targets))); } catch (e) {}
}
setInterval(saveTargets, 300000);

main().catch(console.error);