---
name: polymarket-strategy
description: >
  Domain knowledge for the Polymarket trading bot — the 2026 fee model and exact formula,
  per-strategy edge classification, market-making design rules (inventory skew, fill-to-mark),
  backtest validation requirements (anti-look-ahead, walk-forward), and go-live/kill gates.
  Load whenever working on this bot's strategies: arbitrage, market making, dip-arb,
  smart-money, expiry/convergence, fee/slippage/cost modeling, simulation realism, or
  any decision about whether a strategy is profitable after costs.
---

# Polymarket Strategy Knowledge

The single organizing idea: this is **one business — be the patient, subsidized liquidity
provider on markets nobody is fighting over.** Edge that survives this venue is maker-side
liquidity provision on low-toxicity markets, not latency races.

## 1. Fee model (the fact that reframes everything)

Polymarket is NOT fee-free. Dynamic **taker** fee:

```
fee = C × feeRate × p × (1 − p)        # peaks at share price p = 0.50
```

| Category          | Taker feeRate     | Maker                     |
| ----------------- | ----------------- | ------------------------- |
| Crypto            | 1.80% (highest)   | 0%                        |
| Economics         | 1.50%             | 0%                        |
| Mentions          | ~1.56%            | 0%                        |
| Culture / Weather | 1.25%             | 0%                        |
| Finance           | 1.00%             | 0% + **50% maker rebate** |
| Politics / Tech   | 1.00%             | 0%                        |
| Sports            | 0.75%             | 0%                        |
| Geopolitics       | **0% (fee-free)** | 0%                        |

> Always confirm current rates against Polymarket's official fee page before sizing.

Implications: (1) makers pay zero and earn rebates — every market order pays a fee a limit
order would earn; (2) fees are highest exactly where latency-arb lives (crypto, near $0.50),
by design. Gas on Polygon ≈ $0.003–0.005/tx.

## 2. Edge map (risk-adjusted, net of costs)

| Strategy             | Edge class | Decision          | Why                                                                                                      |
| -------------------- | ---------- | ----------------- | -------------------------------------------------------------------------------------------------------- |
| Market Making        | Moderate   | **BUILD (core)**  | maker rebate + spread on low-toxicity markets; only structural edge                                      |
| Convergence (expiry) | Weak       | BUILD (small)     | real but thin risk-premium; maker entry = fee-free; negative skew → diversify across uncorrelated events |
| Binary Arb           | Weak       | KEEP maker-only   | real math, but post resting orders; don't race takers; learning not profit center                        |
| Smart Money          | Weak/None  | CONVERT to signal | leaderboards = survivorship bias; always last in; use as market-selection feature only                   |
| Multi-Outcome Arb    | Weak       | PARK              | leg risk across N non-atomic books > edge                                                                |
| DipArb               | None/Weak  | **KILL**          | fee-targeted crypto, latency-doomed, Binance↔Chainlink basis risk                                        |
| Direct Trading       | None       | **KILL**          | no demonstrated predictive signal + unenforced stops                                                     |

When classifying any strategy: name the counterparty and why they leave money available.
If you can't, the edge is probably noise.

## 3. Market making rules (the one book worth building)

**Selection (most of the edge):** geopolitics (fee-free) > finance (50% rebate) > liquid
politics/sports. Never crypto, never breaking-news. Mid in [0.20, 0.80]. Adequate depth both
sides. Not within `minHoursToResolution`. Blacklist markets with adverse fill-to-mark drift.

**Quoting — inventory-skewed reservation price, NOT mid±spread:**

```
mid         = (bestBid + bestAsk)/2
inv         = q / qMax                      # signed normalized inventory
reservation = mid - inv * skewWidth         # lean toward flattening
halfSpread  = baseHalfSpread + volTerm      # widen in vol / thin books
bid = roundPrice(reservation - halfSpread)
ask = roundPrice(reservation + halfSpread)
```

At caps: `q≥+qMax` → bids only-off (ask only); `q≤−qMax` → ask off (bid only).

**Requote = event-driven** (orderbook tick / off-top / inventory band crossed), never a 5–10s
timer (you get picked off between ticks).

**Hard caps (enforced, not config-only):** per-market `maxInventoryShares`, portfolio
`maxGrossExposureUsd`, per-event-cluster cap. Kill switch flattens + blacklists on excess loss.

**Live-or-die metric — fill-to-mark drift:** after each fill, sample mid at +5/15/30s.
`driftBps = (mid(t+Δ) − fillPrice)/fillPrice × 10000 × sign(side)`. Positive = non-toxic flow
(add capital); negative = adverse selection (widen/slow/blacklist).

**PnL = realized spread + modeled rebate + inventory MtM + resolution PnL − flatten fees.**

## 4. Backtest validation (non-negotiable invariants)

- **Fix the simulator first:** add real per-category taker fee to every taker leg; arb pays it
  twice; makers pay 0 and accrue rebate. Until done, all PnL is fiction.
- **Record the right feeds:** arb/MM market orderbooks (currently the arb-specific WS
  connections aren't recorded) — without them the arb backtest is impossible.
- **Anti-look-ahead:** decision at time t uses only state with ts ≤ t; resolution outcome never
  readable by entry logic; maker fills only when book trades through the price; taker fills walk
  the book (not best price for full size).
- **Walk-forward / out-of-sample:** tune on train, measure on held-out validate; never report
  in-sample PnL as expected performance.
- **Cap parameters:** a 2–4 week sample cannot support a 4-D grid. Tune ≤2 params at a time,
  prefer a flat profit plateau over a peak. Watch survivorship/selection/look-ahead/overfit.

## 5. Go-live gates (all must hold) & kill criteria

**Gates:** (1) fees + rebates in simulator; (2) walk-forward, robust params; (3) small param
count; (4) dry-run fill-to-mark ≥ 0 on targets; (5) hard caps coded & tested.

**Kill:** 30-day net PnL negative → size to zero; persistent adverse drift → blacklist/exit;
realized rebates ≪ model → re-validate.

## 6. Key files in this repo

- `bot-with-dashboard.ts` — strategy setup + `simulateRealisticTrade()` + dashboard
- `src/services/arbitrage-service.ts`, `dip-arb-service.ts`, `smart-money-service.ts`
- `src/services/realtime-service-v2.ts` — WS feeds + where recording belongs
- `src/services/trading-service.ts` — `createLimitOrder` / `cancelAll` / `getOpenOrders`
- `src/services/market-service.ts` — `getProcessedOrderbook`
- `src/utils/price-utils.ts` — `checkArbitrage`, `roundPrice`
- `bot-config.ts` — config + position sizing

## Companion docs

`00_MASTER_PLAN.md`, `01_MARKET_MAKING_SPEC.md`, `02_VALIDATION_AND_TESTING.md` hold the full plan.

Posture: skeptical proprietary-desk reviewer. Never assume a strategy works. Quantify, net of
costs, and refuse to greenlight capital until the gates pass.
