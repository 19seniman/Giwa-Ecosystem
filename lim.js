require("dotenv").config();
const { ethers } = require("ethers");
const readline = require("readline");

// ==========================================
// 1. KONFIGURASI JARINGAN & WALLET
// ==========================================
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
    console.error("[FATAL ERROR] PRIVATE_KEY not found! Please check your .env file.");
    process.exit(1);
}

const RPC_URL_SEPOLIA = "https://ethereum-sepolia-rpc.publicnode.com"; 
const RPC_URL_GIWA = "https://sepolia-rpc.giwa.io";

// ==========================================
// 2. KONFIGURASI SMART CONTRACT
// ==========================================
const L1_BRIDGE_ADDRESS = "0x956962c34687a954e611a83619abaa37ce6bc78a"; 
const ROUTER_ADDRESS = "0xad153c844ccac3d2ea991170624200e54730be74"; 
const TOKEN_OUT = "0x89B38c7414EC86Eb2cB003c6362cf010B562FF1e"; // INSDR Token

// ==========================================
// 3. PARAMETER AUTOMASI & PENGACAKAN
// ==========================================
// Parameter Swap
const MIN_SWAP_AMOUNT = "0.0005"; 
const MAX_SWAP_AMOUNT = "0.0015"; 
const MIN_SWAP_DELAY_MS = 45000; // 45 detik
const MAX_SWAP_DELAY_MS = 90000; // 1.5 menit
const SLIPPAGE_PERCENTAGE = 5; 

// Parameter Bridge
const MIN_BRIDGE_AMOUNT = "0.01"; 
const MAX_BRIDGE_AMOUNT = "0.02";
const BRIDGE_WAIT_MS = 180000; // 3 Menit waktu tunggu setelah bridge

// ==========================================
// 4. SETUP PROVIDER & WALLET
// ==========================================
const providerSepolia = new ethers.JsonRpcProvider(RPC_URL_SEPOLIA);
const providerGiwa = new ethers.JsonRpcProvider(RPC_URL_GIWA);

const walletSepolia = new ethers.Wallet(PRIVATE_KEY, providerSepolia);
const walletGiwa = new ethers.Wallet(PRIVATE_KEY, providerGiwa);

const bridgeAbi = ["function depositETH(uint32 _minGasLimit, bytes calldata _extraData) external payable"];
const bridgeContract = new ethers.Contract(L1_BRIDGE_ADDRESS, bridgeAbi, walletSepolia);

const routerAbi = [
    "function WETH() external pure returns (address)",
    "function getAmountsOut(uint amountIn, address[] memory path) external view returns (uint[] memory amounts)",
    "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)"
];
const routerContract = new ethers.Contract(ROUTER_ADDRESS, routerAbi, walletGiwa);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getRandomAmount(min, max) {
    const minF = parseFloat(min);
    const maxF = parseFloat(max);
    return (Math.random() * (maxF - minF) + minF).toFixed(5);
}

function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ==========================================
// 5. MODUL 1: FUNGSI BRIDGE
// ==========================================
async function bridgeEthToGiwa(amountEth) {
    try {
        console.log(`\n[BRIDGE] Starting bridge ${amountEth} ETH from Sepolia to Giwa...`);
        const amountInWei = ethers.parseEther(amountEth.toString());
        
        console.log(`[BRIDGE] Sending transaction to Sepolia L1...`);
        const tx = await bridgeContract.depositETH(200000, "0x", { value: amountInWei });

        console.log(`[WAIT] L1 Bridge TX sent. Hash: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`[SUCCESS] Bridge L1 Confirmed at Block: ${receipt.blockNumber}`);
        console.log(`[WAIT] Waiting ~${BRIDGE_WAIT_MS / 60000} minutes for ETH to arrive on Giwa L2...\n`);
        
        await sleep(BRIDGE_WAIT_MS);
        return true;
    } catch (error) {
        console.error("[ERROR] Bridge failed:", error.reason || error.message);
        return false;
    }
}

async function startAutoBridge() {
    console.log(`\n=== 🚀 STARTING AUTO BRIDGE MODULE ===`);
    let counter = 1;

    while (true) {
        console.log(`--- BRIDGE ITERATION #${counter} ---`);
        const currentBridgeAmount = getRandomAmount(MIN_BRIDGE_AMOUNT, MAX_BRIDGE_AMOUNT);
        await bridgeEthToGiwa(currentBridgeAmount);
        counter++;
    }
}

// ==========================================
// 6. MODUL 2: FUNGSI SWAP
// ==========================================
async function swapEthForToken(ethAmount, currentNonce) {
    try {
        console.log(`[INFO] Executing swap ${ethAmount} ETH to INSDR... (Nonce: ${currentNonce})`);

        const amountIn = ethers.parseEther(ethAmount.toString());
        const wethAddress = await routerContract.WETH();
        const path = [wethAddress, TOKEN_OUT];
        
        let expectedTokenOut;
        try {
            const amountsOut = await routerContract.getAmountsOut(amountIn, path);
            expectedTokenOut = amountsOut[1]; 
        } catch (priceError) {
            console.log(`[WARNING] Failed to fetch price. The Liquidity Pool (ETH-INSDR) might be empty or token address is wrong.`);
            return false;
        }
        
        const slippage = BigInt(SLIPPAGE_PERCENTAGE);
        const amountOutMin = (expectedTokenOut * (100n - slippage)) / 100n;

        const to = walletGiwa.address;
        const deadline = Math.floor(Date.now() / 1000) + (60 * 5);

        const tx = await routerContract.swapExactETHForTokens(
            amountOutMin, path, to, deadline,
            { value: amountIn, nonce: currentNonce }
        );

        console.log(`[WAIT] Swap TX broadcasted. Hash: ${tx.hash}`);
        await tx.wait();
        console.log(`[SUCCESS] Swap Successful!\n`);

        return true;
    } catch (error) {
        console.error("[ERROR] Swap failed:", error.reason || "Connection/RPC Issue");
        return false;
    }
}

async function startAutoSwap() {
    console.log(`\n=== 🚀 STARTING AUTO SWAP MODULE ===`);
    console.log(`Wallet       : ${walletGiwa.address}`);
    console.log(`Swap Amount  : Random between ${MIN_SWAP_AMOUNT} - ${MAX_SWAP_AMOUNT} ETH`);
    
    let counter = 1;
    let nonce = await providerGiwa.getTransactionCount(walletGiwa.address, "latest");

    while (true) {
        console.log(`--- SWAP ITERATION #${counter} ---`);
        
        const currentBalance = await providerGiwa.getBalance(walletGiwa.address);
        console.log(`[BALANCE] Current Giwa Balance: ${ethers.formatEther(currentBalance)} ETH`);

        // Hentikan jika saldo kurang dari jumlah swap
        if (currentBalance < ethers.parseEther(MAX_SWAP_AMOUNT)) {
            console.log(`[ALERT] Insufficient balance for swap! Please bridge some ETH first.`);
            process.exit(0);
        }
        
        const currentSwapAmount = getRandomAmount(MIN_SWAP_AMOUNT, MAX_SWAP_AMOUNT);
        const swapSuccess = await swapEthForToken(currentSwapAmount, nonce);
        
        if (swapSuccess) {
            nonce++; 
        } else {
            nonce = await providerGiwa.getTransactionCount(walletGiwa.address, "latest");
        }
        
        const currentDelayMs = getRandomDelay(MIN_SWAP_DELAY_MS, MAX_SWAP_DELAY_MS);
        console.log(`[WAIT] Anti-Bot Cooldown: Waiting for ${currentDelayMs / 1000} seconds...\n`);
        
        await sleep(currentDelayMs);
        counter++;
    }
}

// ==========================================
// 7. MENU INTERAKTIF CLI
// ==========================================
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function showMenu() {
    console.log(`\n==============================================`);
    console.log(`🤖 GIWA TESTNET AUTOMATION BOT`);
    console.log(`==============================================`);
    console.log(`🌐 Choose the on-chain interaction you want to run:\n`);
    console.log(`   1. Bridge Sepolia 🔁 Giwa Testnet`);
    console.log(`   2. Swap ETH 🔁 Token (Giwa DEX)\n`);
    
    rl.question(`👉 Enter your choice (1 or 2): `, async (choice) => {
        if (choice === '1') {
            rl.close();
            await startAutoBridge();
        } else if (choice === '2') {
            rl.close();
            await startAutoSwap();
        } else {
            console.log(`❌ Invalid choice. Please enter 1 or 2.`);
            rl.close();
            process.exit(0);
        }
    });
}

// Jalankan Menu
showMenu();
