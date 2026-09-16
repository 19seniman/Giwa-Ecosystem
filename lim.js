require("dotenv").config();
const { ethers } = require("ethers");

// ==========================================
// 1. KONFIGURASI JARINGAN & WALLET
// ==========================================
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
    console.error("[FATAL ERROR] PRIVATE_KEY tidak ditemukan! Pastikan file .env sudah dibuat dan diisi.");
    process.exit(1);
}

const RPC_URL_SEPOLIA = "https://ethereum-sepolia-rpc.publicnode.com"; 
const RPC_URL_GIWA = "https://sepolia-rpc.giwa.io";

// ==========================================
// 2. KONFIGURASI SMART CONTRACT
// ==========================================
const L1_BRIDGE_ADDRESS = "0x956962c34687a954e611a83619abaa37ce6bc78a"; 
const ROUTER_ADDRESS = "0xad153c844ccac3d2ea991170624200e54730be74"; 
const TOKEN_OUT = "0x89B38c7414EC86Eb2cB003c6362cf010B562FF1e"; 

// ==========================================
// 3. PARAMETER AUTOMASI & PENGACAKAN (RANDOMNESS)
// ==========================================
const MIN_GIWA_BALANCE_ETH = "0.005"; 
const BRIDGE_AMOUNT_ETH = "0.01";     
const BRIDGE_WAIT_MS = 180000;        // 3 menit waktu tunggu bridge

const SLIPPAGE_PERCENTAGE = 5; 

// [UPDATE] Rentang Acak Swap (ETH)
const MIN_SWAP_AMOUNT = "0.0005"; 
const MAX_SWAP_AMOUNT = "0.0015"; 

// [UPDATE] Rentang Acak Delay antar swap (Milidetik)
const MIN_DELAY_MS = 45000; // 45 detik
const MAX_DELAY_MS = 90000; // 1.5 menit

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

// Helper: Acak Jumlah ETH
function getRandomAmount(min, max) {
    const minF = parseFloat(min);
    const maxF = parseFloat(max);
    return (Math.random() * (maxF - minF) + minF).toFixed(5);
}

// Helper: Acak Waktu (ms)
function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ==========================================
// 5. FUNGSI BRIDGE (SEPOLIA -> GIWA)
// ==========================================
async function bridgeEthToGiwa(amountEth) {
    try {
        console.log(`\n[BRIDGE] Memulai bridge ${amountEth} ETH dari Sepolia ke Giwa...`);
        const amountInWei = ethers.parseEther(amountEth.toString());
        
        console.log(`[BRIDGE] Mengirim transaksi ke jaringan Sepolia L1...`);
        const tx = await bridgeContract.depositETH(200000, "0x", { value: amountInWei });

        console.log(`[WAIT] Transaksi bridge L1 terkirim. Hash: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`[SUCCESS] Bridge L1 terkonfirmasi di Block: ${receipt.blockNumber}`);
        console.log(`[WAIT] Menunggu ~${BRIDGE_WAIT_MS / 60000} menit agar ETH mendarat di jaringan Giwa L2...`);
        
        await sleep(BRIDGE_WAIT_MS);
        return true;
    } catch (error) {
        console.error("[ERROR] Gagal eksekusi bridge:", error.reason || error.message);
        return false;
    }
}

// ==========================================
// 6. FUNGSI SWAP (GIWA DEX)
// ==========================================
async function swapEthForToken(ethAmount, currentNonce) {
    try {
        console.log(`[INFO] Eksekusi swap ${ethAmount} ETH ke INSDR... (Nonce: ${currentNonce})`);

        const amountIn = ethers.parseEther(ethAmount.toString());
        const wethAddress = await routerContract.WETH();
        const path = [wethAddress, TOKEN_OUT];
        
        const amountsOut = await routerContract.getAmountsOut(amountIn, path);
        const expectedTokenOut = amountsOut[1]; 
        
        const slippage = BigInt(SLIPPAGE_PERCENTAGE);
        const amountOutMin = (expectedTokenOut * (100n - slippage)) / 100n;

        const to = walletGiwa.address;
        const deadline = Math.floor(Date.now() / 1000) + (60 * 5);

        const tx = await routerContract.swapExactETHForTokens(
            amountOutMin, path, to, deadline,
            { value: amountIn, nonce: currentNonce }
        );

        console.log(`[WAIT] Transaksi Swap di-broadcast. Hash: ${tx.hash}`);
        await tx.wait();
        console.log(`[SUCCESS] Swap Berhasil!\n`);

        return true;
    } catch (error) {
        console.error("[ERROR] Gagal eksekusi swap:", error.reason || error.message);
        return false;
    }
}

// ==========================================
// 7. CORE AUTOMATION LOOP
// ==========================================
async function startAutoBot() {
    console.log(`\n=== MEMULAI BOT AUTO BRIDGE & SWAP GIWA (ANTI-SYBIL MODE) ===`);
    console.log(`Wallet       : ${walletGiwa.address}`);
    console.log(`Swap Amount  : Random antara ${MIN_SWAP_AMOUNT} - ${MAX_SWAP_AMOUNT} ETH`);
    console.log(`Delay Swap   : Random antara ${MIN_DELAY_MS/1000} - ${MAX_DELAY_MS/1000} detik\n`);
    
    let counter = 1;
    let nonce = await providerGiwa.getTransactionCount(walletGiwa.address, "latest");
    const minBalanceWei = ethers.parseEther(MIN_GIWA_BALANCE_ETH);

    while (true) {
        console.log(`--- ITERASI KE-${counter} ---`);
        
        const currentBalance = await providerGiwa.getBalance(walletGiwa.address);
        console.log(`[SALDO] Saldo Giwa saat ini: ${ethers.formatEther(currentBalance)} ETH`);

        if (currentBalance < minBalanceWei) {
            console.log(`[ALERT] Saldo di bawah batas minimum (${MIN_GIWA_BALANCE_ETH} ETH). Memicu Auto-Bridge!`);
            const bridgeSuccess = await bridgeEthToGiwa(BRIDGE_AMOUNT_ETH);
            
            if (bridgeSuccess) {
                nonce = await providerGiwa.getTransactionCount(walletGiwa.address, "latest");
                console.log(`[SALDO] Mengecek ulang saldo Giwa setelah bridge...`);
                continue; 
            } else {
                console.log(`[WARNING] Bridge gagal, jeda sebentar sebelum mencoba lagi...`);
                await sleep(60000); // Tunggu 1 menit jika bridge error
                continue;
            }
        }
        
        // [UPDATE] Generate angka acak untuk swap iterasi ini
        const currentSwapAmount = getRandomAmount(MIN_SWAP_AMOUNT, MAX_SWAP_AMOUNT);
        const swapSuccess = await swapEthForToken(currentSwapAmount, nonce);
        
        if (swapSuccess) {
            nonce++; 
        } else {
            nonce = await providerGiwa.getTransactionCount(walletGiwa.address, "latest");
        }
        
        // [UPDATE] Generate jeda waktu acak untuk iterasi ini
        const currentDelayMs = getRandomDelay(MIN_DELAY_MS, MAX_DELAY_MS);
        console.log(`[WAIT] Anti-Bot Cooldown: Menunggu ${currentDelayMs / 1000} detik...\n`);
        
        await sleep(currentDelayMs);
        counter++;
    }
}

startAutoBot();
