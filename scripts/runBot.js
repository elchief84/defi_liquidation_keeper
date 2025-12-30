const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api'); // Nuova libreria
require("dotenv").config();

// --- CONFIGURAZIONE ---
const IS_LOCAL_TEST = false; 
const MY_BOT_ADDRESS = "0x647Aa5C5321bD53E9B43CFB95213541d2945A684"; 
const DATA_DIR = "data";
const DB_FILE = path.join(DATA_DIR, "targets.json");

// Indirizzi Arbitrum
const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

// --- STATO DEL BOT (Memoria) ---
let targets = new Set();
let activityLog = []; // Tiene traccia delle ultime 3 attività
let lastBlockProcessed = 0;
let startTime = Date.now();

// --- INIZIALIZZAZIONE TELEGRAM ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const ownerChatId = process.env.TELEGRAM_CHAT_ID;
let telegramBot = null;

if (token) {
    // polling: true permette al bot di ricevere messaggi
    telegramBot = new TelegramBot(token, { polling: true });
    console.log("📡 Telegram Bot in ascolto comandi...");

    // COMANDO 1: /status
    telegramBot.onText(/\/status/, (msg) => {
        if (msg.chat.id.toString() !== ownerChatId) return; // Sicurezza: risponde solo a te
        
        const uptime = ((Date.now() - startTime) / 1000 / 60).toFixed(1); // Minuti
        const statusMsg = `
🤖 <b>SYSTEM STATUS</b>
━━━━━━━━━━━━━━
✅ <b>Operativo:</b> Sì
⏱ <b>Uptime:</b> ${uptime} min
📦 <b>Ultimo Blocco:</b> ${lastBlockProcessed}
🎯 <b>Bersagli nel DB:</b> ${targets.size}
📡 <b>Modalità:</b> ${IS_LOCAL_TEST ? 'TEST 🧪' : 'MAINNET 🚀'}
`;
        telegramBot.sendMessage(ownerChatId, statusMsg, { parse_mode: 'HTML' });
    });

    // COMANDO 2: /activity
    telegramBot.onText(/\/activity/, (msg) => {
        if (msg.chat.id.toString() !== ownerChatId) return;

        if (activityLog.length === 0) {
            telegramBot.sendMessage(ownerChatId, "📭 Nessuna attività recente.");
            return;
        }

        let reply = "📋 <b>ULTIME 3 ATTIVITÀ</b>\n\n";
        activityLog.forEach((log, index) => {
            reply += `${index + 1}. ${log}\n────────────────\n`;
        });
        telegramBot.sendMessage(ownerChatId, reply, { parse_mode: 'HTML', disable_web_page_preview: true });
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Funzione Helper per inviare notifiche e salvare nel log
function logAndNotify(message, type = "INFO") {
    console.log(`[${type}] ${message.replace(/<[^>]*>?/gm, '')}`); // Log pulito in console
    
    // Aggiorna lo storico (massimo 3 elementi)
    const timestamp = new Date().toLocaleTimeString('it-IT');
    activityLog.unshift(`[${timestamp}] ${message}`);
    if (activityLog.length > 3) activityLog.pop();

    // Invia a Telegram
    if (telegramBot && ownerChatId) {
        telegramBot.sendMessage(ownerChatId, message, { parse_mode: 'HTML' });
    }
}

async function main() {
    console.log("🤖 AVVIO BOT LIQUIDATORE 2.0...");
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
    loadTargets();

    // Provider Setup
    let provider, wallet;
    if (IS_LOCAL_TEST) {
        provider = new ethers.WebSocketProvider("ws://127.0.0.1:8545");
        wallet = new ethers.Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider);
    } else {
        provider = new ethers.WebSocketProvider(process.env.ALCHEMY_WSS_URL);
        wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    }

    const bot = await ethers.getContractAt("AaveLiquidator", MY_BOT_ADDRESS, wallet);
    const poolAbi = ["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)", "event Borrow(address indexed, address indexed, address indexed, uint256, uint256, uint256, uint16)"];
    const aavePool = new ethers.Contract(AAVE_POOL, poolAbi, provider);

    // Notifica di avvio
    logAndNotify("🚀 <b>Bot Avviato!</b>\nScrivi /status per controllare.", "START");

    // Live Listener
    aavePool.on("Borrow", (reserve, user) => {
        if (!targets.has(user)) { 
            targets.add(user); 
            // Non notifichiamo ogni nuovo user per non spammare, ma lo logghiamo silenziosamente
            console.log(`🆕 Nuovo User aggiunto: ${user}`);
        }
    });

    // Block Listener
    provider.on("block", async (blockNumber) => {
        lastBlockProcessed = blockNumber;
        const arr = Array.from(targets);
        if (arr.length === 0) return;
        
        const BATCH = 15; // Controlliamo 15 utenti per blocco
        const start = (blockNumber * BATCH) % arr.length;
        const batch = arr.slice(start, start + BATCH);
        
        console.log(`⚡️ Blocco ${blockNumber}: Controllo ${batch.length} utenti...`);
        
        // --- NUOVA LOGICA ANTI-429 ---
        for (const user of batch) {
            await checkUser(user, aavePool, bot, provider);
            // Aspetta 150ms tra un utente e l'altro per non far arrabbiare Alchemy
            await sleep(150); 
        }
    });

    setInterval(saveTargets, 300000); // Save ogni 5 min
}

async function checkUser(user, pool, bot, provider) {
    try {
        const data = await pool.getUserAccountData(user);
        
        if (data[5] < 1000000000000000000n && data[5] > 0n) { // HealthFactor < 1.0
            
            // 1. Notifica Avvistamento
            logAndNotify(`🚨 <b>TARGET VULNERABILE!</b>\nUser: <code>${user}</code>\nHF: ${ethers.formatUnits(data[5], 18)}`, "ALERT");
            
            const feeData = await provider.getFeeData();
            
            // 2. Tentativo Liquidazione
            bot.requestFlashLoan(USDC, ethers.parseUnits("2000", 6), WETH, user, {
                maxFeePerGas: feeData.maxFeePerGas * 2n,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 3n
            }).then(tx => {
                logAndNotify(`🔫 <b>TX Inviata!</b>\nHash: <a href="https://arbiscan.io/tx/${tx.hash}">Click per vedere</a>`, "ACTION");
            }).catch(e => {
                // Logghiamo l'errore solo se è critico, altrimenti intasa la chat
            });
        }
    } catch (e) {}
}

function loadTargets() { try { JSON.parse(fs.readFileSync(DB_FILE)).forEach(t => targets.add(t)); } catch(e){} }
function saveTargets() { try { fs.writeFileSync(DB_FILE, JSON.stringify(Array.from(targets))); } catch(e){} }

main().catch((error) => { console.error(error); process.exitCode = 1; });