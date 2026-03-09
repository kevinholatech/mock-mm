/**
 * Mock Market Maker — TypeScript
 * ==============================
 * Multi-pair market maker for demo/testing purposes.
 *
 * Each cycle (every INTERVAL_MS):
 *   1. Fetch mark price from Binance (or backend for non-standard pairs)
 *   2. Cancel all open orders
 *   3. Place BID levels (buy below mark)
 *   4. Place ASK levels (sell above mark)
 *   5. Place match orders at mark price → fill each other
 *
 * Setup:
 *   1. Copy .env.example → .env and fill in your values
 *   2. npm run build
 *   3. npm start
 */

import { readFileSync, existsSync } from "node:fs";
import {
  createPrivateKey,
  sign as nodeSign,
  type KeyObject,
} from "node:crypto";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TradingPair {
  symbol: string;
  productId: number;
  spread: number;
  quantity: number;
}

interface PairState {
  consecutiveErrors: number;
  disabled: boolean;
}

interface SymbolPair {
  backend: string;
  binance: string;
}

interface PriceIndexResponse {
  markPrice?: string;
  price?: string;
}

interface AccountConfig {
  name: string;
  apiKey: string;
  privateKeyHex: string;
  updatedAt?: number;
  pairs?: TradingPair[] | null;
}

// ─── Load .env manually (no dotenv dependency needed) ────────────────────────

function loadEnv(filepath: string): void {
  if (!existsSync(filepath)) return;

  for (const line of readFileSync(filepath, "utf8").split("\n")) {
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

const resolve = (file: string): string =>
  new URL(file, `file://${process.cwd()}/`).pathname;

loadEnv(resolve(".env"));

// ─── Account loading (multi-account support) ─────────────────────────────────

function deduplicateAccounts(accounts: AccountConfig[]): AccountConfig[] {
  const map = new Map<string, AccountConfig>();

  for (const acc of accounts) {
    const existing = map.get(acc.name);

    if (!existing || (acc.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
      map.set(acc.name, acc);
    }
  }

  return Array.from(map.values());
}

function loadAccounts(): AccountConfig[] {
  const configPath = resolve("accounts.json");

  if (!existsSync(configPath)) {
    console.error(
      "❌ accounts.json not found. Copy from accounts.json.example",
    );
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(configPath, "utf8")) as AccountConfig[];

  return deduplicateAccounts(raw);
}

function loadAccount(): AccountConfig {
  const nameArg = process.argv.find((a) => a.startsWith("--account-name="));

  if (!nameArg) {
    console.error("❌ Missing --account-name argument.");
    console.error("   Usage: node market-maker.mjs --account-name=mm-78F5");
    console.error("   Or use PM2: pm2 start ecosystem.config.cjs");
    process.exit(1);
  }

  const name = nameArg.split("=")[1];
  const accounts = loadAccounts();
  const found = accounts.find((a) => a.name === name);

  if (!found) {
    console.error(
      `❌ Account "${name}" not found. Available: ${accounts.map((a) => a.name).join(", ")}`,
    );
    process.exit(1);
  }

  return found;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const account = loadAccount();
const ACCOUNT_NAME = account.name;

const BACKEND_URL = (
  process.env.BACKEND_URL ?? "http://47.243.220.53:3000"
).replace(/\/$/, "");
const API_KEY = account.apiKey;
const PRIV_HEX = account.privateKeyHex;

const LEVELS = parseInt(process.env.LEVELS ?? "5", 10);
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS ?? "30000", 10);
const MAX_ERRORS = parseInt(process.env.MAX_ERRORS ?? "5", 10);

// Telegram alert (optional)
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

const SPREAD = parseFloat(process.env.SPREAD ?? "0.001");

let PAIRS: TradingPair[] = [
  { symbol: "BTC-USDC", productId: 2, spread: SPREAD, quantity: 0.0123 },
  { symbol: "ETH-USDC", productId: 4, spread: SPREAD, quantity: 0.2 },
  // { symbol: "SOL-USDC", productId: 5, spread: SPREAD, quantity: 1.5 },
  { symbol: "0G-USDC", productId: 6, spread: SPREAD, quantity: 100 },
];

if (account.pairs) {
  PAIRS = account.pairs;
} else if (process.env.PAIRS_JSON) {
  try {
    PAIRS = JSON.parse(process.env.PAIRS_JSON) as TradingPair[];
  } catch {
    console.error("❌ Invalid PAIRS_JSON");
    process.exit(1);
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

if (!API_KEY) {
  console.error(`❌ [${ACCOUNT_NAME}] apiKey is empty in accounts.json`);
  process.exit(1);
}

if (PRIV_HEX.length !== 64) {
  console.error(
    `❌ [${ACCOUNT_NAME}] privateKeyHex must be a 64-character hex string.`,
  );
  process.exit(1);
}

// ─── Symbol conversion ──────────────────────────────────────────────────────

function getSymbols(symbolStr: string): SymbolPair {
  const backend = symbolStr.includes("-")
    ? symbolStr.replace("-", "") + "PERP"
    : symbolStr.replace("/", "");

  // Binance uses USDT, not USDC
  const binance = backend.replace(/PERP$/, "").replace(/USDC$/, "USDT");

  return { backend, binance };
}

// ─── Signing (node:crypto — synchronous, no external deps) ──────────────────

const PKCS8_HEADER = Buffer.from("302e020100300506032b657004220420", "hex");

let _privateKey: KeyObject | null = null;

function getPrivateKey(): KeyObject {
  if (!_privateKey) {
    const seed = Buffer.from(PRIV_HEX, "hex");
    const pkcs8 = Buffer.concat([PKCS8_HEADER, seed]);
    _privateKey = createPrivateKey({
      key: pkcs8,
      format: "der",
      type: "pkcs8",
    });
  }

  return _privateKey;
}

function sign(message: string): string {
  const sig = nodeSign(null, Buffer.from(message, "utf8"), getPrivateKey());
  return sig.toString("base64");
}

function buildQS(
  params: Record<string, string | number | boolean | undefined>,
): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
    )
    .join("&");
}

function signedBody(
  params: Record<string, string | number | boolean | undefined>,
): string {
  const qs = buildQS({ ...params, timestamp: Date.now() });
  const sig = sign(qs);
  return `${qs}&signature=${encodeURIComponent(sig)}`;
}

// ─── API helpers ─────────────────────────────────────────────────────────────

async function api(path: string, opts?: RequestInit): Promise<Response> {
  return fetch(`${BACKEND_URL}${path}`, opts);
}

async function placeOrder(
  pair: TradingPair,
  side: "BUY" | "SELL",
  type: "LIMIT" | "MARKET",
  timeInForce?: "GTC" | "IOC" | "ALO",
  price?: string,
  qty?: number | string,
): Promise<void> {
  const { backend } = getSymbols(pair.symbol);

  const params: Record<string, string | number | boolean | undefined> = {
    productId: pair.productId,
    quantity: qty ?? pair.quantity,
    side,
    symbol: backend,
    type,
  };

  if (timeInForce) params.timeInForce = timeInForce;
  if (price) params.price = price;

  const body = signedBody(params);
  const res = await api("/fapi/v1/order", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-api-key": API_KEY,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();

    if (res.status === 401) {
      const msg =
        "❌ API key expired (401). Update apiKey in accounts.json and restart.";
      console.error("\n" + msg);
      await sendTelegram(msg);
      process.exit(0);
    }

    throw new Error(`${side} ${type} failed [${res.status}]: ${text}`);
  }
}

// ─── Telegram alert ──────────────────────────────────────────────────────────

function nowStr(): string {
  return new Date().toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour12: false,
  });
}

async function sendTelegram(msg: string): Promise<void> {
  if (!TG_TOKEN || !TG_CHAT_ID) return;

  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: `[MM:${ACCOUNT_NAME}] ${nowStr()}\n${msg}`,
      }),
    });
  } catch {
    /* ignore Telegram errors */
  }
}

// ─── Cycle ───────────────────────────────────────────────────────────────────

let cycleCount = 0;

const pairStates: Record<string, PairState> = {};
PAIRS.forEach(
  (p) => (pairStates[p.symbol] = { consecutiveErrors: 0, disabled: false }),
);

async function cycleForPair(pair: TradingPair): Promise<void> {
  const { backend, binance } = getSymbols(pair.symbol);
  const state = pairStates[pair.symbol];

  if (state.disabled) return;

  try {
    let markPrice: number | undefined;

    process.stdout.write(`  [${pair.symbol}] Mark price... `);

    if (pair.symbol === "0G-USDC") {
      // 0G is not on Binance — fetch from backend or use fallback
      const beRes = await fetch(
        `${BACKEND_URL}/fapi/v1/premiumIndex?symbol=${backend}`,
      );

      if (beRes.ok) {
        const data = (await beRes.json()) as
          | PriceIndexResponse
          | PriceIndexResponse[];
        const item = Array.isArray(data) ? data[0] : data;
        if (item?.markPrice) markPrice = parseFloat(item.markPrice);
      }

      if (!markPrice) markPrice = 0.04; // fallback
    } else {
      const binanceRes = await fetch(
        `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${binance}`,
      );

      if (!binanceRes.ok) throw new Error(`Binance API: ${binanceRes.status}`);

      const binanceData = (await binanceRes.json()) as PriceIndexResponse;
      markPrice = parseFloat(binanceData.markPrice ?? "0");
    }

    if (!markPrice) throw new Error(`Invalid markPrice for ${pair.symbol}`);

    console.log(`$${markPrice.toFixed(4)}`);

    // Cancel all open orders
    process.stdout.write(`  [${pair.symbol}] Cancel orders... `);
    const cancelBody = signedBody({ symbol: backend });
    const cancelRes = await api("/fapi/v1/openOrders", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-api-key": API_KEY,
      },
      body: cancelBody,
    });
    console.log(cancelRes.ok ? "done" : `skipped (${cancelRes.status})`);

    // BID levels
    for (let i = 1; i <= LEVELS; i++) {
      const bid = (markPrice * (1 - pair.spread * i)).toFixed(4);
      const qty = (pair.quantity * (1 + (i - 1) * 0.5)).toFixed(4);
      process.stdout.write(
        `  [${pair.symbol}] BID[${i}] @ ${bid} qty:${qty}... `,
      );
      await placeOrder(pair, "BUY", "LIMIT", "GTC", bid, qty);
      console.log("placed");
    }

    // ASK levels
    for (let i = 1; i <= LEVELS; i++) {
      const ask = (markPrice * (1 + pair.spread * i)).toFixed(4);
      const qty = (pair.quantity * (1 + (i - 1) * 0.5)).toFixed(4);
      process.stdout.write(
        `  [${pair.symbol}] ASK[${i}] @ ${ask} qty:${qty}... `,
      );
      await placeOrder(pair, "SELL", "LIMIT", "GTC", ask, qty);
      console.log("placed");
    }

    // Match orders at mark price
    const mpStr = markPrice.toFixed(4);

    process.stdout.write(`  [${pair.symbol}] Match BUY  @ ${mpStr} (GTC)... `);
    await placeOrder(pair, "BUY", "LIMIT", "GTC", mpStr, pair.quantity);
    console.log("placed");

    process.stdout.write(`  [${pair.symbol}] Match SELL @ ${mpStr} (GTC)... `);
    await placeOrder(pair, "SELL", "LIMIT", "GTC", mpStr, pair.quantity);
    console.log("placed");

    state.consecutiveErrors = 0;
  } catch (err) {
    state.consecutiveErrors++;
    const errorMsg = err instanceof Error ? err.message : String(err);
    const msg = `[${pair.symbol}] Cycle #${cycleCount} error (${state.consecutiveErrors}/${MAX_ERRORS}): ${errorMsg}`;
    console.error(`  ✗ ${msg}`);
    await sendTelegram(`⚠️ ${msg}`);

    if (state.consecutiveErrors >= MAX_ERRORS) {
      const fatal = `[${pair.symbol}] Stopping after ${MAX_ERRORS} errors. Last: ${errorMsg}`;
      console.error(`\n❌ ${fatal}`);
      await sendTelegram(`🛑 ${fatal}`);
      state.disabled = true;
    }
  }
}

async function cycleAll(): Promise<void> {
  cycleCount++;
  const timeStr = new Date().toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour12: false,
  });
  console.log(`\n[${ACCOUNT_NAME}] [Cycle #${cycleCount}] ${timeStr}`);

  await Promise.allSettled(PAIRS.map(cycleForPair));
  console.log(`  ✓ All pairs finished. Next in ${INTERVAL_MS / 1000}s`);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

console.log("=".repeat(55));
console.log("  Mock Market Maker (Multi-Pairs)");
console.log("=".repeat(55));
console.log(`  Account    : ${ACCOUNT_NAME}`);
console.log(`  Backend    : ${BACKEND_URL}`);
console.log(`  Pairs      : ${PAIRS.map((p) => p.symbol).join(", ")}`);
console.log(`  Levels     : ${LEVELS}`);
console.log(`  Interval   : ${INTERVAL_MS / 1000}s`);
console.log(
  `  Max errors : ${MAX_ERRORS}  |  Telegram: ${TG_TOKEN ? "✓" : "✗"}`,
);
console.log("=".repeat(55));
console.log("Ctrl+C to stop\n");

// Verify signing works before starting
try {
  sign("test");
  console.log("✓ Signing OK\n");
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("❌ Signing failed:", msg);
  process.exit(1);
}

await cycleAll();
const timer = setInterval(cycleAll, INTERVAL_MS);

process.on("SIGINT", () => {
  clearInterval(timer);
  console.log("\nStopped.");
  process.exit(0);
});
