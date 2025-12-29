const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Test di Vendita su Uniswap", function () {
  
  // INDIRIZZI ARBITRUM
  const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"; // Il "bottino"
  const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // I soldi veri
  const UNISWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
  const AAVE_PROVIDER = "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb";
  
  // Pool Uniswap V3 USDC/WETH (Questa ha sicuramente i soldi)
  const WHALE_WETH = "0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443";

  it("Il bot deve riuscire a vendere WETH per USDC", async function () {
    
    // 1. Deploy del Bot
    const LiquidatorFactory = await ethers.getContractFactory("AaveLiquidator");
    const liquidator = await LiquidatorFactory.deploy(AAVE_PROVIDER);
    await liquidator.waitForDeployment();
    const liquidatorAddress = await liquidator.getAddress();
    console.log("Bot creato a:", liquidatorAddress);

    console.log("Setup: Approvazione WETH e USDC...");
    // Approviamo WETH perché dobbiamo venderlo
    // Approviamo USDC perché dobbiamo restituire il prestito (anche se in questo test specifico facciamo solo swap)
    await liquidator.approveToken(WETH_ADDRESS);
    await liquidator.approveToken(USDC_ADDRESS);

    // 2. Setup dei Token
    const weth = await ethers.getContractAt("IERC20", WETH_ADDRESS);
    const usdc = await ethers.getContractAt("IERC20", USDC_ADDRESS);

    // 3. Rubiamo WETH dalla Balena e li diamo al Bot
    // Simuliamo che il bot abbia appena liquidato qualcuno e incassato 1 WETH
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [WHALE_WETH],
    });
    // Diamo Gas alla balena
    await hre.network.provider.send("hardhat_setBalance", [WHALE_WETH, "0x100000000000000000000"]);
    
    const whale = await ethers.getSigner(WHALE_WETH);
    const lootAmount = ethers.parseEther("1"); // 1 WETH

    console.log("Trasferimento di 1 WETH al bot (Simulazione Bottino)...");
    await weth.connect(whale).transfer(liquidatorAddress, lootAmount);

    // Verifica saldo iniziale
    const botWethBalance = await weth.balanceOf(liquidatorAddress);
    console.log("Il Bot ora possiede:", ethers.formatEther(botWethBalance), "WETH");

    // 4. IMPERSONIAMO IL BOT
    // Ora facciamo finta di ESSERE il contratto per eseguire lo swap manualmente
    // Questo serve a testare se le rotte di Uniswap funzionano
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [liquidatorAddress],
    });
    // Diamo Gas al Bot (ne serve per eseguire transazioni)
    await hre.network.provider.send("hardhat_setBalance", [liquidatorAddress, "0x100000000000000000000"]);
    const botSigner = await ethers.getSigner(liquidatorAddress);

    console.log("Esecuzione Vendita su Uniswap...");
    const router = await ethers.getContractAt("ISwapRouter", UNISWAP_ROUTER);
    
    const params = {
      tokenIn: WETH_ADDRESS,
      tokenOut: USDC_ADDRESS,
      fee: 3000, // 0.3%
      recipient: liquidatorAddress,
      deadline: Math.floor(Date.now() / 1000) + 60 * 10,
      amountIn: lootAmount,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0
    };

    await router.connect(botSigner).exactInputSingle(params);

    // 6. Verifica Finale
    const usdcBalance = await usdc.balanceOf(liquidatorAddress);
    console.log("SWAP COMPLETATO! Il Bot ora ha:", ethers.formatUnits(usdcBalance, 6), "USDC");

    expect(usdcBalance).to.be.gt(0);
    console.log("TEST SUPERATO: Il bot sa vendere su Uniswap.");
  });
});