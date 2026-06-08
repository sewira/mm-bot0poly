# Simulation & Strategy Validation

How to test whether strategies actually work before risking real capital. Covers the current dry-run mode, its problems, the planned fixes, and the data collection plan for future backtesting.

---

## Current State: Dry-Run Mode (`DRY_RUN=true`)

When `DRY_RUN=true`, the bot connects to live WebSocket feeds, detects real opportunities, and calls `simulateTrade()` instead of placing orders.

### How `simulateTrade()` works today

```
bot-with-dashboard.ts:339-351
```

```typescript
function simulateTrade(profit: number, strategy: string, description: string) {
  state.paper.trades++;
  state.paper.pnl += profit;       // raw profit added directly — no adjustments
  state.paper.balance += profit;
  log('TRADE', `[SIMULATION] ${description} | Est. Profit: $${profit.toFixed(2)}`);
  recordTrade(profit, strategy);
}
```

Three strategies call it:

| Strategy | Call site | Profit passed | Problem |
|----------|----------|--------------|---------|
| Arbitrage | `bot-with-dashboard.ts:499` | `size * (profitPercent / 100)` — assumes perfect fill at best price | Ignores slippage, depth, gas costs, competing bots |
| Smart Money | `bot-with-dashboard.ts:451` | `0` (hardcoded) | Records the trade but not the PnL — useless for evaluation |
| Direct Trading | `bot-with-dashboard.ts:897` | `0` (hardcoded) | Same — no PnL tracking at all |

### Why this is a problem

The dashboard PnL numbers cannot be trusted:
- **Arbitrage** shows inflated profits because it assumes every detected opportunity would execute perfectly at the best orderbook price, with full size, instantly, with no other bots competing
- **Smart Money and Direct Trading** show $0 profit for every trade, so you can't evaluate whether these strategies make or lose money
- There's no way to compare strategies against each other because two out of three don't even track simulated PnL

---

## Fix Plan: Realistic Dry-Run Simulation

### Step 1: Replace `simulateTrade()` with `simulateRealisticTrade()`

The new function applies four haircuts to raw profit:

```typescript
function simulateRealisticTrade(params: {
  rawProfit: number;
  strategy: string;
  description: string;
  orderbookDepth?: number;    // available size on the best price level
  tradeSize?: number;         // intended trade size
  isOnChain?: boolean;        // merge/split = gas cost
}) {
  let adjustedProfit = params.rawProfit;

  // 1. Slippage: assume 50% of raw profit lost to price movement
  //    Rationale: by the time we detect + place order, price has partially moved
  adjustedProfit *= 0.5;

  // 2. Partial fill: if we want more than the book has, scale down
  if (params.orderbookDepth && params.tradeSize) {
    const fillRate = Math.min(1, params.orderbookDepth / params.tradeSize);
    adjustedProfit *= fillRate;
  }

  // 3. Gas cost: on-chain merge/split costs ~0.01 MATIC (~$0.005)
  if (params.isOnChain) {
    adjustedProfit -= 0.01;
  }

  // 4. Competition: ~30% of arb opportunities get taken by other bots first
  adjustedProfit *= 0.7;

  // Record both raw and adjusted for comparison
  simulateTrade(adjustedProfit, params.strategy, params.description);
}
```

### Step 2: Fix each strategy caller

**Arbitrage** (`bot-with-dashboard.ts:495-499`):
- Currently: `simulateTrade(estimatedProfit, 'arbitrage', ...)`
- After: pass `orderbookDepth` from the opportunity's `maxOrderbookSize`, set `isOnChain: true` (arb involves merge)
- This alone will reduce simulated arb profits by ~65% (0.5 slippage * 0.7 competition = 0.35x)

**Smart Money** (`bot-with-dashboard.ts:451`):
- Currently: `simulateTrade(0, 'smartMoney', ...)` — hardcoded $0
- After: estimate profit from `trade.price` and `trade.size`, then apply slippage haircut
- The trade event already provides `trade.side`, `trade.price`, `trade.size` — use these to estimate PnL relative to current market price

**Direct Trading** (`bot-with-dashboard.ts:897`):
- Currently: `simulateTrade(0, 'direct', ...)` — hardcoded $0
- After: cannot estimate immediate profit (it's a directional bet, not an arb), but should at least record the entry price and track unrealized PnL over time as market price changes
- Requires the position tracking from Improvement #5 (Direct Trading Position Management) to be meaningful

### Step 3: Dashboard comparison

Add to `BotState` a `simulation` field:
```typescript
simulation: {
  rawPnl: number;        // what current simulateTrade() would have shown
  adjustedPnl: number;   // after slippage/depth/gas/competition haircuts
  realism: number;       // adjustedPnl / rawPnl — shows how much profit is "real"
}
```

This lets the dashboard display both numbers side by side, making the gap visible.

---

## Data Collection for Backtesting

### The problem

Polymarket does not provide historical orderbook snapshots. There is no third-party provider for this data either. Without orderbook history, you cannot replay strategies to validate parameters.

Available historical data:

| Data Source | What it provides | Useful for |
|-------------|-----------------|------------|
| `DataApiClient.getTrades()` | Past trades (price, size, timestamp) | Approximate price history, but no depth |
| `BinanceService.getKLines()` | Crypto price candles (BTC/ETH/SOL/XRP) | DipArb backtesting (crypto prices drive the strategy) |
| `GammaApiClient.getMarkets()` | Market metadata, `endDate`, volume | Filtering which markets to test |
| Live WebSocket (not recorded) | Real-time orderbook snapshots, price ticks | Everything — but only if we record it |

### Solution: Record-and-Replay

#### Phase 1: Start recording (implement now)

Add a recording layer to `RealtimeServiceV2` that logs every WebSocket event to a JSONL file:

```typescript
// Each line in the recording file:
interface RecordedEvent {
  timestamp: number;           // Date.now()
  type: 'orderbook' | 'price' | 'trade' | 'activity';
  assetId?: string;            // token ID for orderbook events
  data: OrderbookSnapshot | CryptoPrice | TradeEvent;
}
```

**Where to record**: All events received by the WebSocket handlers that the bot already subscribes to. No additional API calls or subscriptions needed — just write what's already flowing through the system to disk.

**Storage estimates**:
- Orderbook updates: ~1-5 per second per market, ~100 bytes each
- With 2-4 markets subscribed: **~50-200 MB per day** (uncompressed)
- With gzip compression: **~10-40 MB per day**
- 4 weeks of data: **~300 MB - 1.1 GB compressed**

**File structure**:
```
data/recordings/
  2026-06-05_orderbooks.jsonl.gz
  2026-06-05_prices.jsonl.gz
  2026-06-06_orderbooks.jsonl.gz
  ...
```

#### Phase 2: Collect data (2-4 weeks)

Run the bot in `DRY_RUN=true` with recording enabled. Continue using the bot normally — recording happens in the background.

**Minimum collection periods by strategy:**

| Strategy | Minimum | Why |
|----------|---------|-----|
| Arbitrage | 1-2 weeks | Arb opportunities are frequent but fleeting — need enough to measure execution window duration |
| Market Making | 1 week | Spread capture is continuous — every orderbook tick is relevant |
| DipArb | 2-4 weeks | Dip events (15%+ in 3s) are rare — maybe a few per day across all coins. Need 50-100+ events |
| Smart Money | 2-4 weeks | Top wallet activity is irregular. Need enough entries/exits to validate position-based approach |

**Recommended**: Start recording now. After **2 weeks** you can backtest arbitrage and market making. After **4 weeks** you'll have enough data for all strategies.

#### Phase 3: Build replay engine (after collection)

Once data is collected, build the `ReplayEngine`:

```typescript
class ReplayEngine {
  private events: RecordedEvent[];

  async load(files: string[]): Promise<void>;

  // Feed events to strategy adapter in chronological order
  async replay(adapter: StrategyAdapter): Promise<BacktestResult>;
}

interface StrategyAdapter {
  onOrderbook(snapshot: OrderbookSnapshot): void;
  onPrice(price: CryptoPrice): void;
  onTick(timestamp: number): void;
  getResult(): { trades: SimulatedTrade[]; pnl: number };
}

interface BacktestResult {
  totalPnl: number;
  tradeCount: number;
  winRate: number;
  maxDrawdown: number;
  sharpeRatio: number;
  parameterUsed: Record<string, number>;
}
```

One adapter per strategy:
- `ArbAdapter` — feeds orderbook snapshots to `checkArbitrage()` / `getEffectivePrices()`
- `DipArbAdapter` — feeds crypto price ticks to dip detection logic
- `MarketMakingAdapter` — simulates limit order placement and fill detection from orderbook
- `SmartMoneyAdapter` — replays wallet activity and simulates position-based entry

CLI runner:
```bash
npx tsx scripts/backtest.ts --strategy=dip-arb --coin=BTC --days=30
npx tsx scripts/backtest.ts --strategy=arb --min-profit=0.005
```

---

## Implementation Order

```
Phase 1 (now):
├── Fix simulateTrade() → simulateRealisticTrade()     [bot-with-dashboard.ts]
├── Add WebSocket recording layer                       [src/services/realtime-service-v2.ts]
└── Add recording config to .env                        [DRY_RUN_RECORD=true]

Phase 2 (wait 2-4 weeks):
└── Collect data while running bot in DRY_RUN mode

Phase 3 (after collection):
├── Build ReplayEngine                                  [src/backtest/replay.ts]
├── Build strategy adapters                             [src/backtest/adapters/]
├── Build CLI runner                                    [scripts/backtest.ts]
└── Run parameter sensitivity analysis
    ├── DipArb: sweep dipThreshold (0.10-0.25), sumTarget (0.90-0.97)
    ├── Arb: sweep profitThreshold (0.001-0.01)
    └── Market Making: sweep spreadBps (100-500)
```

Phase 1 gives immediate value — realistic dry-run PnL and data starts accumulating.
Phase 3 gives long-term value — parameter validation with real data.

---

## Files Reference

| File | Role |
|------|------|
| `bot-with-dashboard.ts:339-351` | Current `simulateTrade()` — to be replaced |
| `bot-with-dashboard.ts:499` | Arb caller — passes raw `estimatedProfit` |
| `bot-with-dashboard.ts:451` | Smart money caller — passes hardcoded `0` |
| `bot-with-dashboard.ts:897` | Direct trading caller — passes hardcoded `0` |
| `src/services/realtime-service-v2.ts` | WebSocket service — recording layer goes here |
| `src/services/arbitrage-service.ts:464` | `getOrderbook()` — real-time depth for arb simulation |
| `src/services/market-service.ts` | `getProcessedOrderbook()` — depth for other strategies |
| `src/utils/price-utils.ts` | `checkArbitrage()`, `getEffectivePrices()` — used by replay adapters |
