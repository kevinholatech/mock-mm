# Mock Market Maker Script

Automatically places mock bid/ask orders and creates trade matches every 30 seconds.

**Requirements:** Node.js >= 18 — no additional packages needed.

---

## Step 1 — Get API Key and Private Key

Open the app → connect wallet → Enable Trading → F12 → Console, paste:

```js
const exchangeLocalData = JSON.parse(localStorage.getItem('exchange.0g.state.v3'));
const exchangeState = exchangeLocalData.state;
const address = exchangeState.address;

console.log('API_KEY:', exchangeState.account[address].apiKey.v);

const priv = exchangeState.account[address].keypair.privateKey;
console.log('PRIVATE_KEY_HEX:', Object.values(priv).map(b => b.toString(16).padStart(2, '0')).join(''));
```

## Step 2 — Create `.env`

```bash
cp scripts/.env.example scripts/.env
```

Fill in `scripts/.env`:

```env
BACKEND_URL=http://47.243.220.53:3000
API_KEY=<from step 1>
PRIVATE_KEY_HEX=<from step 1>
```

## Step 3 — Run

```bash
node scripts/market-maker.mjs
```

Press **Ctrl+C** to stop.

---

## Each cycle (every 30s):

1. Fetch mark price
2. Cancel all open orders
3. Place **BID** limit @ `markPrice × (1 - spread)`
4. Place **ASK** limit @ `markPrice × (1 + spread)`
5. Place limit BUY @ mark price → creates match
6. Place limit SELL @ mark price → fills with #5

---

## Advanced Config (optional)

Edit `scripts/.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `SYMBOL` | `BTC-USDC` | Trading pair (`BTC-USDC` perp, `BTC/USDC` spot) |
| `PRODUCT_ID` | `2` | Product ID on the exchange |
| `SPREAD` | `0.001` | Spread per side (0.001 = 0.1%) |
| `QUANTITY` | `0.01` | Order size in base currency (BTC) |
| `INTERVAL_MS` | `30000` | Cycle interval in milliseconds |

> ⚠️ **API Key expires** — if the script returns a `401` error, log in to the app again and get a new API key.

---

## Running multiple pairs simultaneously

```bash
SYMBOL=BTC-USDC node scripts/market-maker.mjs &
SYMBOL=ETH-USDC node scripts/market-maker.mjs &
SYMBOL=SOL-USDC node scripts/market-maker.mjs &
```
