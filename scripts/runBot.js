const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const TelegramBot = require('node-telegram-bot-api');
require("dotenv").config();

// --- CONFIGURAZIONE CORE ---
const MY_BOT_ADDRESS = "0x647Aa5C5321bD53E9B43CFB95213541d2945A684";
const DATA_DIR = path.join(__dirname, "../data");
const DB_FILE = path.join(DATA_DIR, "targets.json");

// INDIRIZZI ARBITRUM ONE
const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

// --- STATO DEL BOT ---
let targets = new Set();
const userCache = new Map(); // Memorizza { hf: numero, lastCheck: timestamp }
let activityLog = [];        // Ultime 3 attività per /activity
let lastBlockProcessed = 0;
let telegramBot = null;
const chatId = process.env.TELEGRAM_CHAT_ID;

// --- GESTORE PROVIDER (MULTI-NODO CON FAILOVER) ---
const rpcUrls = [
    process.env.RPC_1, // Solitamente Alchemy (HTTPS)
    process.env.RPC_2, // Solitamente QuickNode (HTTPS)
    process.env.RPC_3, // Solitamente Ankr/DRPC (HTTPS)
    "https://arb1.arbitrum.io/rpc",    // Pubblico Arbitrum (Stabile)
    "https://arbitrum.llamarpc.com"    // Pubblico Llama (Stabile)
].filter(url => url);

class SmartProviderManager {
    constructor(urls) {
        // staticNetwork: true impedisce ad ethers di fare chiamate di rete inutili all'avvio
        this.providers = urls.map(url => new ethers.JsonRpcProvider(url, 42161, { staticNetwork: true }));
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
                const errMsg = err.message.toLowerCase();
                this.index = (this.index + 1) % this.providers.length;
                // Salta errori di limiti (429) o metodi non supportati (400)
                if (errMsg.includes("429") || errMsg.includes("400") || errMsg.includes("available")) continue;
                if (i === this.providers.length - 1) throw err;
            }
        }
    }
}
const pManager = new SmartProviderManager(rpcUrls);

// --- SISTEMA DI NOTIFICA E LOG ---
function logAndNotify(message) {
    const timestamp = new Date().toLocaleTimeString('it-IT');
    console.log(`[${timestamp}] ${message.replace(/<[^>]*>?/gm, '')}`);
    
    activityLog.unshift(`[${timestamp}] ${message}`);
    if (activityLog.length > 3) activityLog.pop();

    if (telegramBot && chatId) {
        telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(()=>{});
    }
}

// --- PROTEZIONE GLOBALE CONTRO I CRASH ---
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Errore RPC catturato (Rejection):', reason.message || reason);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️ Errore critico catturato (Exception):', err.message);
});

async function main() {
    console.log("🦅 AVVIO BOT LIQUIDATORE 2.0 (GOD MODE)...");

    // 1. INIZIALIZZAZIONE TELEGRAM PRIVATO
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (token && chatId) {
        // Ritardo per evitare l'errore 409 Conflict con Coolify
        await new Promise(r => setTimeout(r, 5000));
        
        telegramBot = new TelegramBot(token, { 
            polling: { autoStart: true, params: { drop_pending_updates: true } } 
        });

        // Filtro di Sicurezza Totale
        telegramBot.on('message', (msg) => {
            if (msg.chat.id.toString() !== chatId.toString()) {
                console.log(`⚠️ Accesso negato per ID: ${msg.chat.id}`);
                return;
            }
        });

        telegramBot.onText(/\/status/, () => {
            const statusMsg = `✅ <b>Bot Online</b>\n🎯 Targets: ${targets.size}\n📦 Blocco: ${lastBlockProcessed}\n📡 Nodi: ${rpcUrls.length}`;
            telegramBot.sendMessage(chatId, statusMsg, { parse_mode: 'HTML' });
        });

        telegramBot.onText(/\/activity/, () => {
            if (activityLog.length === 0) return telegramBot.sendMessage(chatId, "📭 Nessuna attività.");
            let reply = "📋 <b>ULTIME ATTIVITÀ</b>\n\n" + activityLog.join("\n\n");
            telegramBot.sendMessage(chatId, reply, { parse_mode: 'HTML', disable_web_page_preview: true });
        });
    }

    // 2. SETUP FILESYSTEM E DATABASE
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    loadTargets();

    // 3. SETUP BLOCKCHAIN
    // Usiamo il nodo pubblico stabile (Arbitrum Foundation) per blocchi ed eventi
    const eventProvider = new ethers.JsonRpcProvider("https://arb1.arbitrum.io/rpc", 42161, { staticNetwork: true });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, eventProvider);
    const botContract = await ethers.getContractAt("AaveLiquidator", MY_BOT_ADDRESS, wallet);

    logAndNotify("🚀 <b>Bot Avviato!</b>\nMonitoraggio di migliaia di target attivo.");

    // 4. LISTENER NUOVI PRESTITI (Aggiunge nuovi utenti dinamicamente)
    const aave = new ethers.Contract(AAVE_POOL, ["event Borrow(address indexed, address indexed user, address, uint256, uint256, uint256, uint16)"], eventProvider);
    aave.on("Borrow", (res, user) => {
        const userLower = user.toLowerCase();
        if (!targets.has(userLower)) {
            targets.add(userLower);
            console.log(`🆕 Nuovo Target intercettato: ${userLower}`);
        }
    });

    // 5. LOOP DI SCANSIONE (SUI BLOCCHI)
    eventProvider.on("block", async (blockNumber) => {
        lastBlockProcessed = blockNumber;
        const arr = Array.from(targets);
        if (arr.length === 0) return;

        // BATCH SIZE: Controlliamo 12 utenti a ogni blocco per stare nei limiti RPC
        const BATCH = 12;
        const start = (blockNumber * BATCH) % arr.length;
        const batch = arr.slice(start, start + BATCH);

        for (const user of batch) {
            const now = Date.now();
            const cached = userCache.get(user);

            // --- LOGICA SMART CACHE PER 5000+ UTENTI ---
            // Gestisce la frequenza dei controlli in base al rischio di fallimento
            let waitTime = 60 * 60 * 1000; // Default: 1 ORA per utenti molto sicuri

            if (cached) {
                if (cached.hf < 1.02) {
                    waitTime = 0;             // PERICOLO VERO: Controlla ogni blocco
                } else if (cached.hf < 1.10) {
                    waitTime = 10 * 1000;     // RISCHIO ALTO: Ogni 10 secondi
                } else if (cached.hf < 1.50) {
                    waitTime = 5 * 60 * 1000; // RISCHIO MEDIO: Ogni 5 minuti
                } else if (cached.hf < 2.50) {
                    waitTime = 30 * 60 * 1000;// SICURO: Ogni 30 minuti
                }
            }

            if (!cached || (now - cached.lastCheck) > waitTime) {
                checkUser(user, botContract).catch(()=>{});
            }
        }
    });

    // Salvataggio DB ogni 5 minuti
    setInterval(saveTargets, 300000);
}

// --- AGGIUNGI IN ALTO NELLO STATO ---
const liquidationAttempts = new Map(); // Memorizza { user: timestamp_ultimo_sparo }

// --- SOSTITUISCI LA FUNZIONE checkUser CON QUESTA ---
async function checkUser(user, botContract) {
    try {
        const now = Date.now();
        
        // 1. Controllo Cooldown (Evitiamo lo spam sullo stesso utente)
        const lastAttempt = liquidationAttempts.get(user);
        if (lastAttempt && (now - lastAttempt) < 120000) return; // Aspetta 2 minuti tra tentativi

        const data = await pManager.execute(async (prov) => {
            const pool = new ethers.Contract(AAVE_POOL, ["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256 hf)"], prov);
            return await pool.getUserAccountData(user);
        });

        const hf = parseFloat(ethers.formatUnits(data.hf, 18));
        userCache.set(user, { hf: hf, lastCheck: now });

        if (hf < 1.0 && data.hf > 0n) {
            logAndNotify(`🚨 <b>TARGET VULNERABILE!</b>\nUser: <code>${user}</code>\nHF: ${hf.toFixed(4)}`);
            
            // Segnamo il tentativo per non spammare l'RPC
            liquidationAttempts.set(user, now);

            // 2. SPARO INTELLIGENTE (Usiamo pManager per inviare)
            await pManager.execute(async (prov) => {
                // Colleghiamo il contratto al provider che sta funzionando ora
                const botWithProvider = botContract.connect(new ethers.Wallet(process.env.PRIVATE_KEY, prov));
                
                const feeData = await prov.getFeeData();
                
                // Invio transazione
                const tx = await botWithProvider.requestFlashLoan(
                    USDC, 
                    ethers.parseUnits("1500", 6), 
                    WETH, 
                    user, 
                    {
                        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 2n,
                        maxFeePerGas: feeData.maxFeePerGas * 2n,
                        gasLimit: 1000000 // Limit fisso per non chiedere al nodo di simulare (risparmio chiamate)
                    }
                );
                
                logAndNotify(`🔫 <b>TX Inviata!</b>\n<a href="https://arbiscan.io/tx/${tx.hash}">Vedi su Arbiscan</a>`);
            });
        }
    } catch (e) {
        // Se fallisce qui, il pManager passerà comunque al prossimo nodo al prossimo giro
    }
}

// --- PERSISTENZA DATI ---
function loadTargets() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const content = fs.readFileSync(DB_FILE);
            JSON.parse(content).forEach(t => targets.add(t.toLowerCase()));
            console.log(`📂 Database caricato: ${targets.size} utenti.`);
        }
    } catch (e) {
        console.log("⚠️ Errore caricamento database, si parte da zero.");
    }
}

function saveTargets() {
    try {
        if (targets.size > 0) {
            fs.writeFileSync(DB_FILE, JSON.stringify(Array.from(targets)));
        }
    } catch (e) {
        console.error("❌ Errore salvataggio database");
    }
}

main().catch((error) => {
    console.error("💀 Errore fatale:", error);
    process.exit(1);
});