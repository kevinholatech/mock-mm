# Mock Market Maker

Multi-pair market maker bot — automatically places bid/ask orders and creates trade matches.

**Requirements:** Node.js ≥ 18

---

## Quick Start

### 1. Get API Key and Private Key

Open the app → connect wallet → Enable Trading → F12 → Console, paste:

```js
const exchangeLocalData = JSON.parse(
  localStorage.getItem("exchange.0g.state.v3"),
);
const exchangeState = exchangeLocalData.state;
const address = exchangeState.address;

console.log("API_KEY:", exchangeState.account[address].apiKey.v);

const priv = exchangeState.account[address].keypair.privateKey;
console.log(
  "PRIVATE_KEY_HEX:",
  Object.values(priv)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(""),
);
```

### 2. Create `.env`

```bash
cp .env.example .env
```

Fill in `.env`:

```env
BACKEND_URL=http://47.243.220.53:3000
API_KEY=<from step 1>
PRIVATE_KEY_HEX=<from step 1>
```

### 3. Install & Build

```bash
npm install
npm run build
```

### 4. Run

```bash
npm start
```

Press **Ctrl+C** to stop.

---

## Development

```bash
# Run TypeScript directly (no build needed)
npm run dev

# Type check
npm run typecheck

# Build for production
npm run build
```

### Scripts

| Script              | Command                           | Description                     |
| ------------------- | --------------------------------- | ------------------------------- |
| `npm run dev`       | `npx tsx market-maker.ts`         | Run TS directly for development |
| `npm run build`     | esbuild → `dist/market-maker.mjs` | Bundle for production           |
| `npm start`         | `node dist/market-maker.mjs`      | Run production build            |
| `npm run typecheck` | `tsc --noEmit`                    | Type check without emitting     |

---

## Each cycle (every 30s):

1. Fetch mark price (from Binance for standard pairs, backend for 0G)
2. Cancel all open orders
3. Place **BID** levels @ `markPrice × (1 - spread × level)`
4. Place **ASK** levels @ `markPrice × (1 + spread × level)`
5. Place match BUY + SELL @ mark price → fill each other

---

## Config

Edit `.env`:

| Variable             | Default                     | Description                                     |
| -------------------- | --------------------------- | ----------------------------------------------- |
| `BACKEND_URL`        | `http://47.243.220.53:3000` | Backend API URL                                 |
| `API_KEY`            | —                           | **Required.** API key from exchange             |
| `PRIVATE_KEY_HEX`    | —                           | **Required.** 64-char hex private key           |
| `SYMBOL`             | `BTC-USDC`                  | Trading pair (`BTC-USDC` perp, `BTC/USDC` spot) |
| `PRODUCT_ID`         | `2`                         | Product ID on the exchange                      |
| `SPREAD`             | `0.001`                     | Spread per side (0.001 = 0.1%)                  |
| `LEVELS`             | `5`                         | Order book depth levels per side                |
| `INTERVAL_MS`        | `30000`                     | Cycle interval in milliseconds                  |
| `MAX_ERRORS`         | `5`                         | Max consecutive errors before disabling a pair  |
| `TELEGRAM_BOT_TOKEN` | —                           | Optional. Telegram bot token for alerts         |
| `TELEGRAM_CHAT_ID`   | —                           | Optional. Telegram chat ID for alerts           |
| `PAIRS_JSON`         | —                           | Optional. JSON array to override default pairs  |

### Default Trading Pairs

| Pair     | Product ID | Quantity |
| -------- | ---------- | -------- |
| BTC-USDC | 2          | 0.0123   |
| ETH-USDC | 4          | 0.2      |
| SOL-USDC | 5          | 1.5      |
| 0G-USDC  | 6          | 100      |

> ⚠️ **API Key expires** — if the script returns a `401` error, log in to the app again and get a new API key.

---

## PM2 Deployment (Server)

```bash
# Install pm2 globally (if not already installed)
npm install -g pm2

# Build before running
npm run build

# Start
npm run pm2:start

# View logs in realtime
npm run pm2:logs

# Status
npm run pm2:status

# Stop
npm run pm2:stop

# Restart (after rebuilding)
pm2 restart market-maker
```

PM2 will **auto-restart** on crash (max 10 retries, 5s delay between each).
