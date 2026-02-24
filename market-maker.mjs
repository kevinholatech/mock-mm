/**
 * Mock Market Maker — Standalone Node.js script
 *
 * Yêu cầu: Node.js >= 18 (không cần install thêm package nào)
 * Chạy:    node scripts/market-maker.mjs
 *
 * Config qua file scripts/.env (copy từ scripts/.env.example)
 */

import { readFileSync, existsSync } from "node:fs";
import { createPrivateKey, sign as nodeSign } from "node:crypto";

// ─── Load .env ──────────────────────────────────────────────
function loadEnv(path) {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq === -1) continue;
        const k = t.slice(0, eq).trim();
        let v = t.slice(eq + 1).trim();
        // Strip inline comments (e.g. VALUE=foo  # comment → foo)
        const commentIdx = v.search(/\s+#/);
        if (commentIdx !== -1) v = v.slice(0, commentIdx).trim();
        // Strip surrounding quotes
        v = v.replace(/^["']|["']$/g, "");
        if (!(k in process.env)) process.env[k] = v;
    }
}
loadEnv(new URL(".env", import.meta.url).pathname);

// ─── Config ─────────────────────────────────────────────────
const BACKEND_URL = (process.env.BACKEND_URL ?? "http://47.243.220.53:3000").replace(/\/$/, "");
const API_KEY = process.env.API_KEY ?? "";
const PRIV_HEX = process.env.PRIVATE_KEY_HEX ?? ""; // 64-char hex (32 bytes seed)

const LEVELS = parseInt(process.env.LEVELS ?? "5", 10);  // order book depth levels per side
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS ?? "30000", 10);
const MAX_ERRORS = parseInt(process.env.MAX_ERRORS ?? "5", 10);

// Telegram alert (optional)
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

const SPREAD = parseFloat(process.env.SPREAD ?? "0.001");
let PAIRS = [
    { symbol: "BTC-USDC", productId: 2, spread: SPREAD, quantity: 0.0123 },
    { symbol: "ETH-USDC", productId: 4, spread: SPREAD, quantity: 0.2 },
    { symbol: "SOL-USDC", productId: 6, spread: SPREAD, quantity: 1.5 },
    { symbol: "0G-USDC",  productId: 8, spread: SPREAD, quantity: 100 }
];

if (process.env.PAIRS_JSON) {
    try {
        PAIRS = JSON.parse(process.env.PAIRS_JSON);
    } catch(e) {
        console.error("❌ Invalid PAIRS_JSON");
        process.exit(1);
    }
}

// ─── Symbols formatting helper ──────────────────────────────
function getSymbols(symbolStr) {
    const backendSymbol = symbolStr.includes("-")
        ? symbolStr.replace("-", "") + "PERP"
        : symbolStr.replace("/", "");
    
    // Binance doesn't have 0GUSDC, so this only matters for standard pairs
    const binanceSymbol = backendSymbol.replace(/PERP$/, "").replace(/USDC$/, "USDT");
    return { backend: backendSymbol, binance: binanceSymbol };
}

// ─── Validate ───────────────────────────────────────────────
if (!API_KEY) { console.error("❌ API_KEY missing"); process.exit(1); }
if (PRIV_HEX.length !== 64) { console.error("❌ PRIVATE_KEY_HEX must be 64 hex chars"); process.exit(1); }

// ─── Signing (node:crypto — synchronous, no external deps) ──
const PKCS8_HEADER = Buffer.from("302e020100300506032b657004220420", "hex");

let _privateKey = null;
function getPrivateKey() {
    if (!_privateKey) {
        const seed = Buffer.from(PRIV_HEX, "hex");
        const pkcs8 = Buffer.concat([PKCS8_HEADER, seed]);
        _privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
    }
    return _privateKey;
}

function sign(message) {
    const sig = nodeSign(null, Buffer.from(message, "utf8"), getPrivateKey());
    return sig.toString("base64");
}

function buildQS(params) {
    return Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
}

function signedBody(params) {
    const qs = buildQS({ ...params, timestamp: Date.now() });
    const sig = sign(qs);
    return `${qs}&signature=${encodeURIComponent(sig)}`;
}

// ─── API helpers ─────────────────────────────────────────────
async function api(path, opts = {}) {    
    return fetch(`${BACKEND_URL}${path}`, opts);
}

async function placeOrder(pair, side, type, timeInForce, price, qty) {
    const { backend } = getSymbols(pair.symbol);
    const params = { productId: pair.productId, quantity: qty ?? pair.quantity, side, symbol: backend, type };
    if (timeInForce) params.timeInForce = timeInForce;
    if (price) params.price = price;
    const body = signedBody(params);
    const res = await api("/fapi/v1/order", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "x-api-key": API_KEY },
        body,
    });
    if (!res.ok) {
        const text = await res.text();
        if (res.status === 401) {
            const msg = "❌ API key expired (401). Update API_KEY in .env and restart manually.";
            console.error("\n" + msg);
            await sendTelegram(msg);
            process.exit(0);
        }
        throw new Error(`${side} ${type} failed [${res.status}]: ${text}`);
    }
}

// ─── Telegram alert ──────────────────────────────────────────
function nowStr() {
    return new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
}

async function sendTelegram(msg) {
    if (!TG_TOKEN || !TG_CHAT_ID) return;
    try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: TG_CHAT_ID, text: `[Market Maker] ${nowStr()}\n${msg}` }),
        });
    } catch { /* ignore Telegram errors */ }
}

// ─── Cycle ───────────────────────────────────────────────────
let cycleCount = 0;
const pairStates = {};
PAIRS.forEach(p => pairStates[p.symbol] = { consecutiveErrors: 0 });

async function cycleForPair(pair) {
    const { backend, binance } = getSymbols(pair.symbol);
    const state = pairStates[pair.symbol];

    try {
        let markPrice;
        process.stdout.write(`  [${pair.symbol}] Mark price... `);
        
        if (pair.symbol === "0G-USDC") {
            // Fake or fetch backend markPrice for 0G since it's not on Binance
            const beRes = await fetch(`${BACKEND_URL}/fapi/v1/premiumIndex?symbol=${backend}`);
            if (beRes.ok) {
                const data = await beRes.json();
                const item = Array.isArray(data) ? data[0] : data;
                if (item && item.markPrice) markPrice = parseFloat(item.markPrice);
            }
            if (!markPrice) markPrice = 0.04; // fallback fake price if missing
        } else {
            const binanceRes = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${binance}`);
            if (!binanceRes.ok) throw new Error(`Binance API: ${binanceRes.status}`);
            const binanceData = await binanceRes.json();
            markPrice = parseFloat(binanceData.markPrice);
        }
        
        if (!markPrice) throw new Error(`Invalid markPrice for ${pair.symbol}`);
        console.log(`$${markPrice.toFixed(4)}`);

        // Cancel
        process.stdout.write(`  [${pair.symbol}] Cancel orders... `);
        const cancelBody = signedBody({ symbol: backend });
        const cancelRes = await api("/fapi/v1/openOrders", {
            method: "DELETE",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "x-api-key": API_KEY },
            body: cancelBody,
        });
        console.log(cancelRes.ok ? "done" : `skipped (${cancelRes.status})`);

        // BID levels
        for (let i = 1; i <= LEVELS; i++) {
            const bid = (markPrice * (1 - pair.spread * i)).toFixed(4); // 4 decimals
            const qty = (parseFloat(pair.quantity) * (1 + (i - 1) * 0.5)).toFixed(4);
            process.stdout.write(`  [${pair.symbol}] BID[${i}] @ ${bid} qty:${qty}... `);
            await placeOrder(pair, "BUY", "LIMIT", "GTC", bid, qty);
            console.log("placed");
        }

        // ASK levels
        for (let i = 1; i <= LEVELS; i++) {
            const ask = (markPrice * (1 + pair.spread * i)).toFixed(4);
            const qty = (parseFloat(pair.quantity) * (1 + (i - 1) * 0.5)).toFixed(4);
            process.stdout.write(`  [${pair.symbol}] ASK[${i}] @ ${ask} qty:${qty}... `);
            await placeOrder(pair, "SELL", "LIMIT", "GTC", ask, qty);
            console.log("placed");
        }

        // Match
        const mpStr = markPrice.toFixed(4);
        process.stdout.write(`  [${pair.symbol}] Match BUY  @ ${mpStr} (GTC)... `);
        await placeOrder(pair, "BUY", "LIMIT", "GTC", mpStr, pair.quantity);
        console.log("placed");

        process.stdout.write(`  [${pair.symbol}] Match SELL @ ${mpStr} (GTC)... `);
        await placeOrder(pair, "SELL", "LIMIT", "GTC", mpStr, pair.quantity);
        console.log("placed");

        state.consecutiveErrors = 0; // reset on success
    } catch (err) {
        state.consecutiveErrors++;
        const msg = `[${pair.symbol}] Cycle #${cycleCount} error (${state.consecutiveErrors}/${MAX_ERRORS}): ${err.message}`;
        console.error(`  ✗ ${msg}`);
        await sendTelegram(`⚠️ ${msg}`);

        if (state.consecutiveErrors >= MAX_ERRORS) {
            const fatal = `[${pair.symbol}] Stopping after ${MAX_ERRORS} errors. Last: ${err.message}`;
            console.error(`\n❌ ${fatal}`);
            await sendTelegram(`🛑 ${fatal}`);
            clearInterval(timer);
            process.exit(1);
        }
    }
}

async function cycleAll() {
    cycleCount++;
    const timeStr = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
    console.log(`\n[Cycle #${cycleCount}] ${timeStr}`);
    
    // Chạy song song từng đôi, wait all finish
    await Promise.allSettled(PAIRS.map(cycleForPair));
    console.log(`  ✓ All pairs finished. Next in ${INTERVAL_MS / 1000}s`);
}

// ─── Start ──────────────────────────────────────────────────
console.log("=".repeat(50));
console.log("  Mock Market Maker (Multi-Pairs)");
console.log("=".repeat(50));
console.log(`  Backend  : ${BACKEND_URL}`);
console.log(`  Pairs    : ${PAIRS.map(p => p.symbol).join(", ")}`);
console.log(`  Interval : ${INTERVAL_MS / 1000}s`);
console.log(`  Max errors: ${MAX_ERRORS}  |  Telegram: ${TG_TOKEN ? "✓" : "✗"}`);
console.log("=".repeat(50));
console.log("Ctrl+C to stop\n");

// Verify signing works before starting
try {
    sign("test");
    console.log("✓ Signing OK\n");
} catch (err) {
    console.error("❌ Signing failed:", err.message);
    process.exit(1);
}

let timer;
await cycleAll();
timer = setInterval(cycleAll, INTERVAL_MS);

process.on("SIGINT", () => { clearInterval(timer); console.log("\nStopped."); process.exit(0); });
