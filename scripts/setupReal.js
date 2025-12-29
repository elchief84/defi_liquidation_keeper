const { ethers } = require("hardhat");

// Funzione di utilità per mettere in pausa lo script (Sleep)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    console.log("⚙️  INIZIO SETUP MAINNET (Procedure Robusta)...");

    // INDIRIZZI
    const BOT_ADDRESS = "0x647Aa5C5321bD53E9B43CFB95213541d2945A684";
    const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
    const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

    const bot = await ethers.getContractAt("AaveLiquidator", BOT_ADDRESS);

    // --- APPROVAZIONE 1: USDC ---
    try {
        console.log("1. Invio approvazione USDC...");
        const tx1 = await bot.approveToken(USDC);
        console.log(`   ⏳ Tx inviata (${tx1.hash}). In attesa di conferma...`);
        
        await tx1.wait(); // Aspetta che venga scritta nel blocco
        console.log("   ✅ USDC Approvato!");
    } catch (error) {
        console.log("   ⚠️  USDC probabilmente già approvato o errore:", error.message);
    }

    // PAUSA TATTICA (Per evitare errori di Nonce/RPC)
    console.log("☕ Pausa di 5 secondi per sincronizzare la rete...");
    await sleep(5000);

    // --- APPROVAZIONE 2: WETH ---
    try {
        console.log("2. Invio approvazione WETH...");
        const tx2 = await bot.approveToken(WETH);
        console.log(`   ⏳ Tx inviata (${tx2.hash}). In attesa di conferma...`);
        
        await tx2.wait(); // Aspetta conferma
        console.log("   ✅ WETH Approvato!");
    } catch (error) {
        console.log("   ⚠️  WETH probabilmente già approvato o errore:", error.message);
    }

    console.log("🎉 SETUP COMPLETATO! Il Bot ha tutti i permessi necessari.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});