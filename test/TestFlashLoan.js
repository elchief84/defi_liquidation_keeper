const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Aave Flash Loan Test", function () {
  let liquidator;
  let owner;
  
  // INDIRIZZI VERI SU ARBITRUM
  // 1. Il 'Centralino' di Aave V3 che ci dice dove sono i soldi
  const AAVE_PROVIDER = "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb";
  // 2. L'indirizzo del token USDC (Native) su Arbitrum
  const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
  // 3. Un indirizzo ricco (Whale) a caso su Arbitrum per rubargli i soldi finti per le fee
  const WHALE_ADDRESS = "0x47c031236e19d024b42f8AE6780E44A573170703"; // Wintermute Trading

  it("Dovrebbe eseguire un Flash Loan con successo", async function () {
    // 1. Otteniamo il tuo account locale (finto)
    [owner] = await ethers.getSigners();

    // 2. Deploy del tuo contratto (Il Bot)
    console.log("Deploying contract...");
    const LiquidatorFactory = await ethers.getContractFactory("AaveLiquidator");
    liquidator = await LiquidatorFactory.deploy(AAVE_PROVIDER);
    await liquidator.waitForDeployment();
    const liquidatorAddress = await liquidator.getAddress();
    console.log("Bot deployed at:", liquidatorAddress);

    // --- AGGIUNTA FONDAMENTALE PER LA VERSIONE TURBO ---
    console.log("Setup: Approvazione token (One-time setup)...");
    await liquidator.approveToken(USDC_ADDRESS); 
    // ---------------------------------------------------

    // 3. Setup Token USDC
    const usdc = await ethers.getContractAt("IERC20", USDC_ADDRESS);

    // 4. IMPERSONIAMO LA BALENA
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [WHALE_ADDRESS],
    });

    // --- AGGIUNGI QUESTO BLOCCO QUI SOTTO ---
    // Regaliamo ETH finti alla Balena per pagare il gas della transazione
    await hre.network.provider.send("hardhat_setBalance", [
      WHALE_ADDRESS,
      "0x100000000000000000000", // Tanti ETH (in esadecimale)
    ]);
    // ----------------------------------------

    const whale = await ethers.getSigner(WHALE_ADDRESS);

    // 5. Finanziamo il Bot
    console.log("Finanziamento del bot per pagare le fee...");
    const amountToFund = ethers.parseUnits("100", 6); // 100 USDC (6 decimali)
    await usdc.connect(whale).transfer(liquidatorAddress, amountToFund);

    // Verifichiamo che i soldi siano arrivati
    const balanceBefore = await usdc.balanceOf(liquidatorAddress);
    console.log("Bilancio Bot Iniziale:", ethers.formatUnits(balanceBefore, 6), "USDC");

    // 6. ESECUZIONE FLASH LOAN
    // Chiediamo in prestito 1,000 USDC
    const loanAmount = ethers.parseUnits("1000", 6);
    
    // Chiamiamo la funzione del nostro contratto
    console.log("Richiesta Flash Loan TURBO in corso...");
    
    // Passiamo 4 argomenti: USDC, 1000, WETH (collaterale finto), WHALE (utente finto)
    const tx = await liquidator.requestFlashLoan(
        USDC_ADDRESS, 
        loanAmount, 
        WETH_ADDRESS, 
        WHALE_ADDRESS
    );
    await tx.wait();

    // 7. Verifica Finale
    // Se siamo arrivati qui senza errori, vuol dire che:
    // Preso prestito -> Restituito prestito + fee -> Tutto OK.
    const balanceAfter = await usdc.balanceOf(liquidatorAddress);
    console.log("Bilancio Bot Finale:", ethers.formatUnits(balanceAfter, 6), "USDC");

    // Il bilancio deve essere diminuito (perché abbiamo pagato la fee ad Aave)
    expect(balanceAfter).to.be.lt(balanceBefore);
    console.log("TEST SUPERATO! Il Flash Loan ha funzionato.");
  });
});