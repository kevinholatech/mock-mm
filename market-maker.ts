#!/usr/bin/env bun
/**
 * Mock Market Maker Script
 * ========================
 * Standalone script simulating market making for demo/testing purposes.
 *
 * Each cycle (every INTERVAL_MS):
 *   1. GET mark price  →  /fapi/v1/ticker/price
 *   2. DELETE all open orders  →  /fapi/v1/openOrders
 *   3. POST BUY  limit ALO @ markPrice * (1 - SPREAD)   ← post-only bid
 *   4. POST SELL limit ALO @ markPrice * (1 + SPREAD)   ← post-only ask
 *   5. POST BUY  limit GTC @ markPrice (exact)           ┐ cross each
 *   6. POST SELL limit GTC @ markPrice (exact)           ┘ other → fill
 *
 * Setup:
 *   1. Install dependencies (only @noble/ed25519 needed):
 *        bun add @noble/ed25519
 *      OR (npm):
 *        npm install @noble/ed25519
 *
 *   2. Copy .env.example → .env and fill in your values
 *
 *   3. Run:
 *        bun run scripts/market-maker.ts
 *      OR compile and run with node:
 *        npx esbuild scripts/market-maker.ts --bundle --platform=node --outfile=market-maker.js
 *        node market-maker.js
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─── Load .env manually (no dotenv dependency needed) ───────────────────────
function loadEnv(filepath: string): void {
    if (!existsSync(filepath)) return;
    const lines = readFileSync(filepath, "utf8").split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) {
            process.env[key] = value;
        }
    }
}

// Load .env from script directory or current working directory
loadEnv(join(new URL(".", import.meta.url).pathname, ".env"));
loadEnv(join(process.cwd(), ".env"));

// ─── Config ─────────────────────────────────────────────────────────────────

const BACKEND_URL = (process.env.BACKEND_URL ?? "http://47.243.220.53:3000").replace(/\/$/, "");
const API_KEY = process.env.API_KEY ?? "";
const PRIVATE_KEY_HEX = process.env.PRIVATE_KEY_HEX ?? ""; // 64-char hex string

// Trading params
const SYMBOL = process.env.SYMBOL ?? "BTC-USDC";  // frontend format
const PRODUCT_ID = parseInt(process.env.PRODUCT_ID ?? "1", 10);
const SPREAD = parseFloat(process.env.SPREAD ?? "0.001"); // 0.1% per side
const QUANTITY = process.env.QUANTITY ?? "0.01";       // base amount
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS ?? "30000", 10);

// ─── Validation ──────────────────────────────────────────────────────────────

if (!API_KEY) {
    console.error("❌ API_KEY is required. Set it in .env or environment.");
    process.exit(1);
}
if (!PRIVATE_KEY_HEX || PRIVATE_KEY_HEX.length !== 64) {
    console.error("❌ PRIVATE_KEY_HEX must be a 64-character hex string.");
    process.exit(1);
}

// ─── Symbol conversion (BTC-USDC → BTCUSDCPERP, BTC/USDC → BTCUSDC) ────────

function convertToBackendFormat(symbol: string): string {
    if (symbol.includes("-")) {
        // Perp: BTC-USDC → BTCUSDCPERP
        return symbol.replace("-", "") + "PERP";
    }
    // Spot: BTC/USDC → BTCUSDC
    return symbol.replace("/", "");
}

const BACKEND_SYMBOL = convertToBackendFormat(SYMBOL);

// ─── Signing utilities ───────────────────────────────────────────────────────

let ed: typeof import("@noble/ed25519");

async function getEd() {
    if (!ed) {
        ed = await import("@noble/ed25519");
    }
    return ed;
}

function hexToBytes(hex: string): Uint8Array {
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        arr[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return arr;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
    let binary = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

async function signBase64(message: string, privateKeyHex: string): Promise<string> {
    const lib = await getEd();
    const privateKey = hexToBytes(privateKeyHex);
    const msgBytes = new TextEncoder().encode(message);
    const sig = await lib.signAsync(msgBytes, privateKey);
    return arrayBufferToBase64(new Uint8Array(sig).buffer);
}

function buildQueryString(params: Record<string, string | number | boolean | undefined>): string {
    return Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&");
}

async function buildSignedBody(
    params: Record<string, string | number | boolean | undefined>,
): Promise<string> {
    const qs = buildQueryString({ ...params, timestamp: params.timestamp ?? Date.now() });
    const sig = await signBase64(qs, PRIVATE_KEY_HEX);
    return `${qs}&signature=${encodeURIComponent(sig)}`;
}

// ─── API helpers ─────────────────────────────────────────────────────────────

async function apiFetch(path: string, opts?: RequestInit): Promise<Response> {
    const url = `${BACKEND_URL}${path}`;
    const res = await fetch(url, opts);
    return res;
}

async function placeOrder(params: {
    side: "BUY" | "SELL";
    type: "LIMIT" | "MARKET";
    timeInForce?: "GTC" | "IOC" | "ALO";
    price?: string;
}): Promise<void> {
    const body = await buildSignedBody({
        productId: PRODUCT_ID,
        symbol: BACKEND_SYMBOL,
        side: params.side,
        type: params.type,
        ...(params.timeInForce ? { timeInForce: params.timeInForce } : {}),
        quantity: QUANTITY,
        ...(params.price ? { price: params.price } : {}),
    });

    const res = await apiFetch("/fapi/v1/order", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "x-api-key": API_KEY,
        },
        body,
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Order failed [${params.side} ${params.type}]: ${res.status} ${text}`);
    }
}

// ─── Main cycle ──────────────────────────────────────────────────────────────

let cycleCount = 0;

async function runCycle(): Promise<void> {
    cycleCount++;
    const label = `[Cycle #${cycleCount}]`;
    console.log(`\n${label} ${new Date().toISOString()}`);

    try {
        // 1. Fetch mark price
        process.stdout.write(`  1. Fetching mark price... `);
        const priceRes = await apiFetch(`/fapi/v1/ticker/price?symbol=${BACKEND_SYMBOL}`);
        if (!priceRes.ok) throw new Error(`Price fetch failed: ${priceRes.status}`);
        const priceData = await priceRes.json() as { price?: string } | Array<{ price?: string }>;
        const rawPrice = Array.isArray(priceData) ? priceData[0]?.price : priceData.price;
        const markPrice = parseFloat(rawPrice ?? "0");
        if (!markPrice) throw new Error("Invalid mark price received");
        console.log(`$${markPrice.toFixed(2)}`);

        // 2. Cancel all open orders
        process.stdout.write(`  2. Cancelling all open orders... `);
        const cancelQS = buildQueryString({ symbol: BACKEND_SYMBOL, timestamp: Date.now() });
        const cancelSig = await signBase64(cancelQS, PRIVATE_KEY_HEX);
        const cancelRes = await apiFetch(
            `/fapi/v1/openOrders?${cancelQS}&signature=${encodeURIComponent(cancelSig)}`,
            { method: "DELETE", headers: { "x-api-key": API_KEY } },
        );
        console.log(cancelRes.ok ? "done" : `skipped (${cancelRes.status})`);

        // 3. Post-only BID (buy below mark)
        const bidPrice = (markPrice * (1 - SPREAD)).toFixed(2);
        process.stdout.write(`  3. BID @ ${bidPrice} (ALO)... `);
        await placeOrder({ side: "BUY", type: "LIMIT", timeInForce: "ALO", price: bidPrice });
        console.log("placed");

        // 4. Post-only ASK (sell above mark)
        const askPrice = (markPrice * (1 + SPREAD)).toFixed(2);
        process.stdout.write(`  4. ASK @ ${askPrice} (ALO)... `);
        await placeOrder({ side: "SELL", type: "LIMIT", timeInForce: "ALO", price: askPrice });
        console.log("placed");

        // 5. Match: limit BUY @ markPrice
        const matchPrice = markPrice.toFixed(2);
        process.stdout.write(`  5. Match BUY  @ ${matchPrice} (GTC)... `);
        await placeOrder({ side: "BUY", type: "LIMIT", timeInForce: "GTC", price: matchPrice });
        console.log("placed");

        // 6. Match: limit SELL @ markPrice (crosses with #5 → fill)
        process.stdout.write(`  6. Match SELL @ ${matchPrice} (GTC)... `);
        await placeOrder({ side: "SELL", type: "LIMIT", timeInForce: "GTC", price: matchPrice });
        console.log("placed");

        console.log(`  ✓ Cycle complete. Next in ${INTERVAL_MS / 1000}s.`);
    } catch (err) {
        console.error(`  ✗ Error:`, err instanceof Error ? err.message : err);
    }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

console.log("=".repeat(55));
console.log("  Mock Market Maker");
console.log("=".repeat(55));
console.log(`  Backend  : ${BACKEND_URL}`);
console.log(`  Symbol   : ${SYMBOL} → ${BACKEND_SYMBOL}`);
console.log(`  Spread   : ±${(SPREAD * 100).toFixed(2)}%`);
console.log(`  Quantity : ${QUANTITY}`);
console.log(`  Interval : ${INTERVAL_MS / 1000}s`);
console.log(`  API Key  : ${API_KEY.slice(0, 8)}...`);
console.log("=".repeat(55));
console.log("Press Ctrl+C to stop.\n");

// Run immediately, then repeat
await runCycle();
const timer = setInterval(runCycle, INTERVAL_MS);

// Graceful shutdown
process.on("SIGINT", () => {
    clearInterval(timer);
    console.log("\n\nStopped. Goodbye!");
    process.exit(0);
});
