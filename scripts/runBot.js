const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');
require("dotenv").config();

// --- CONFIG ---
const MY_BOT_ADDRESS = "0x647Aa5C5321bD53E9B43CFB95213541d2945A684";
const DATA_DIR = path.join(__dirname, "../data");
const DB_FILE = path.join(DATA_DIR, "targets.json");
const BLACKLIST_FILE = path.join(DATA_DIR, "blacklist.json");

const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

// --- STATO ---
let targets = new Set();
let blacklist = new Map(); 
let lastBlockProcessed = 0;
let telegramBot = null;
const chatId = process.env.TELEGRAM_CHAT_ID;

// --- GESTORE PROVIDER ---
const rpcUrls = [process.env.RPC_2, process.env.RPC_3, "https://arb1.arbitrum.io/rpc", process.env.RPC_1].filter(url => url);

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
                if (err.message.includes("429")) continue;
                if (i === this.providers.length - 1) throw err;
            }
        }
    }
}
const pManager = new SmartProviderManager(rpcUrls);

function logAndNotify(message) {
    const timestamp = new Date().toLocaleTimeString('it-IT');
    console.log(`[${timestamp}] ${message.replace(/<[^>]*>?/gm, '')}`);
    if (telegramBot && chatId) telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch(()=>{});
}

// --- CARICAMENTO DATI ---
function loadData() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
        try { JSON.parse(fs.readFileSync(DB_FILE)).forEach(t => targets.add(t.toLowerCase())); } catch(e){}
    }
    if (fs.existsSync(BLACKLIST_FILE)) {
        try { 
            const saved = JSON.parse(fs.readFileSync(BLACKLIST_FILE));
            blacklist = new Map(Object.entries(saved));
        } catch(e){}
    }
}

function saveBlacklist() {
    try {
        const obj = Object.fromEntries(blacklist);
        fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(obj));
    } catch (e) {}
}

async function main() {
    console.log("🦅 BOT AVVIATO - ANALISI DEBITO ATTIVA");
    loadData();

    if (process.env.TELEGRAM_BOT_TOKEN && chatId) {
        telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: { autoStart: true, params: { drop_pending_updates: true } } });
    }

    const eventProvider = pManager.providers[2] || pManager.providers[0];
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, eventProvider);
    const botContract = await ethers.getContractAt("AaveLiquidator", MY_BOT_ADDRESS, wallet);

    logAndNotify("🚀 <b>Bot Online</b>");

    eventProvider.on("block", async (blockNumber) => {
        if (blockNumber % 5 !== 0) return;
        lastBlockProcessed = blockNumber;
        const arr = Array.from(targets);
        const batchSize = 15;
        const start = (blockNumber * batchSize) % arr.length;
        const batch = arr.slice(start, start + batchSize);

        for (const user of batch) {
            checkUser(user, botContract);
        }
    });
}

async function checkUser(user, botContract) {
    const userAddr = user.toLowerCase();
    const now = Date.now();

    if (blacklist.has(userAddr)) {
        if (now - blacklist.get(userAddr) < 24 * 60 * 60 * 1000) return; // 24 ore di blacklist
    }

    try {
        const data = await pManager.execute(async (prov) => {
            const pool = new ethers.Contract(AAVE_POOL, [
                "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256 hf)",
                "function getUserConfiguration(address user) view returns (uint256)"
            ], prov);
            return await pool.getUserAccountData(userAddr);
        });

        const hf = parseFloat(ethers.formatUnits(data.hf, 18));

        if (hf < 1.0 && data.hf > 0n) {
            // BLACKLIST IMMEDIATA (Per evitare doppioni)
            blacklist.set(userAddr, now);
            saveBlacklist();

            logAndNotify(`🚨 <b>TARGET TROVATO:</b> <code>${userAddr}</code>\nHF: ${hf.toFixed(4)}\nAnalisi debito in corso...`);

            // CONTROLLO ASSET: Molti fallimenti sono dovuti a debiti in USDT/DAI
            // Per ora il bot spara USDC. Se il debito non è USDC, avvisiamo e saltiamo.
            
            try {
                const feeData = await pManager.providers[0].getFeeData();
                const tx = await botContract.requestFlashLoan(USDC, ethers.parseUnits("1000", 6), WETH, userAddr, {
                    gasLimit: 1200000,
                    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 8n, // AGGRESSIVO!
                    maxFeePerGas: feeData.maxFeePerGas * 2n
                });
                logAndNotify(`🔫 <b>SPARO!</b>\n<a href="https://arbiscan.io/tx/${tx.hash}">Vedi Arbiscan</a>`);
            } catch (err) {
                if (err.message.includes("reverted")) {
                    logAndNotify(`ℹ️ <b>SALTATO:</b> Debito non compatibile o già liquidato.`);
                } else {
                    console.log("Errore invio.");
                }
            }
        }
    } catch (e) {}
}

main().catch(console.error);