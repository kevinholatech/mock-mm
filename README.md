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

const name = "mm-" + address.slice(-4);
const apiKey = exchangeState.account[address].apiKey.v;
const priv = exchangeState.account[address].keypair.privateKey;
const privateKeyHex = Object.values(priv)
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");

// Copy this into accounts.json
console.log(
  JSON.stringify(
    { name, apiKey, privateKeyHex, updatedAt: Date.now(), pairs: null },
    null,
    2,
  ),
);
```

### 2. Create config files

```bash
cp .env.example .env
cp accounts.json.example accounts.json
```

Edit `accounts.json` — paste the output from step 1:

```json
[
  {
    "name": "mm-78F5",
    "apiKey": "<from step 1>",
    "privateKeyHex": "<from step 1>",
    "updatedAt": 1741484400000,
    "pairs": null
  }
]
```

**Account fields:**

| Field           | Type          | Required | Description                                                         |
| --------------- | ------------- | :------: | ------------------------------------------------------------------- |
| `name`          | string        |    ✅    | Unique label (auto-generated from wallet address)                   |
| `apiKey`        | string        |    ✅    | API key from browser console                                        |
| `privateKeyHex` | string        |    ✅    | 64-char hex private key                                             |
| `updatedAt`     | number        |          | Unix timestamp (ms). Used to pick latest when duplicate names exist |
| `pairs`         | array \| null |          | `null` = trade all 4 default pairs. Override per-account:           |

**Pairs structure** (when overriding):

```json
"pairs": [
  { "symbol": "BTC-USDC", "productId": 2, "spread": 0.001, "quantity": 0.0123 },
  { "symbol": "ETH-USDC", "productId": 4, "spread": 0.001, "quantity": 0.2 }
]
```

| Field       | Description                                                       |
| ----------- | ----------------------------------------------------------------- |
| `symbol`    | Trading pair name (`BTC-USDC`, `ETH-USDC`, `SOL-USDC`, `0G-USDC`) |
| `productId` | Backend product ID (BTC=2, ETH=4, SOL=5, 0G=6)                    |
| `spread`    | Price spread from mid-price (e.g. `0.001` = 0.1%)                 |
| `quantity`  | Order size per level                                              |

### 3. Install & Build

```bash
npm install
npm run build
```

### 4. Run

```bash
node dist/market-maker.mjs --account-name=mm-78F5
```

Or with PM2 (recommended for production):

```bash
npm run pm2:start
```

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

## Multi-Account Setup

Run 20+ market maker accounts simultaneously, each as an isolated PM2 process.

### 1. Create `accounts.json`

```bash
cp accounts.json.example accounts.json
```

Edit `accounts.json` — add one entry per account:

```json
[
  {
    "name": "mm-78F5",
    "apiKey": "xxx",
    "privateKeyHex": "yyy",
    "updatedAt": 1741484400000,
    "pairs": null
  },
  {
    "name": "mm-A3B1",
    "apiKey": "xxx",
    "privateKeyHex": "yyy",
    "updatedAt": 1741484400000,
    "pairs": null
  },
  {
    "name": "mm-D4E2",
    "apiKey": "xxx",
    "privateKeyHex": "yyy",
    "updatedAt": 1741484400000,
    "pairs": null
  }
]
```

- `name` — unique label (shown in PM2 and logs)
- `apiKey`, `privateKeyHex` — per-account credentials
- `pairs` — set to `null` to use default pairs, or override per-account

### 2. Shared config in `.env`

All accounts share the same `.env` for common settings (BACKEND_URL, SPREAD, LEVELS, etc.).

### 3. Deploy with PM2

```bash
npm install -g pm2     # if not installed
npm run build
npm run pm2:start      # starts all accounts from accounts.json
```

### Account Management

```bash
# View all accounts
npm run pm2:status

# View logs for a specific account
pm2 logs mm-78F5

# Restart specific account
pm2 restart mm-78F5

# Stop specific account
pm2 stop mm-A3B1

# Restart all accounts
pm2 restart all

# Stop all
npm run pm2:stop
```

### Adding/Removing Accounts

1. Edit `accounts.json` (add or remove entries)
2. Run `pm2 start ecosystem.config.cjs` — PM2 will start new accounts

### Log Files

Each account has separate log files in `logs/`:

- `logs/mm-78F5-out.log` — stdout
- `logs/mm-78F5-error.log` — stderr

PM2 will **auto-restart** on crash (max 10 retries, 5s delay between each).
