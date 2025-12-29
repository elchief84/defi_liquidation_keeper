const { ethers } = require("hardhat");

async function main() {
    // --- CONFIGURAZIONE ---
    // INSERISCI QUI L'INDIRIZZO CHE RICEVI DAL DEPLOY
    const BOT_ADDRESS = "0x647Aa5C5321bD53E9B43CFB95213541d2945A684"; 
    
    const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
    const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

    const bot = await ethers.getContractAt("AaveLiquidator", BOT_ADDRESS);
    console.log("⚙️  Setup in corso: Approvazione Token...");
    await bot.approveToken(USDC);
    await bot.approveToken(WETH);
    console.log("✅ Setup completato! Il bot è pronto a sparare.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});