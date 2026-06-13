# Master Plan — Polymarket Bot

**Author's stance:** brutally honest, real money at risk, quant-trader lens.
**One-line thesis:** This is not six strategies. It is one business — *be the patient, subsidized liquidity provider on markets nobody is fighting over.* Everything that survives Polymarket's 2026 fee regime is a flavor of that. Everything else is a latency race you lose.

---

## 0. The fact that reframes everything

Polymarket is no longer fee-free. As of 2026 it runs a **dynamic taker-fee** model:

```
fee = C × feeRate × p × (1 − p)        # peaks at p = 0.50
```

| Category | feeRate | Maker Rebate Share | Peak Fee /100sh @p=0.50 | Notes |
|---|---|---|---|---|
| Crypto | 0.07 | 20% | $1.75 | highest fee; designed to kill latency arb |
| Economics | 0.05 | 25% | $1.25 | |
| Culture/Weather/Other | 0.05 | 25% | $1.25 | |
| Finance/Politics/Tech/Mentions | 0.04 | 25% | $1.00 | (Finance was 50% at V2 launch; current docs show 25% as of 2026-06-13 -- verify) |
| Sports | 0.03 | 25% | $0.75 | |
| **Geopolitics** | **0.00 (fee-free)** | N/A | $0.00 | trade the spread tax-free |

> **Grandfathering:** fees only apply to markets deployed on or after the activation date (March 30, 2026). Pre-existing markets are unaffected.
> Confirm exact current rates against Polymarket's official fee page before sizing. These move. (Fee Structure V2, verified 2026-06-13. Note: Exchange V2 migrated to pUSD collateral on 2026-04-28; Taker Rebate Program launched 2026-05-28.)

**Two consequences that drive the whole plan:**
1. **Makers pay zero and get paid rebates on every fee-bearing category.** Takers pay. So every market order you fire is paying a fee a limit order would *earn*. Flip to maker posture everywhere possible. All non-crypto fee-bearing categories pay 25% maker rebate; crypto pays 20%. (Rates verified 2026-06-13.)
2. **Fees are highest exactly where your two most-built strategies live** (crypto, near $0.50). The house engineered this to kill latency arbitrage. You are the prey.

---

## 1. What's wrong (ranked by severity)

1. **Your simulator omits taker fees.** `simulateRealisticTrade()` applies 0.5× slippage and 0.7× competition but no explicit fee. Your "realistic" PnL is still fiction, biased optimistic. **You are optimizing against a number that isn't real.** This is the #1 problem — fix before trusting anything.
2. **No backtester exists.** No parameter (dipThreshold, sumTarget, profitThreshold, spreadBps) has *ever* been validated against history. Every threshold is a guess presented as a setting.
3. **The arb-specific orderbook feeds aren't even recorded** (your own docs admit it). So the data you're collecting cannot validate the arb strategy. You're recording the wrong thing for half your book.
4. **DipArb trades the fee-targeted graveyard.** Crypto 15-min markets, highest taker fee (feeRate 0.07), racing HFT, with Binance-vs-Chainlink basis risk. Structurally doomed.
5. **Direct Trading has no edge** — your own doc says the Binance→PM signal has no demonstrated predictive value. It's a coin flip with unenforced stops (blow-up risk).
6. **Reactive Smart Money is always last in.** By the time you copy, price moved. Leaderboards are survivorship bias. Positions accumulate with no exit.
7. **Market making — the one real edge — isn't built**, and the planned design (5–10s timer requote, symmetric `mid ± spread`) is the naive version that gets picked off.

---

## 2. What's actually good

- **The maker-rebate opportunity exists and aligns with the venue.** This is a genuine, platform-paid edge. Most of the plan funnels here.
- **Dry-run + recording discipline is correct** (just incomplete — record the right feeds).
- **Infra reuse is real:** GTC limit orders, cancelAll, tick rounding, real-time orderbook, position polling — everything market making needs is already in the SDK.
- **Honest internal docs.** You diagnosed your own latency and simulation flaws. Rare and valuable.

---

## 3. Kill / keep / build

| Strategy | Decision | Why |
|----------|----------|-----|
| **Market Making** | **BUILD (core book)** | Only structural edge: rebates + spread on low-toxicity markets |
| **Expiry / Convergence** | **BUILD (small satellite)** | Real but thin risk-premium; maker entry = fee-free; negative skew, must diversify |
| **Binary Arbitrage** | **KEEP as maker-only, low expectation** | Real math, but post resting orders; don't race takers. Treat as learning, not profit center |
| **Smart Money** | **CONVERT to research signal** | Never fires its own order. Feeds market-selection / inventory tolerance for the MM book |
| **Multi-Outcome Arb** | **PARK** | Leg risk across N non-atomic books > the edge. Revisit only after MM works |
| **DipArb** | **KILL** | Fee-targeted, latency-doomed, basis risk |
| **Direct Trading** | **KILL** | No edge by your own admission + blow-up risk |

---

## 4. What you actually trade

- **Primary capital → market making** on **fee-free (geopolitics)** and **rebate-bearing (finance/politics/sports, 25%)** markets.
- **Quote band per config `priceBand`** (currently [0.10, 0.90] for dry-run exploration; see 03 §2). Never hold inventory into the 0/1 tails — that's where binaries jump on resolution and gut MM books.
- **Avoid crypto and breaking-news markets entirely** for MM. Toxic flow + max fees.
- **Satellite → convergence** on favorites at 0.92–0.97 within days of resolution, maker orders, diversified across *uncorrelated* events.

---

## 5. The metric you live or die by

**Fill-to-mark drift.** After a fill, where is the mid 5–30s later?
- Drift in your favor → market is feeding you → add capital.
- Drift against you → you're being adversely selected → widen, slow, or blacklist.

Measure per-market, rank constantly, route capital by it. This single number decides whether MM works. (Spec in `01_MARKET_MAKING_SPEC.md`.)

---

## 6. Roadmap (do in this order)

**Phase 0 — Make the truth measurable (week 1). Nothing live until done.**
- [ ] Add the real fee formula to `simulateRealisticTrade()` per category. (`bot-with-dashboard.ts`)
- [ ] Record arb/MM orderbook feeds, not just `sdk.realtime`. (`src/services/realtime-service-v2.ts`)
- [ ] Delete DipArb + Direct Trading setup paths. Reclaim the time.

**Phase 1 — Build the validator (weeks 1–3).**
- [ ] ReplayEngine with strict anti-look-ahead + walk-forward split. (See `02_VALIDATION_AND_TESTING.md`)
- [ ] Fill-to-mark instrumentation in dry-run.
- [ ] Backtest convergence + maker-arb on recorded data.

**Phase 2 — MM prototype, tiny size (weeks 3–6).**
- [ ] `setupMarketMaking()` with inventory-skew quoting + event-driven requote. (`01_MARKET_MAKING_SPEC.md`)
- [ ] Live on fee-free geopolitics, **$2–5k total**, goal = *measure*, not earn.
- [ ] Convert Smart Money to a market-selection feature.

**Phase 3 — Scale what survives (week 6+).**
- [ ] Add finance/politics/sports/economics (all 25% rebate) once fill-to-mark is positive.
- [ ] Add convergence satellite with event-cluster exposure caps.
- [ ] Only then revisit multi-outcome arb.

---

## 7. Go-live gates (no capital until ALL true)

1. Simulator includes real per-category taker fees.
2. Backtest is walk-forward / out-of-sample, not in-sample fit.
3. Parameter count is small relative to sample (no 4-D grid on 2 weeks of data).
4. Dry-run fill-to-mark drift is non-negative on the target markets.
5. Hard caps coded: max net inventory per market, portfolio gross cap, per-event-cluster cap.

## 8. Kill criteria (defined upfront so you don't rationalize a losing book)

- 30-day live PnL net of all costs is negative → cut size to zero, back to research.
- Fill-to-mark drift persistently against you on chosen markets → blacklist or exit.
- Realized rebates materially below model → re-check market selection; the edge may be gone.

---

## 9. Honest expectations

The realistic ceiling, run *well*, is a **small, capacity-constrained, rebate-subsidized MM book** making modest returns (target low-double-digit annualized, Sharpe ~1–1.5 *if* it works) on a handful of liquid, low-toxicity markets. Prediction-market MM does **not** scale to large AUM — books are thin. This is a grind, not a printer. The fantasy (arb + dip-catching at scale) is where retail bots donate to faster players. Build the boring version. Protect it ruthlessly.
