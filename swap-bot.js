require("dotenv").config();
const { ethers } = require("ethers");

// ---------- Konfigurasi dari .env ----------
const RPC_URL = process.env.RPC_URL || "https://sepolia-rpc.giwa.io";
const CHAIN_ID = Number(process.env.CHAIN_ID || 91342);
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS;
let WETH_ADDRESS = process.env.WETH_ADDRESS || ""; // opsional, bisa auto-resolve dari router.WETH()
const TOKEN_OUT_ADDRESS = process.env.TOKEN_OUT_ADDRESS;

const AMOUNT_ETH_IN = process.env.AMOUNT_ETH_IN || "0.01";
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 100); // 100 bps = 1%
const DEADLINE_MINUTES = Number(process.env.DEADLINE_MINUTES || 10);

// ---------- ABI minimal (Uniswap V2 Router02-style) ----------
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
  "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)",
  "function WETH() external pure returns (address)",
];

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
];

function assertConfig() {
  const missing = [];
  if (!PRIVATE_KEY) missing.push("PRIVATE_KEY");
  if (!ROUTER_ADDRESS || ROUTER_ADDRESS.includes("ISI_")) missing.push("ROUTER_ADDRESS");
  if (!TOKEN_OUT_ADDRESS || TOKEN_OUT_ADDRESS.includes("ISI_")) missing.push("TOKEN_OUT_ADDRESS");

  if (missing.length > 0) {
    console.error(
      `\n❌ Konfigurasi belum lengkap di .env, isi dulu: ${missing.join(", ")}\n` +
        `   Cari alamat contract-nya di GIWA Sepolia Explorer (sepolia-explorer.giwa.io)\n` +
        `   pada tab "Verified Contracts", atau dari DevTools saat swap manual di giwa-bit.vercel.app.\n`
    );
    process.exit(1);
  }

  // Validasi format checksum alamat supaya typo langsung ketahuan sebelum kirim tx.
  const toCheck = [
    ["ROUTER_ADDRESS", ROUTER_ADDRESS],
    ["TOKEN_OUT_ADDRESS", TOKEN_OUT_ADDRESS],
  ];
  if (WETH_ADDRESS) toCheck.push(["WETH_ADDRESS", WETH_ADDRESS]);

  for (const [label, addr] of toCheck) {
    try {
      ethers.getAddress(addr);
    } catch {
      console.error(`❌ ${label} bukan alamat Ethereum yang valid: ${addr}`);
      process.exit(1);
    }
  }
}

// Kalau WETH_ADDRESS tidak diisi manual, ambil otomatis dari router.WETH()
// (fungsi standar pada router bergaya Uniswap V2).
async function resolveWethAddress(provider) {
  if (WETH_ADDRESS) return WETH_ADDRESS;

  const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);
  try {
    const weth = await router.WETH();
    console.log(`ℹ️  WETH_ADDRESS otomatis terdeteksi dari router: ${weth}`);
    WETH_ADDRESS = weth;
    return weth;
  } catch (err) {
    console.error(
      "\n❌ Gagal mengambil alamat WETH otomatis dari router.WETH().\n" +
        "   Kemungkinan router ini bukan router bergaya Uniswap V2 standar,\n" +
        "   atau menggunakan nama fungsi lain (misalnya WNATIVE(), wnative(), dll).\n" +
        "   Silakan isi WETH_ADDRESS secara manual di .env.\n"
    );
    process.exit(1);
  }
}

async function assertIsContract(provider, label, address) {
  const code = await provider.getCode(address);
  if (!code || code === "0x") {
    console.error(
      `\n❌ ${label} (${address}) tidak memiliki bytecode contract di GIWA Sepolia.\n` +
        `   Cek ulang alamatnya di https://sepolia-explorer.giwa.io/address/${address}\n`
    );
    process.exit(1);
  }
}

async function getProviderAndSigner() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  return { provider, wallet };
}

async function getQuote(provider) {
  const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);
  const tokenOut = new ethers.Contract(TOKEN_OUT_ADDRESS, ERC20_ABI, provider);

  const amountIn = ethers.parseEther(AMOUNT_ETH_IN);
  const path = [WETH_ADDRESS, TOKEN_OUT_ADDRESS];

  const [amounts, symbol, decimals] = await Promise.all([
    router.getAmountsOut(amountIn, path),
    tokenOut.symbol().catch(() => "TOKEN"),
    tokenOut.decimals().catch(() => 18),
  ]);

  const amountOut = amounts[amounts.length - 1];
  const amountOutMin =
    (amountOut * BigInt(10000 - SLIPPAGE_BPS)) / BigInt(10000);

  return { amountIn, amountOut, amountOutMin, symbol, decimals, path };
}

async function runQuote() {
  assertConfig();
  const { provider } = await getProviderAndSigner();
  await assertIsContract(provider, "ROUTER_ADDRESS", ROUTER_ADDRESS);
  await assertIsContract(provider, "TOKEN_OUT_ADDRESS", TOKEN_OUT_ADDRESS);
  await resolveWethAddress(provider);
  const { amountIn, amountOut, amountOutMin, symbol, decimals } =
    await getQuote(provider);

  console.log("=== Estimasi Swap (belum kirim transaksi) ===");
  console.log(`Input   : ${ethers.formatEther(amountIn)} ETH`);
  console.log(`Output  : ${ethers.formatUnits(amountOut, decimals)} ${symbol}`);
  console.log(
    `Min out (slippage ${SLIPPAGE_BPS / 100}%): ${ethers.formatUnits(
      amountOutMin,
      decimals
    )} ${symbol}`
  );
}

async function runSwap() {
  assertConfig();
  const { provider, wallet } = await getProviderAndSigner();
  await assertIsContract(provider, "ROUTER_ADDRESS", ROUTER_ADDRESS);
  await assertIsContract(provider, "TOKEN_OUT_ADDRESS", TOKEN_OUT_ADDRESS);
  await resolveWethAddress(provider);

  const ethBalance = await provider.getBalance(wallet.address);
  console.log(`Wallet  : ${wallet.address}`);
  console.log(`Saldo ETH: ${ethers.formatEther(ethBalance)} ETH`);

  const { amountIn, amountOut, amountOutMin, symbol, decimals, path } =
    await getQuote(provider);

  if (ethBalance < amountIn) {
    console.error("❌ Saldo ETH tidak cukup untuk swap ini.");
    process.exit(1);
  }

  console.log("\n=== Detail Swap ===");
  console.log(`Swap    : ${ethers.formatEther(amountIn)} ETH -> ${symbol}`);
  console.log(`Estimasi output : ${ethers.formatUnits(amountOut, decimals)} ${symbol}`);
  console.log(
    `Minimum diterima (slippage ${SLIPPAGE_BPS / 100}%): ${ethers.formatUnits(
      amountOutMin,
      decimals
    )} ${symbol}`
  );

  const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_MINUTES * 60;

  console.log("\nMengirim transaksi swap...");
  const tx = await router.swapExactETHForTokens(
    amountOutMin,
    path,
    wallet.address,
    deadline,
    { value: amountIn }
  );

  console.log(`Tx terkirim: ${tx.hash}`);
  console.log("Menunggu konfirmasi...");
  const receipt = await tx.wait();

  console.log(`\n✅ Swap berhasil di block ${receipt.blockNumber}`);
  console.log(`Explorer: https://sepolia-explorer.giwa.io/tx/${tx.hash}`);
}

async function main() {
  const mode = process.argv[2];

  if (mode === "quote") {
    await runQuote();
  } else if (mode === "swap") {
    await runSwap();
  } else {
    console.log("Gunakan salah satu perintah berikut:");
    console.log("  node swap-bot.js quote   # cek estimasi harga, tanpa kirim tx");
    console.log("  node swap-bot.js swap    # eksekusi swap sungguhan");
  }
}

main().catch((err) => {
  console.error("\n❌ Terjadi error:", err.message || err);
  process.exit(1);
});
