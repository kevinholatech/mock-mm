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

const SYMBOL = process.env.SYMBOL ?? "BTC-USDC";
const PRODUCT_ID = process.env.PRODUCT_ID ?? "2";
const SPREAD = parseFloat(process.env.SPREAD ?? "0.001");
const QUANTITY = process.env.QUANTITY ?? "0.01";
const LEVELS = parseInt(process.env.LEVELS ?? "5", 10);  // order book depth levels per side
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS ?? "30000", 10);
const MAX_ERRORS = parseInt(process.env.MAX_ERRORS ?? "5", 10);

// Telegram alert (optional)
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

// ─── Validate ───────────────────────────────────────────────
if (!API_KEY) { console.error("❌ API_KEY missing"); process.exit(1); }
if (PRIV_HEX.length !== 64) { console.error("❌ PRIVATE_KEY_HEX must be 64 hex chars"); process.exit(1); }

// ─── Symbol conversion ──────────────────────────────────────
const BACKEND_SYMBOL = SYMBOL.includes("-")
    ? SYMBOL.replace("-", "") + "PERP"   // BTC-USDC → BTCUSDCPERP
    : SYMBOL.replace("/", "");           // BTC/USDC → BTCUSDC

// Binance Futures uses USDT pairs (BTCUSDCPERP → BTCUSDT)
const BINANCE_SYMBOL = BACKEND_SYMBOL
    .replace(/PERP$/, "")    // remove PERP suffix
    .replace(/USDC$/, "USDT"); // USDC → USDT

// ─── Signing (node:crypto — synchronous, no external deps) ──
// Ed25519 PKCS8 DER header: wraps the raw 32-byte seed
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

// ─── Query string helpers ────────────────────────────────────
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

function signedQS(params) {
    const qs = buildQS({ ...params, timestamp: Date.now() });
    const sig = sign(qs);
    return `${qs}&signature=${encodeURIComponent(sig)}`;
}

// ─── API helpers ─────────────────────────────────────────────
async function api(path, opts = {}) {
    return fetch(`${BACKEND_URL}${path}`, opts);
}

async function placeOrder(side, type, timeInForce, price, qty = QUANTITY) {
    const params = { productId: PRODUCT_ID, quantity: qty, side, symbol: BACKEND_SYMBOL, type };
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
        // 401 = API key expired — exit gracefully (PM2 should NOT restart)
        if (res.status === 401) {
            const msg = "❌ API key expired (401). Update API_KEY in .env and restart manually.";
            console.error("\n" + msg);
            await sendTelegram(msg);
            process.exit(0); // exit(0) = PM2 won't auto-restart
        }
        throw new Error(`${side} ${type} failed [${res.status}]: ${text}`);
    }
}

// ─── Telegram alert ──────────────────────────────────────────
async function sendTelegram(msg) {
    if (!TG_TOKEN || !TG_CHAT_ID) return;
    try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: TG_CHAT_ID, text: `[Market Maker] ${msg}` }),
        });
    } catch { /* ignore Telegram errors */ }
}

// ─── Cycle ───────────────────────────────────────────────────
let cycleCount = 0;
let consecutiveErrors = 0;

async function cycle() {
    cycleCount++;
    console.log(`\n[Cycle #${cycleCount}] ${new Date().toISOString()}`);
    try {
        // 1. Mark price — from Binance Futures API (real market price)
        //    Backend testnet returns hardcoded 100000, not real price
        process.stdout.write("  1. Mark price (Binance)... ");
        const binanceRes = await fetch(
            `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${BINANCE_SYMBOL}`
        );
        if (!binanceRes.ok) throw new Error(`Binance API: ${binanceRes.status} ${binanceRes.statusText}`);
        const binanceData = await binanceRes.json();
        const markPrice = parseFloat(binanceData.markPrice);
        if (!markPrice) throw new Error(`Invalid Binance markPrice: ${JSON.stringify(binanceData)}`);
        console.log(`$${markPrice.toFixed(2)}`);

        // 2. Cancel all open orders (params in BODY, not URL)
        process.stdout.write("  2. Cancel orders... ");
        const cancelBody = signedBody({ symbol: BACKEND_SYMBOL });
        const cancelRes = await api("/fapi/v1/openOrders", {
            method: "DELETE",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "x-api-key": API_KEY },
            body: cancelBody,
        });
        console.log(cancelRes.ok ? "done" : `skipped (${cancelRes.status})`);

        // 3. BID levels (5 levels: mark × (1 - spread×i))
        for (let i = 1; i <= LEVELS; i++) {
            const bid = (markPrice * (1 - SPREAD * i)).toFixed(2);
            const qty = (parseFloat(QUANTITY) * (1 + (i - 1) * 0.5)).toFixed(4); // deeper = more qty
            process.stdout.write(`  BID[${i}] @ ${bid} qty:${qty}... `);
            await placeOrder("BUY", "LIMIT", "GTC", bid, qty);
            console.log("placed");
        }

        // 4. ASK levels (5 levels: mark × (1 + spread×i))
        for (let i = 1; i <= LEVELS; i++) {
            const ask = (markPrice * (1 + SPREAD * i)).toFixed(2);
            const qty = (parseFloat(QUANTITY) * (1 + (i - 1) * 0.5)).toFixed(4);
            process.stdout.write(`  ASK[${i}] @ ${ask} qty:${qty}... `);
            await placeOrder("SELL", "LIMIT", "GTC", ask, qty);
            console.log("placed");
        }

        // 5. Match: limit BUY @ mark price (GTC — will cross)
        const mp = markPrice.toFixed(2);
        process.stdout.write(`  5. Match BUY  @ ${mp} (GTC)... `);
        await placeOrder("BUY", "LIMIT", "GTC", mp);
        console.log("placed");

        // 6. Match: limit SELL @ mark price (GTC — fills with #5)
        process.stdout.write(`  6. Match SELL @ ${mp} (GTC)... `);
        await placeOrder("SELL", "LIMIT", "GTC", mp);
        console.log("placed");

        console.log(`  ✓ Done. Next in ${INTERVAL_MS / 1000}s`);
        consecutiveErrors = 0; // reset on success
    } catch (err) {
        consecutiveErrors++;
        const msg = `Cycle #${cycleCount} error (${consecutiveErrors}/${MAX_ERRORS}): ${err.message}`;
        console.error(`  ✗ [${consecutiveErrors}/${MAX_ERRORS}]`, err.message);
        await sendTelegram(`⚠️ ${msg}`);

        if (consecutiveErrors >= MAX_ERRORS) {
            const fatal = `Stopping after ${MAX_ERRORS} consecutive errors. Last: ${err.message}`;
            console.error(`\n❌ ${fatal}`);
            await sendTelegram(`🛑 ${fatal}`);
            clearInterval(timer);
            process.exit(1); // PM2 will restart
        }
    } finally {
        // reset on success handled inside try block below
    }
}

// ─── Start ──────────────────────────────────────────────────
console.log("=".repeat(50));
console.log("  Mock Market Maker");
console.log("=".repeat(50));
console.log(`  Backend  : ${BACKEND_URL}`);
console.log(`  Symbol   : ${SYMBOL} → ${BACKEND_SYMBOL}`);
console.log(`  Spread   : ±${(SPREAD * 100).toFixed(2)}%  |  Qty: ${QUANTITY}`);
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
await cycle();
timer = setInterval(cycle, INTERVAL_MS);

process.on("SIGINT", () => { clearInterval(timer); console.log("\nStopped."); process.exit(0); });
