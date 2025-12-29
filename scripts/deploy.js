const hre = require("hardhat");

async function main() {
  console.log("🚀 Inizio Deploy su Arbitrum Mainnet...");

  // Indirizzo reale di Aave V3 Pool Addresses Provider su Arbitrum
  const AAVE_PROVIDER = "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb";

  // Compiliamo e carichiamo
  const Liquidator = await hre.ethers.getContractFactory("AaveLiquidator");
  
  // Deploy
  const liquidator = await Liquidator.deploy(AAVE_PROVIDER);

  console.log("⏳ In attesa della conferma dalla blockchain...");
  await liquidator.waitForDeployment();

  const address = await liquidator.getAddress();
  console.log("✅ CONTRACT DEPLOYED WITH SUCCESS!");
  console.log("👉 INDIRIZZO BOT:", address);
  console.log("-----------------------------------------");
  console.log("⚠️  COPIA QUESTO INDIRIZZO! Ti servirà per il setup e per il bot.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});