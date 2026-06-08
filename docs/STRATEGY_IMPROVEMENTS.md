# Strategy Improvements Plan

Planned improvements to the Polymarket bot's four trading strategies, ranked by expected impact. Each improvement reuses existing SDK infrastructure to minimize new code.

---

## Current Strategy Weaknesses

### 1. Arbitrage — Binary-Only Limitation
`ArbitrageService.scanMarkets()` skips any market where `outcomes.length !== 2` (`src/services/arbitrage-service.ts:1678`). `checkArbitrage()` and `getEffectivePrices()` in `src/utils/price-utils.ts` are hardcoded for two-outcome (YES/NO) math. This excludes multi-outcome markets (e.g. "Who wins the election?" with 5+ candidates) where mispricing is more common due to lower liquidity per outcome.

### 2. Smart Money — Fundamental Latency Problem + No Exit Strategy
The current approach uses `subscribeSmartMoneyTrades()` to react to WebSocket trade events (`src/services/smart-money-service.ts:803`). This has a **fundamental latency disadvantage**: by the time the bot detects a trade, processes it, and places a copy order, the smart money trader has already pushed the price up. The bot is always buying at a worse price than the trader it's copying. Additionally, the bot copies entries but never tracks when followed wallets exit positions — positions accumulate indefinitely with no sell mechanism.

### 3. Dip Arb — Fixed Parameters + Aggressive sumTarget
`DipArbServiceConfig` uses static thresholds: `dipThreshold: 0.15`, `slidingWindowMs: 3000`, `sumTarget: 0.92` (`src/services/dip-arb-types.ts:165-170`). These don't adapt to market volatility. A 15% dip in 3 seconds for BTC is very different from SOL, but the same parameters apply to all coins. Additionally, the `sumTarget` of 0.92 is aggressive — it demands 8%+ profit per round, which means Leg2 rarely fills because the opposite side needs to drop significantly. The standalone script (`scripts/dip-arb/auto-trade.ts:60-64`) had per-coin defaults (BTC: 0.95, ETH: 0.93, SOL/XRP: 0.85) but the bot uses a flat 0.92 for all coins. A more conservative target of 0.96-0.97 (3-4% profit) would dramatically increase fill rates while still being profitable.

### 4. Direct Trading — No Demonstrable Edge + No Position Management
`setupDirectTrading()` uses Binance K-line trends (bullish/bearish) to buy prediction market tokens, but there is no evidence this cross-market signal has predictive value for prediction market outcomes. The strategy also has no position management: config defines `stopLossPct: 0.15`, `takeProfitPct: 0.25`, `trailingStopPct: 0.10`, `maxHoldDays: 7` but none are enforced (`bot-with-dashboard.ts:851-932`). Positions are opened and never closed.

### 5. Simulation Realism — Fake PnL in Dry Run Mode
`simulateTrade()` (`bot-with-dashboard.ts:339-351`) records detected opportunities as if they executed perfectly. For arbitrage, it calculates `estimatedProfit = size * (profitPercent / 100)` and adds it directly to `state.paper.pnl` (line 499). This ignores slippage, partial fills, orderbook depth consumed by other traders, execution latency, and gas costs. The dashboard shows inflated profits that would never be achievable in live trading, creating false confidence in strategy performance.

### 6. No Backtesting Framework
Strategies are coded with assumptions about market behavior (e.g., dip threshold of 15%, profit threshold of 0.5%) but have never been validated against historical data. There is no infrastructure to replay past orderbook/price data through the strategy logic to verify these parameters produce positive returns.

### 7. Cross-Strategy — No Correlation Awareness
All four strategies operate independently. Smart money might buy YES on a market while arbitrage is simultaneously buying YES+NO on the same market. There is no shared position ledger or exposure limit per market (`bot-with-dashboard.ts:29-140`).

### 8. Risk Management — Static Position Sizing
`calculatePositionSize()` in `bot-config.ts:365-390` adjusts size based on consecutive wins/losses, but doesn't account for current market conditions (liquidity, spread, volatility) or portfolio-level exposure.

---

## Improvement Plans

### Improvement 1: Position-Based Smart Money (High Impact)

**Problem**: The current copy trading approach has a fundamental latency problem. The flow is: wallet buys → bot detects via WebSocket → bot buys (price already moved). The bot is always the last one in, buying at a worse price. Additionally, the bot copies entries but never tracks exits, so positions accumulate indefinitely.

**Solution**: Replace reactive trade-copying with **position-based portfolio scanning**. Instead of subscribing to real-time trade events and racing to copy them, periodically poll top wallets' portfolios to identify new conviction positions, then enter on the bot's own terms using limit orders at favorable prices. Smart money becomes a *research signal*, not a trade copier. This also naturally handles exits — when a followed wallet's position disappears from their portfolio, the bot knows to exit too.

```
Current (reactive):
  Wallet buys → WebSocket event → bot market-buys (price already moved, slippage)

Proposed (proactive):
  Poll wallet portfolios every 15-30 min → detect NEW positions or size increases
  → wait for good entry price → place GTC limit order at target price
  → also detect position REMOVALS → exit bot's matching position
```

**Existing SDK to reuse**:
- `WalletService.getWalletPositions(address)` — poll followed wallets' current holdings periodically (`src/services/wallet-service.ts:279`)
- `DataApiClient.getPositions(address)` — query bot's own positions for comparison (`src/clients/data-api.ts`)
- `SmartMoneyService.getLeaderboard()` — discover top wallets to monitor (`src/services/smart-money-service.ts:1079`)
- `TradingService.createLimitOrder()` — place GTC/GTD limit orders at target prices instead of market orders (`src/services/trading-service.ts`)
- `TradingService.getOpenOrders()` — manage pending limit orders (`src/services/trading-service.ts`)
- `TradingService.cancelAll()` — cancel stale orders when signal expires (`src/services/trading-service.ts`)
- `MarketService.getProcessedOrderbook()` — check current spread/liquidity before placing limit orders (`src/services/market-service.ts`)
- `SmartMoneyService.subscribeSmartMoneyTrades()` — still useful as a secondary real-time alert for large trades (`src/services/smart-money-service.ts:803`)

**Implementation outline**:
1. Add a `Map<string, WalletSnapshot>` that stores each followed wallet's positions, keyed by wallet address. Each snapshot records `conditionId → { tokenId, size, avgPrice, firstSeen }`
2. On a 15-30 minute interval:
   - For each followed wallet, call `getWalletPositions(address)`
   - Diff against the previous snapshot:
     - **New position** (not in previous snapshot): this is a conviction entry signal. Look up the market, check current price/spread via `getProcessedOrderbook()`, and place a GTC limit order at or below the current ask (not a market order)
     - **Increased position** (size grew): reinforcement signal — the wallet is doubling down. Consider adding to the bot's position if already held
     - **Removed position** (was in previous snapshot, now gone): exit signal. If the bot holds the same position, sell via `createMarketOrder()`
     - **Decreased position** (size shrank): partial exit signal. Optionally reduce the bot's position proportionally
   - Update the snapshot map
3. Keep `subscribeSmartMoneyTrades()` as a secondary fast-alert channel for very large trades (e.g., >$1000) that warrant immediate attention between polling intervals
4. Track all positions opened via this strategy in a `Map<string, SmartMoneyPosition>` for PnL attribution

**Files to modify**:
- `bot-with-dashboard.ts` — replace `setupSmartMoney()` internals: add polling loop, snapshot diffing, limit order placement, exit tracking (~120 lines)
- `bot-config.ts` — add config: `smartMoney.pollIntervalMinutes`, `smartMoney.useLimitOrders`, `smartMoney.limitOrderSpreadPct`, `smartMoney.autoCopyExits`

**Why this is the highest priority**: Smart money has 60% capital allocation. Fixing the latency problem (limit orders instead of market orders chasing moved prices) and adding exit tracking (preventing unbounded position accumulation) addresses both the biggest source of adverse entry prices and the biggest position management gap.

---

### Improvement 2: Multi-Outcome Arbitrage (High Impact)

**Problem**: `ArbitrageService` only works with binary (2-outcome) markets. Multi-outcome markets often have larger mispricings because each outcome has its own orderbook with independent liquidity.

**Solution**: Generalize the arbitrage math to N outcomes. In an N-outcome market, all outcome tokens sum to $1 at resolution. If the sum of best ask prices across all outcomes is less than $1, there is a long arb opportunity.

**Existing SDK to reuse**:
- `GammaApiClient.getMarkets()` — already returns markets with flexible `outcomes: string[]` (`src/clients/gamma-api.ts:84`)
- `MarketService.getProcessedOrderbook()` — fetch orderbook per token (`src/services/market-service.ts`)
- `RealtimeServiceV2.subscribeMarkets()` — subscribe to multiple token orderbooks (`src/services/realtime-service-v2.ts`)
- `TradingService.createMarketOrder()` — execute individual legs
- `CTFClient.mergeByTokenIds()` — merge complete sets

**Implementation outline**:
1. Create `src/utils/multi-outcome-arb.ts`:
   - `checkMultiOutcomeArb(askPrices: number[]): { type: 'long' | 'short' | 'none'; profit: number }` — sum all best asks, compare to $1
   - `getMultiOutcomeEffectivePrices(orderbooks: OrderbookSnapshot[]): number[]`
2. Modify `ArbitrageService.scanMarkets()`:
   - Remove the `outcomes.length !== 2` filter at line 1678
   - For markets with >2 outcomes, use the new multi-outcome arb check
   - For binary markets, continue using existing `checkArbitrage()`
3. Modify `ArbitrageService.start()` to subscribe to all N token orderbooks instead of just 2
4. Add multi-leg execution: buy all N outcomes when long arb detected, merge complete set

**Files to create**:
- `src/utils/multi-outcome-arb.ts` — new arb math functions (~80 lines)

**Files to modify**:
- `src/services/arbitrage-service.ts` — remove binary filter, add multi-outcome scan/monitor/execute paths
- `src/utils/price-utils.ts` — add `getMultiOutcomeEffectivePrices()` helper

---

### Improvement 3: Simulation Realism Fix (High Impact — Infrastructure)

**Problem**: `simulateTrade()` (`bot-with-dashboard.ts:339-351`) records detected opportunities as if they executed perfectly. For arbitrage, it calculates `estimatedProfit = size * (profitPercent / 100)` at line 498-499 and adds it to PnL without any adjustment. This ignores:
- **Slippage**: market orders move the price, especially in thin books
- **Partial fills**: FOK orders can fail entirely in low liquidity
- **Latency**: by the time the bot places an order, the opportunity may be gone (other bots are competing)
- **Gas costs**: on-chain merge/split operations cost MATIC
- **Orderbook depth**: the size used may exceed available depth

The result: the dashboard shows inflated profits that give false confidence. You can't trust PnL numbers to evaluate whether a strategy actually works.

**Solution**: Apply realistic haircuts to simulated trades. Every `simulateTrade()` call should deduct estimated slippage, assume partial fill rates, and subtract gas costs.

**Existing SDK to reuse**:
- `MarketService.getProcessedOrderbook()` — check real orderbook depth at simulation time (`src/services/market-service.ts`)
- `ArbitrageService.getOrderbook()` — real-time depth for arb simulations (`src/services/arbitrage-service.ts:464`)

**Implementation outline**:
1. Replace `simulateTrade(profit, strategy, description)` with `simulateRealisticTrade(params)`:
   ```typescript
   function simulateRealisticTrade(params: {
     rawProfit: number;
     strategy: string;
     description: string;
     orderbookDepth?: number;    // available size on the book
     tradeSize?: number;         // intended trade size
     isOnChain?: boolean;        // merge/split = gas cost
   }) {
     let adjustedProfit = params.rawProfit;

     // 1. Slippage: assume 50% of raw profit lost to slippage
     adjustedProfit *= 0.5;

     // 2. Partial fill: if tradeSize > orderbookDepth, scale down
     if (params.orderbookDepth && params.tradeSize) {
       const fillRate = Math.min(1, params.orderbookDepth / params.tradeSize);
       adjustedProfit *= fillRate;
     }

     // 3. Gas cost: ~0.01 MATIC per on-chain tx (~$0.005)
     if (params.isOnChain) {
       adjustedProfit -= 0.01;
     }

     // 4. Competition: assume 30% of opportunities get taken by other bots first
     adjustedProfit *= 0.7;

     simulateTrade(adjustedProfit, params.strategy, params.description);
   }
   ```
2. Update all callers:
   - Arbitrage (line 499): pass `orderbookDepth` from the scanned market, set `isOnChain: true`
   - Smart money (line 451): apply slippage haircut
   - Direct trading (line 897): apply slippage haircut
3. Add a `simulationAccuracy` field to `BotState` dashboard that shows raw vs adjusted profit so users can see the gap

**Files to modify**:
- `bot-with-dashboard.ts` — rewrite `simulateTrade()`, update all 3 callers (~40 lines)

**Why this is high priority**: Without realistic simulation, you cannot evaluate whether any strategy improvement actually helps. This is the foundation for testing everything else. It was identified as the single highest-priority fix in the original analysis.

---

### Improvement 4: Adaptive Dip Arb Parameters + Conservative sumTarget (Medium Impact)

**Problem**: Three issues with DipArb parameters:
1. Static `dipThreshold`, `slidingWindowMs`, and `sumTarget` apply uniformly to BTC, ETH, and SOL despite different volatility profiles
2. The `sumTarget` of 0.92 is too aggressive — demands 8%+ profit per round, so Leg2 rarely fills. The standalone script had per-coin defaults (BTC: 0.95, ETH: 0.93, SOL/XRP: 0.85) but the bot uses a flat 0.92
3. No tiered entries — during a genuine crash, the bot enters once at the threshold and misses better prices if the dip continues

**Solution**: Per-coin parameter scaling, a more conservative `sumTarget` (0.96-0.97 for BTC, meaning 3-4% profit with much higher fill rates), and tiered entries that scale in as dips deepen.

**Existing SDK to reuse**:
- `BinanceService.getKLines(symbol, interval)` — already fetched for trend analysis (`src/services/binance-service.ts` via `bot-with-dashboard.ts:812-848`)
- `DipArbService.updateConfig()` — hot-reload config without restart (`src/services/dip-arb-service.ts:168`)
- `DipArbServiceConfig.dipThreshold` / `slidingWindowMs` / `sumTarget` — existing configurable parameters (`src/services/dip-arb-types.ts:45-64`)
- `DipArbServiceConfig.splitOrders` / `orderIntervalMs` — existing order splitting infrastructure (`src/services/dip-arb-types.ts:128-135`)

**Implementation outline**:
1. **Conservative sumTarget**: Change default from 0.92 to per-coin values matching the standalone script. For BTC: 0.96 (4% profit, high fill rate). For SOL/XRP: 0.90 (10% profit, lower fill rate is OK since these dip harder)
2. **Per-coin config overrides** in `CONFIG.dipArb`:
   ```typescript
   coinOverrides: {
     BTC: { dipThreshold: 0.20, slidingWindowMs: 5000, sumTarget: 0.96 },
     ETH: { dipThreshold: 0.30, slidingWindowMs: 5000, sumTarget: 0.94 },
     SOL: { dipThreshold: 0.40, slidingWindowMs: 3000, sumTarget: 0.90 },
     XRP: { dipThreshold: 0.40, slidingWindowMs: 3000, sumTarget: 0.90 },
   }
   ```
3. **Tiered entries**: Split the `shares` across multiple dip levels. Example for 30 shares: 10 shares at -15% dip, 10 more at -25%, final 10 at -35%. Use the existing `splitOrders` config to execute. This averages into a better price during genuine crashes
4. **Volatility scaling**: Add a `calculateVolatility(klines)` utility and scale `dipThreshold` proportionally via `updateConfig()` on each coin rotation

**Files to modify**:
- `bot-with-dashboard.ts` — apply per-coin overrides on auto-rotate, add volatility scaling in `setupBinanceAnalysis()` (~40 lines)
- `bot-config.ts` — add `dipArb.coinOverrides` config type, change default `sumTarget` from 0.92 to 0.96
- `src/services/dip-arb-types.ts` — add tiered entry config (`dipTiers: Array<{ threshold: number; sharesFraction: number }>`)

---

### Improvement 5: Direct Trading Position Management (Medium Impact)

**Problem**: Config defines `stopLossPct: 0.15`, `takeProfitPct: 0.25`, `trailingStopPct: 0.10`, `maxHoldDays: 7` but none are enforced. Positions opened by direct trading are never closed.

**Solution**: Add a position manager loop that checks open direct-trade positions against stop-loss/take-profit/trailing-stop/max-hold rules.

**Existing SDK to reuse**:
- `DataApiClient.getPositions(address)` — get current positions with `avgPrice` (`src/clients/data-api.ts`)
- `MarketService.getMarket(conditionId)` — get current price for PnL calculation (`src/services/market-service.ts`)
- `TradingService.createMarketOrder({ side: 'SELL' })` — close positions (`src/services/trading-service.ts`)
- `TradingService.getOpenOrders()` — check for pending orders (`src/services/trading-service.ts`)
- `TradingService.cancelAll()` — cancel stale limit orders (`src/services/trading-service.ts`)

**Implementation outline**:
1. Track direct trades in a `Map<string, DirectPosition>` with fields: `tokenId`, `conditionId`, `entryPrice`, `entryTime`, `size`, `highWaterMark`
2. On a 30-second interval (alongside `setupPortfolioManager`):
   - For each tracked position, fetch current price via `MarketService.getMarket()`
   - Calculate unrealized PnL percentage: `(currentPrice - entryPrice) / entryPrice`
   - Check rules:
     - **Stop-loss**: PnL% <= `-stopLossPct` → sell
     - **Take-profit**: PnL% >= `+takeProfitPct` → sell
     - **Trailing stop**: price dropped `trailingStopPct` from `highWaterMark` → sell
     - **Max hold**: `Date.now() - entryTime > maxHoldDays * 86400000` → sell
   - Execute sell via `TradingService.createMarketOrder()`
   - Record PnL via `recordTrade()`

**Files to modify**:

- `bot-with-dashboard.ts` — add position tracking in `setupDirectTrading()`, add check loop (~80 lines)
- `bot-config.ts` — config already exists, no changes needed

---

### Improvement 6: Cross-Strategy Position Ledger (Medium Impact)

**Problem**: Strategies operate independently with no awareness of each other's positions. This can cause over-exposure to a single market.

**Solution**: Create a shared `PositionLedger` that all strategies consult before opening positions and update after execution.

**Existing SDK to reuse**:
- `DataApiClient.getPositions(address)` — bootstrap ledger from on-chain state (`src/clients/data-api.ts`)
- `RealtimeServiceV2.subscribeUserEvents()` — real-time position updates (`src/services/realtime-service-v2.ts`)

**Implementation outline**:
1. Create a `PositionLedger` class:
   ```typescript
   class PositionLedger {
     private positions: Map<string, { totalSize: number; strategies: string[] }>;
     canOpen(conditionId: string, addSize: number, maxPerMarket: number): boolean;
     record(conditionId: string, size: number, strategy: string): void;
     remove(conditionId: string, size: number, strategy: string): void;
     getExposure(conditionId: string): number;
     getTotalExposure(): number;
   }
   ```
2. Initialize from `DataApiClient.getPositions()` on startup
3. Pass ledger reference to each strategy setup function
4. Each strategy calls `ledger.canOpen()` before placing orders and `ledger.record()` after execution
5. Use `CONFIG.capital.maxPerMarketPct` (already defined at `bot-with-dashboard.ts:33`) as the per-market cap

**Files to create**:
- `src/core/position-ledger.ts` — ~60 lines

**Files to modify**:
- `bot-with-dashboard.ts` — instantiate ledger, pass to each `setup*()` function, add checks before trade execution

---

### Improvement 7: Liquidity-Aware Position Sizing (Lower Impact)

**Problem**: `calculatePositionSize()` only considers consecutive wins/losses. It doesn't factor in orderbook depth, spread, or market liquidity, leading to potential slippage on large orders in thin markets.

**Solution**: Query orderbook depth before sizing and cap the order at a fraction of available liquidity.

**Existing SDK to reuse**:
- `MarketService.getProcessedOrderbook(conditionId)` — returns bid/ask depth with sizes (`src/services/market-service.ts`)
- `RealtimeServiceV2` orderbook cache — already maintained for subscribed markets (`src/services/realtime-service-v2.ts`)
- `ArbitrageService.getOrderbook()` — real-time orderbook state when arb is running (`src/services/arbitrage-service.ts:464`)

**Implementation outline**:
1. Add a `calculateLiquidityAdjustedSize()` function:
   ```typescript
   function calculateLiquidityAdjustedSize(
     baseSize: number,
     orderbook: ProcessedOrderbook,
     side: 'BUY' | 'SELL',
     maxDepthFraction: number = 0.3  // use at most 30% of available depth
   ): number {
     const availableDepth = side === 'BUY'
       ? orderbook.yes.askSize  // or no.askSize depending on token
       : orderbook.yes.bidSize;
     const liquidityLimit = availableDepth * maxDepthFraction;
     return Math.min(baseSize, liquidityLimit);
   }
   ```
2. Call this before `createMarketOrder()` in each strategy
3. If the liquidity-adjusted size falls below `CONFIG.capital.minOrderUsd`, skip the trade

**Files to modify**:
- `bot-config.ts` — add `calculateLiquidityAdjustedSize()` (~20 lines)
- `bot-with-dashboard.ts` — call the function before each `createMarketOrder()`

---

### Improvement 8: Market Making Strategy (High Impact — New Strategy)

**Problem**: The bot has no market making strategy. Market making is the highest long-term return potential strategy for prediction markets — providing liquidity by posting bid/ask quotes on both sides of the orderbook and earning the spread. All the infrastructure already exists (GTC limit orders, cancel management, tick sizes, real-time orderbook feeds) but is only used for execution, not as a standalone strategy.

**Solution**: Add a fifth strategy that posts resting limit orders on both sides of a market's orderbook, earning the spread when both sides fill. The key parameters are spread width, inventory limits, and trend-based skew.

**Existing SDK to reuse**:
- `TradingService.createLimitOrder()` — post GTC/GTD resting orders (`src/services/trading-service.ts:290`)
- `TradingService.getOpenOrders()` — track resting orders (`src/services/trading-service.ts`)
- `TradingService.cancelAll()` — cancel and requote when market moves (`src/services/trading-service.ts`)
- `RealtimeServiceV2.subscribeMarkets()` — real-time orderbook for midpoint tracking (`src/services/realtime-service-v2.ts`)
- `MarketService.getProcessedOrderbook()` — initial orderbook state (`src/services/market-service.ts`)
- `roundPrice()` — snap prices to valid tick sizes (`src/utils/price-utils.ts:36`)
- `BinanceService.getKLines()` — trend signal for skewing quotes (`src/services/binance-service.ts`)

**Implementation outline**:
1. Create `setupMarketMaking(sdk)` in `bot-with-dashboard.ts`:
   - Select high-volume, liquid markets via `GammaApiClient.getMarkets({ order: 'volume24hr' })`
   - For each market, compute the midpoint from the orderbook
   - Post a BUY limit order at `midpoint - halfSpread` and a SELL limit order at `midpoint + halfSpread`
   - When both sides fill, profit = spread. When only one side fills, accumulate inventory
2. Inventory management:
   - Track net position per market. If net long > `maxInventory`, stop posting bids (only offer asks)
   - If net short > `maxInventory`, stop posting asks (only offer bids)
   - Apply trend-based skew: if Binance trend is bullish, shift quotes upward (wider ask, tighter bid)
3. Requoting loop (every 5-10 seconds):
   - Cancel stale orders via `cancelAll()`
   - Recompute midpoint from live orderbook
   - Post fresh quotes at new midpoint +/- spread
4. Key parameters:
   ```typescript
   marketMaking: {
     enabled: boolean;
     spreadBps: number;           // e.g., 200 = 2% total spread (1% each side)
     maxInventory: number;        // max net position before one-sided quoting
     requoteIntervalMs: number;   // how often to refresh quotes (5000-10000)
     minVolume24h: number;        // only make markets on liquid markets
     trendSkewBps: number;        // how much to skew quotes based on trend
   }
   ```

**Files to modify**:
- `bot-with-dashboard.ts` — add `setupMarketMaking()` function (~100 lines)
- `bot-config.ts` — add `marketMaking` config section

---

### Improvement 9: Resolution Timing / Expiry Strategy (Medium Impact — New Strategy)

**Problem**: Prediction markets have known resolution dates. As resolution approaches, the dominant outcome's price converges toward $1.00 and the losing side converges toward $0.00. This creates a predictable price movement that no current strategy exploits.

**Solution**: Buy the dominant side at $0.90-0.95 when resolution is near (within days/hours), and collect the convergence to $1.00. Alternatively, buy cheap long-shot tokens at $0.02-0.05 for asymmetric upside on markets with uncertain outcomes.

**Existing SDK to reuse**:
- `GammaApiClient.getMarkets()` — returns `endDate: Date` for each market (`src/clients/gamma-api.ts:145`), can sort by `endDate`
- `GammaApiClient.getMarkets({ order: 'endDate' })` — find markets expiring soon (`src/clients/gamma-api.ts:276`)
- `MarketService.getProcessedOrderbook()` — check price and liquidity (`src/services/market-service.ts`)
- `TradingService.createLimitOrder()` — enter with limit orders at target price (`src/services/trading-service.ts`)
- `CTFClient.redeem()` — redeem winning tokens after resolution (`src/clients/ctf-client.ts`)

**Implementation outline**:
1. Create `setupExpiryStrategy(sdk)` in `bot-with-dashboard.ts`:
   - Periodically scan for markets where `endDate` is within a configurable window (e.g., 1-7 days)
   - For each expiring market, check the dominant outcome price:
     - **Convergence play**: If dominant side is at $0.90-0.95 and resolution is < 3 days, buy with a limit order. Expected return: 5-10% over a few days
     - **Long-shot play**: If a non-dominant outcome is at $0.02-0.05 and the market outcome is genuinely uncertain (e.g., multiple close candidates), buy a small position for asymmetric upside
   - After resolution, call `CTFClient.redeem()` to collect winnings
2. Risk controls:
   - Max exposure per expiring market (e.g., 5% of capital)
   - Only enter if liquidity is sufficient (check orderbook depth)
   - Skip markets already held by other strategies (use position ledger if available)
3. Key parameters:
   ```typescript
   expiry: {
     enabled: boolean;
     maxDaysToExpiry: number;      // scan window (default: 7)
     convergenceMinPrice: number;  // minimum dominant price to enter (default: 0.90)
     longShotMaxPrice: number;     // maximum price for long-shot plays (default: 0.05)
     maxPerMarketPct: number;      // max capital per market (default: 0.05)
   }
   ```

**Files to modify**:
- `bot-with-dashboard.ts` — add `setupExpiryStrategy()` (~80 lines)
- `bot-config.ts` — add `expiry` config section

---

### Improvement 10: Backtesting Framework (Lower Impact — Infrastructure)

**Problem**: Strategies use hardcoded parameters (dip thresholds, profit thresholds, spread widths) without historical validation. There is no way to replay past market data through the strategy logic to verify these parameters produce positive returns before deploying with real capital.

**Solution**: Build a lightweight replay framework that feeds historical orderbook/price data into strategy functions and records simulated PnL.

**Existing SDK to reuse**:
- `DataApiClient.getTrades()` — historical trade data (`src/clients/data-api.ts`)
- `BinanceService.getKLines()` — historical price candles (`src/services/binance-service.ts`)
- `GammaApiClient.getMarkets()` — historical market metadata (`src/clients/gamma-api.ts`)
- Strategy functions are already structured as event handlers (receive orderbook update → emit signal) which makes them natural to replay

**Implementation outline**:
1. Create `src/backtest/replay.ts`:
   - `ReplayEngine` class that loads historical data and feeds it to strategy functions at simulated timestamps
   - Accepts a strategy adapter interface: `onOrderbook(snapshot)`, `onPrice(price)`, `onTick(timestamp)`
   - Tracks simulated positions, fills, and PnL with realistic slippage (ties into Improvement 3's simulation realism)
2. Create `src/backtest/adapters/` — one adapter per strategy:
   - `arb-adapter.ts` — feeds orderbook snapshots to `checkArbitrage()` / `checkMultiOutcomeArb()`
   - `dip-arb-adapter.ts` — feeds price updates to dip detection logic
3. CLI runner: `npx tsx scripts/backtest.ts --strategy=dip-arb --coin=BTC --days=30`
4. Output: total PnL, win rate, max drawdown, Sharpe ratio, parameter sensitivity

**Files to create**:
- `src/backtest/replay.ts` — replay engine (~150 lines)
- `src/backtest/adapters/arb-adapter.ts` (~50 lines)
- `src/backtest/adapters/dip-arb-adapter.ts` (~50 lines)
- `scripts/backtest.ts` — CLI entry point (~40 lines)

---

## Priority and Dependency Ordering

| Priority | Improvement | Dependencies | Rationale |
|----------|------------|--------------|-----------|
| **1** | #3 Simulation Realism Fix | None | Foundation — without realistic simulation, you can't trust PnL to evaluate any other improvement. Must be done first |
| **2** | #1 Position-Based Smart Money | None | Highest strategy impact — fixes latency problem and exit tracking for 60% of capital allocation |
| **3** | #2 Multi-Outcome Arbitrage | None | Largest opportunity expansion — opens access to all multi-outcome markets currently skipped |
| **4** | #8 Market Making | None | Highest long-term return potential — new strategy using entirely existing infrastructure |
| **5** | #4 Adaptive DipArb + sumTarget | None | Quick win — changing sumTarget from 0.92 to 0.96 alone would dramatically increase Leg2 fill rates |
| **6** | #5 Direct Trading Position Mgmt | None | Required for direct trading to be safe — enforces the stop-loss/take-profit config that already exists |
| **7** | #9 Resolution Timing | None | New low-risk strategy — convergence plays on expiring markets are mathematically predictable |
| **8** | #6 Cross-Strategy Position Ledger | Benefits from #1, #5 | Risk infrastructure — prevents over-exposure. Most valuable after strategies have proper position tracking |
| **9** | #7 Liquidity-Aware Position Sizing | #6 (optional) | Polish — reduces slippage. Benefits from the position ledger but works standalone |
| **10** | #10 Backtesting Framework | #3 (simulation realism) | Validates all parameter choices historically. Depends on realistic simulation to produce trustworthy results |

**Parallel execution groups:**
- **Group A** (can start immediately, in parallel): #3 Simulation Realism, #1 Position-Based Smart Money, #2 Multi-Outcome Arb, #4 DipArb sumTarget fix
- **Group B** (after Group A): #8 Market Making, #5 Direct Trading Position Mgmt, #9 Resolution Timing
- **Group C** (after Group B): #6 Position Ledger, #7 Liquidity Sizing, #10 Backtesting
