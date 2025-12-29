// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {FlashLoanSimpleReceiverBase} from "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IERC20} from "@aave/core-v3/contracts/dependencies/openzeppelin/contracts/IERC20.sol";

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

contract AaveLiquidator is FlashLoanSimpleReceiverBase {
    
    // INDIRIZZI HARDCODED (Risparmio gas: non dobbiamo leggerli dalla memoria)
    // Router Uniswap V3 su Arbitrum
    address constant UNISWAP_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address payable immutable owner;

    // --- OTTIMIZZAZIONE 1: CUSTOM ERRORS ---
    // Definiamo gli errori brevi per risparmiare gas sulle stringhe
    error NotOwner();       // 0x30cd7471
    error NotProfitable();  // 0xdeb5078d
    error SwapFailed();     // 0xbd16544b
    error LiquidationFailed(); // 0x...

    constructor(address _addressProvider) 
        FlashLoanSimpleReceiverBase(IPoolAddressesProvider(_addressProvider)) 
    {
        owner = payable(msg.sender);
    }

    // Funzione di Setup: Da chiamare una volta sola dopo il deploy
    // Serve a dare il permesso infinito a Uniswap e Aave di usare i nostri token
    function approveToken(address _token) external {
        if (msg.sender != owner) revert NotOwner();
        IERC20(_token).approve(address(POOL), type(uint256).max);
        IERC20(_token).approve(UNISWAP_ROUTER, type(uint256).max);
    }

    // Funzione di Start (quella che chiama la VPS)
    function requestFlashLoan(
        address _asset, 
        uint256 _amount,
        address _collateral,
        address _userToLiquidate
    ) external {
        // Nota: Non controlliamo l'owner qui per velocità. 
        // Se qualcuno chiama questa funzione per noi, ci fa un favore (paga lui il gas e noi teniamo il profitto).
        
        bytes memory params = abi.encode(_collateral, _userToLiquidate); 
        
        POOL.flashLoanSimple(
            address(this),
            _asset,
            _amount,
            params,
            0
        );
    }

    // Funzione Callback (Il cuore dell'operazione)
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address, // Initiator ignorato per risparmiare gas
        bytes calldata params
    ) external override returns (bool) {
        
        // 1. Decode ultra-rapido
        (address collateralAsset, address userToLiquidate) = abi.decode(params, (address, address));

        // 2. LIQUIDAZIONE (Try/Catch per non sprecare gas se fallisce)
        // Usiamo i permessi già dati con approveToken
        try POOL.liquidationCall(collateralAsset, asset, userToLiquidate, amount, false) {
            // Successo, procediamo
        } catch {
            revert LiquidationFailed();
        }

        // 3. SWAP SU UNISWAP
        uint256 collateralBalance = IERC20(collateralAsset).balanceOf(address(this));
        
        ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter.ExactInputSingleParams({
            tokenIn: collateralAsset,
            tokenOut: asset,
            fee: 3000, // Fee standard 0.3%
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: collateralBalance,
            // --- OTTIMIZZAZIONE 2: SLIPPAGE CHECK ---
            amountOutMinimum: 0, // Accettiamo tutto, controlliamo noi dopo (più economico)
            sqrtPriceLimitX96: 0
        });

        // Eseguiamo lo swap
        try ISwapRouter(UNISWAP_ROUTER).exactInputSingle(swapParams) returns (uint256 amountOut) {
            
            // 4. VERIFICA PROFITTO
            uint256 amountToReturn = amount + premium;
            
            // Se quello che abbiamo ottenuto è meno del debito -> REVERT
            // Questo annulla tutto come se non fosse mai successo
            if (amountOut < amountToReturn) {
                revert NotProfitable(); 
            }

            // Se siamo qui, abbiamo fatto profitto. 
            // Aave si prenderà automaticamente i suoi soldi (amountToReturn) alla fine della funzione.
            // Il resto rimane nel contratto.

        } catch {
            revert SwapFailed();
        }

        return true;
    }

    // Per prelevare i guadagni
    function withdraw(address _token) external {
        if (msg.sender != owner) revert NotOwner();
        IERC20(_token).transfer(owner, IERC20(_token).balanceOf(address(this)));
    }
    
    // Per ricevere ETH nativi (gas di scarto)
    receive() external payable {}
}