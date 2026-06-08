# Getting Started: Simulation & Recording

How to run the bot in simulation mode and start collecting data for future backtesting.

---

## 0. Prerequisites

### Install dependencies

```bash
npm install
cd dashboard && npm install && npm run build && cd ..
```

### Configure `.env`

Copy the example and fill in your private key:

```bash
cp .env.example .env
```

Edit `.env`:

```
POLYMARKET_PRIVATE_KEY=0xYOUR_ETHEREUM_PRIVATE_KEY_HERE
CAPITAL_USD=250
DRY_RUN=true
DRY_RUN_RECORD=true
LIVE_TRADING_CONFIRMED=false
```

Your private key is the Ethereum wallet key exported from Polymarket (Settings > Export Private Key). It must start with `0x` and be 66 hex characters.

### VPN (if needed)

Some ISPs (e.g. Indosat/Indonesia) block Polymarket via DNS hijacking. If you see `certificate has expired` or `hostname does not match` errors, you need a VPN.

**Cloudflare WARP** (free, recommended):

```bash
# macOS
brew install cloudflare-warp
warp-cli registration new
warp-cli connect

# Windows
# Download from https://1.1.1.1/ and install
# Or via winget:
winget install Cloudflare.Warp
# Open the app, enable WARP
```

Verify DNS is clean:

```bash
nslookup clob.polymarket.com
# Should resolve to 104.18.x.x or 172.64.x.x (Cloudflare IPs)
# NOT to internetpositif.ioh.co.id or similar block pages
```

---

## 1. Run in Dry-Run Mode (simulation only)

### macOS / Linux

```bash
DRY_RUN=true npx tsx bot-with-dashboard.ts
```

With strategies enabled:

```bash
DRY_RUN=true \
ARBITRAGE_ENABLED=true \
DIPARB_ENABLED=true \
SMARTMONEY_ENABLED=true \
npx tsx bot-with-dashboard.ts
```

### Windows (PowerShell)

```powershell
$env:DRY_RUN="true"
npx tsx bot-with-dashboard.ts
```

With strategies enabled:

```powershell
$env:DRY_RUN="true"
$env:ARBITRAGE_ENABLED="true"
$env:DIPARB_ENABLED="true"
$env:SMARTMONEY_ENABLED="true"
npx tsx bot-with-dashboard.ts
```

### Windows (Command Prompt)

```cmd
set DRY_RUN=true
set ARBITRAGE_ENABLED=true
set DIPARB_ENABLED=true
set SMARTMONEY_ENABLED=true
npx tsx bot-with-dashboard.ts
```

> **Tip**: If you set the values in `.env`, you don't need to pass them as environment variables. Just run `npx tsx bot-with-dashboard.ts`.

### What happens in dry-run

- WebSocket connections are live — you see real market data
- When a strategy detects an opportunity, it calls `simulateRealisticTrade()` instead of placing an order
- Taker fees are deducted per market category (crypto pays the most at 7.2% feeRate)
- Arbitrage profits are reduced by fees + slippage + gas + competition haircuts
- DipArb tracks leg1/leg2 costs and computes actual profit on merge/exit
- Smart Money records the trade but shows $0 PnL (directional bets — profit is unknown at entry)

### Reading the logs

Simulation trades show both raw and adjusted profit:

```
[SIMULATION] Arb long Market XYZ [raw: $1.20, adj: $0.08] | Est. Profit: $0.08
```

- `raw` — assumes perfect execution (no fees, no slippage)
- `adj` — after taker fees, slippage, gas, and competition haircuts (closer to reality)

---

## 2. Run with Recording (collect data for backtesting)

### macOS / Linux

```bash
DRY_RUN=true \
DRY_RUN_RECORD=true \
SMARTMONEY_ENABLED=true \
DIPARB_ENABLED=true \
npx tsx bot-with-dashboard.ts
```

### Windows (PowerShell)

```powershell
$env:DRY_RUN="true"
$env:DRY_RUN_RECORD="true"
$env:SMARTMONEY_ENABLED="true"
$env:DIPARB_ENABLED="true"
npx tsx bot-with-dashboard.ts
```

### Windows (Command Prompt)

```cmd
set DRY_RUN=true
set DRY_RUN_RECORD=true
set SMARTMONEY_ENABLED=true
set DIPARB_ENABLED=true
npx tsx bot-with-dashboard.ts
```

This does everything in step 1, plus writes every WebSocket event to disk. Recording runs in the background with no impact on bot performance.

### .env setup (recommended — works on all platforms)

Add to your `.env` file:

```
DRY_RUN=true
DRY_RUN_RECORD=true
SMARTMONEY_ENABLED=true
DIPARB_ENABLED=true
```

Then just run:

```bash
npx tsx bot-with-dashboard.ts
```

### Where recordings are stored

```
data/recordings/
  2026-06-05.jsonl
  2026-06-06.jsonl
  ...
```

One file per day. Files rotate automatically at midnight. Appending mode — you can restart the bot without losing earlier data from the same day.

### File format

Each line is a self-contained JSON object:

```json
{"ts":1749100000000,"topic":"clob_market","type":"agg_orderbook","payload":{...}}
{"ts":1749100001000,"topic":"crypto_prices","type":"update","payload":{"BTC":{"price":104500}}}
{"ts":1749100002000,"topic":"activity","type":"trade","payload":{...}}
```

| Field | Description |
|-------|-------------|
| `ts` | Unix timestamp in milliseconds (when the event was received) |
| `topic` | WebSocket topic (`clob_market`, `activity`, `crypto_prices`, `crypto_prices_chainlink`) |
| `type` | Message type within the topic |
| `payload` | Raw message payload from Polymarket |

---

## 3. Verify Recording is Working

After running for a minute with `DRY_RUN_RECORD=true`:

### macOS / Linux

```bash
# Check file exists and is growing
ls -lh data/recordings/

# Count events recorded
wc -l data/recordings/$(date +%Y-%m-%d).jsonl

# Peek at first 5 events
head -5 data/recordings/$(date +%Y-%m-%d).jsonl | jq .
```

### Windows (PowerShell)

```powershell
# Check file exists and is growing
dir data\recordings\

# Count events recorded
$date = Get-Date -Format "yyyy-MM-dd"
(Get-Content "data\recordings\$date.jsonl" | Measure-Object -Line).Lines

# Peek at first 5 events
Get-Content "data\recordings\$date.jsonl" -TotalCount 5
```

You should see events with topics `crypto_prices`, `crypto_prices_chainlink`, and `activity`.

---

## 4. How Long to Record

| Strategy | Minimum | Why |
|----------|---------|-----|
| Arbitrage | 1-2 weeks | Arb opportunities are frequent but fleeting — need enough to measure execution window duration |
| Market Making | 1 week | Spread capture is continuous — every orderbook tick is relevant |
| DipArb | 2-4 weeks | Dip events (15%+ in 3s) are rare — maybe a few per day across all coins. Need 50-100+ events |
| Smart Money | 2-4 weeks | Top wallet activity is irregular. Need enough entries/exits to validate position-based approach |

**Recommendation**: Start recording now. After 2 weeks you can backtest arbitrage and market making. After 4 weeks you'll have enough for all strategies.

**Storage**: ~50-200 MB per day uncompressed (depends on how many markets are subscribed). 4 weeks = ~1.4-5.6 GB.

---

## 5. What Gets Recorded (and what doesn't)

### Recorded

| Topic | Contents | Useful for |
|-------|----------|------------|
| `clob_market` | Orderbook snapshots, price changes, last trades | Arbitrage, market making backtesting |
| `activity` | Matched trades, order activity | Smart money backtesting |
| `crypto_prices` | BTC, ETH, SOL price updates | DipArb backtesting |
| `crypto_prices_chainlink` | Chainlink oracle prices | DipArb backtesting |

### Not recorded

`ArbitrageService` and `DipArbService` create their own internal WebSocket connections for subscribing to specific market orderbooks. Those events are not captured by the SDK's recording — only the main `sdk.realtime` instance records.

This means crypto prices and activity trades are captured (sufficient for DipArb and Smart Money backtesting), but market-specific orderbook data from arb-specific subscriptions is not. This is a future enhancement.

---

## 6. Simulation Haircuts Explained

`simulateRealisticTrade()` applies five adjustments to raw profit before recording:

| Step | Haircut | Factor | Rationale |
|------|---------|--------|-----------|
| 0 | Taker fee | `-calculateTakerFee(shares, price, category)` | Polymarket charges taker fees per category. Crypto at p=0.50 costs 1.8% per leg. Arb pays 2 legs. |
| 1 | Slippage | 0.5x | By the time we detect + place order, price has partially moved |
| 2 | Partial fill | `min(1, depth / size)` | If trade exceeds orderbook depth, only partial fill |
| 3 | Gas cost | -$0.10 | On-chain merge/split gas on Polygon (from config) |
| 4 | Competition | 0.7x | ~30% of arb opportunities get taken by other bots first |

**Example**: A crypto arb with 100 shares at p=0.50, raw profit $2.00:
- Step 0: Taker fee for 2-leg arb = $3.60 → profit = -$1.60 (already negative!)
- Most crypto arb "opportunities" are unprofitable after fees.

---

## 7. Running as a Background Service (long-term recording)

For continuous recording over days/weeks, run the bot as a background process.

### macOS / Linux (using nohup)

```bash
nohup npx tsx bot-with-dashboard.ts > bot.log 2>&1 &
echo $! > bot.pid
```

To stop:

```bash
kill $(cat bot.pid)
```

### macOS / Linux (using screen)

```bash
screen -S polybot
npx tsx bot-with-dashboard.ts
# Press Ctrl+A, then D to detach
# Reattach later: screen -r polybot
```

### Windows (PowerShell — keep running after close)

```powershell
Start-Process -NoNewWindow npx -ArgumentList "tsx bot-with-dashboard.ts" -RedirectStandardOutput bot.log -RedirectStandardError bot-err.log
```

### Windows (using PM2 — recommended for long-term)

```powershell
npm install -g pm2
pm2 start "npx tsx bot-with-dashboard.ts" --name polybot
pm2 logs polybot     # view logs
pm2 stop polybot     # stop
pm2 restart polybot  # restart
```

---

## What's Next

Once you've collected 2-4 weeks of recordings, the next step is building the replay engine for backtesting. See [SIMULATION.md](./SIMULATION.md) for the full backtesting plan (Phase 3).
