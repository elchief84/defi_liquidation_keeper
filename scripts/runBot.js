const { ethers } = require("hardhat");
const fs = require("fs");
require("dotenv").config();

// --- CONFIGURAZIONE UTENTE ---
// Metti 'true' per testare in locale con 'npx hardhat node'
// Metti 'false' per andare in produzione sulla VPS
const IS_LOCAL_TEST = false; 

// INSERISCI QUI L'INDIRIZZO DEL CONTRATTO DEPLOYATO
const MY_BOT_ADDRESS = "0x647Aa5C5321bD53E9B43CFB95213541d2945A684"; 
const DB_FILE = "targets.json";

// INDIRIZZI ARBITRUM
const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

let targets = new Set();

async function main() {
    loadTargets();
    let provider, wallet;

    if (IS_LOCAL_TEST) {
        console.log("🧪 TEST MODE: WebSocket Locale");
        provider = new ethers.WebSocketProvider("ws://127.0.0.1:8545");
        // Chiave privata finta di Hardhat (Account 0)
        wallet = new ethers.Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider);
    } else {
        console.log("🚀 PRODUCTION MODE: Alchemy WSS");
        provider = new ethers.WebSocketProvider(process.env.ALCHEMY_WSS_URL);
        wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    }

    const bot = await ethers.getContractAt("AaveLiquidator", MY_BOT_ADDRESS, wallet);
    const poolAbi = [
        "function getUserAccountData(address user) view returns (uint256, uint256, uint256, uint256, uint256, uint256 healthFactor)",
        "event Borrow(address indexed reserve, address indexed user, address indexed onBehalfOf, uint256 amount, uint256 interestRateMode, uint256 borrowRate, uint16 referralCode)"
    ];
    const aavePool = new ethers.Contract(AAVE_POOL, poolAbi, provider);

    // 1. SCANSIONE STORICA (Disabilitata per limiti Alchemy Free Tier)
    /* 
    console.log("⏳ Sync database...");
    const currentBlock = await provider.getBlockNumber();
    // QUESTA E' LA RIGA CHE DAVA ERRORE:
    const pastEvents = await aavePool.queryFilter("Borrow", currentBlock - 2000, currentBlock);
    pastEvents.forEach(e => targets.add(e.args.user));
    */
    console.log(`✅ Scansione storica saltata. Si parte dal DB locale.`);

    // 2. LIVE LISTENER
    aavePool.on("Borrow", (reserve, user) => {
        if (!targets.has(user)) { targets.add(user); console.log(`🆕 Nuovo User: ${user}`); }
    });

    // 3. PARALLEL CHECKER
    provider.on("block", async (blockNumber) => {
        const arr = Array.from(targets);
        if (arr.length === 0) return;
        
        const BATCH = 20;
        const start = (blockNumber * BATCH) % arr.length;
        const batch = arr.slice(start, start + BATCH);
        
        console.log(`⚡️ Blocco ${blockNumber}: Check ${batch.length} utenti...`);
        
        // Esecuzione Parallela
        await Promise.all(batch.map(user => checkUser(user, aavePool, bot, provider)));
    });

    setInterval(() => fs.writeFileSync(DB_FILE, JSON.stringify(Array.from(targets))), 300000);
}

async function checkUser(user, pool, bot, provider) {
    try {
        const data = await pool.getUserAccountData(user);
        
        // Se HF < 1.0
        if (data.healthFactor < 1000000000000000000n && data.healthFactor > 0n) {
            console.log(`🚨 TARGET: ${user} HF: ${ethers.formatUnits(data.healthFactor, 18)}`);
            
            // Tentativo Liquidazione 2000 USDC
            const feeData = await provider.getFeeData();
            bot.requestFlashLoan(USDC, ethers.parseUnits("2000", 6), WETH, user, {
                maxFeePerGas: feeData.maxFeePerGas * 2n,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 3n
            }).then(tx => console.log(`🔫 TX Inviata: ${tx.hash}`)).catch(e => {});
        }
    } catch (e) {}
}

function loadTargets() { try { JSON.parse(fs.readFileSync(DB_FILE)).forEach(t => targets.add(t)); } catch(e){} }

main().catch((error) => { console.error(error); process.exitCode = 1; });