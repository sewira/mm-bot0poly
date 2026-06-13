---
name: polymarket-strategy
description: >
  Domain knowledge for the Polymarket trading bot — the 2026 fee model and exact formula,
  per-strategy edge classification, market-making v2 design principles (microprice, convex
  inventory skew, circuit breaker, fill-to-mark), the four-log record system, backtest
  validation requirements (anti-look-ahead, walk-forward), and go-live/kill gates.
  Load whenever working on this bot's strategies, fee/slippage/cost modeling, simulation
  realism, grading/review rituals, or any decision about profitability after costs.
---

# Polymarket Strategy Knowledge

**Current stage: dry-run (paper, $100 capital).** First results: 7 fills / 17h, $0.10 gross, negative drift on all fills. (mm-librarian updates this line on gate transitions.)

The single organizing idea: this is **one business — be the patient, subsidized liquidity
provider on markets nobody is fighting over.** Edge that survives this venue is maker-side
liquidity provision on low-toxicity markets, not latency races.

## 0. Authority order (on any conflict)

```
logs/data > 03_MM_STRATEGY_V2.md > 02_VALIDATION_AND_TESTING.md > 00_MASTER_PLAN.md
        > 01_MARKET_MAKING_SPEC.md (quoting sections superseded by 03) > this skill
        > agent prompts > anyone's memory
```

This skill holds durable PRINCIPLES. Tunable numbers, thresholds, and config live in the
docs and `bot-config.ts` — read them fresh; never cite a parameter value from this file.

## 1. Fee model (the fact that reframes everything)

Polymarket is NOT fee-free. Dynamic **taker** fee:

```
fee = C × feeRate × p × (1 − p)        # peaks at share price p = 0.50
```

Reference rates (Fee Structure V2, effective 2026-03-30 — ALWAYS confirm current values
on Polymarket's official fee page before any sizing decision; rates change):
Crypto feeRate 0.07 (20% maker rebate) > Economics/Culture/Weather/Other 0.05 (25%)
> Finance/Politics/Tech/Mentions 0.04 (25%) > Sports 0.03 (25%)
> **Geopolitics 0.00 (fee-free, no rebate)**. Makers pay 0 taker fee everywhere.
**Every fee-bearing category now pays a maker rebate** -- all non-crypto at 25%, crypto at 20%.
**Grandfathering:** fees/rebates apply only to markets deployed on or after the activation
date (2026-03-30); pre-existing markets are unaffected. (Rates verified 2026-06-13.)
**Exchange V2 (2026-04-28):** collateral migrated from USDC.e to pUSD (1:1 USDC-backed).
Maker rebates paid in pUSD. **Taker Rebate Program (2026-05-28):** tiered taker rebates
(up to 50% at Obsidian tier) -- does not directly affect maker strategy but may reduce
the maker rebate pool. Monitor via realized-vs-modeled rebate check.
Gas on Polygon approx $0.003–0.005/tx.

Implications: (1) every market order pays a fee a limit order would earn; (2) fees peak
exactly where latency-arb lives (crypto, near $0.50); (3) **the entire structural edge is
a venue policy choice — a rebate/fee change is a regime-kill event requiring re-validation
from the dry-run stage (03 §9 kill criteria).**

## 2. Edge map (risk-adjusted, net of costs)

| Strategy             | Edge class | Decision          | Why |
| -------------------- | ---------- | ----------------- | --- |
| Market Making        | Moderate   | **BUILD (core)**  | maker rebate + spread on low-toxicity markets; only structural edge |
| Convergence (expiry) | Weak       | BUILD (small, after MM green) | thin risk-premium; maker entry fee-free; negative skew → per-cluster caps mandatory |
| Binary Arb           | Weak       | KEEP maker-only   | post resting orders; learning, not profit center |
| Smart Money          | Weak/None  | CONVERT to signal | survivorship-biased leaderboards; always last in; market-selection feature only |
| Multi-Outcome Arb    | Weak       | PARK              | leg risk across N non-atomic books > edge |
| DipArb               | None       | **KILLED**        | fee-targeted crypto, latency-doomed, Binance↔Chainlink basis risk |
| Direct Trading       | None       | **KILLED**        | no demonstrated signal + unenforced stops |

When classifying any strategy: name the counterparty and why they leave money available.
If you can't, the edge is probably noise.

## 3. Market making v2 principles (full spec: 03 §1–§5)

**PnL priority order — build and tune in this order, never optimize a lower tier while
a higher one is unmeasured:**
selection & schedule > event-day survival > fill quality > quote placement > spread math.

**Selection (most of the edge):** fee-free geopolitics > finance/politics/sports/economics
(all 25% rebate). Never crypto, never breaking-news. Price band per doc; tighten near
expiry. Per-market per-hour drift schedules once data exists. Capital allocated
continuously by edgeScore, not binary blacklists (blacklist remains the hard floor).

**Quoting:** center on **microprice** (depth-weighted), not mid. **Convex** inventory
skew (gentle near flat, aggressive near cap). **Asymmetric size** as the second
flattening lever. Per-category **rebate-aware spread floors** (every fee-bearing category
has a rebate at 25% or 20%; rebate markets support tighter floors). Queue-position
awareness: deep-in-queue at an eroding level → cancel; prefer fronting a new tick
over joining a crowd.

**Requote = event-driven** (book tick / off-top / inventory band), never a timer.
**News circuit breaker:** mid jump beyond threshold within window → cancelAll + cooldown.
During real news the correct spread is infinite. **Stale-feed guard:** silent feed →
pull quotes. Breaker + guard must exist before any live order path.

**Hard caps enforced in the order path, not config-only:** per-market inventory
(one-sided quoting at cap), portfolio gross, per-event-cluster, kill switch.

**Live-or-die metric — fill-to-mark drift:** sample mid at +5/15/30s after each fill.
`driftBps = (mid(t+Δ) − fillPrice)/fillPrice × 10000 × sign(side)`. Positive = the flow
feeds you; negative = you are the product. The +15s per-market mean ± SE is the god
metric for routing, grading, and killing.

**PnL = realized spread + rebate (modeled, then reconciled vs realized) + inventory MtM
+ resolution PnL − flatten fees.**

## 4. The record system (03 §8 — institutional memory)

Four append-only JSONL logs: **fills** (with queuePosAtPost, hourBucket, drift backfill),
**daily snapshots** (every row tagged configHash + regime + stage — never a number
without its context), **decision journal** (every human decision AT decision time, with
expected effect and a review date; NO-CHANGE entries are first-class), **incidents**
(every breaker/kill/outage + the next 60s of market action).
Rules: no UPDATE path — history is corrected by new entries, never edits. Full config
saved per hash. Review cadence: daily 3-liner / weekly drift / monthly written verdict
(SCALE/HOLD/RESTRICT/KILL + a falsifiable prediction graded next month).

## 5. Backtest validation (non-negotiable invariants)

- **Anti-look-ahead:** decision at t uses only state ts ≤ t; resolution never readable
  by entry logic; maker fills only when the book trades THROUGH the price; taker fills
  walk the book level by level. Assertions in code, not comments.
- **Walk-forward / out-of-sample:** tune on train, measure on held-out validate; never
  report in-sample PnL as expectation. Segment by fee regime — never pool across one.
- **Cap parameters:** tune ≤2 at a time; prefer flat profit plateaus over peaks.
- **Statistical honesty:** <100 fills per market = UNPROVEN = untradeable. Drift green
  requires mean − 1×SE above threshold. One-week edges in multi-week windows are noise.
- Traps checklist: survivorship, selection, look-ahead, overfitting, regime change.

## 6. Gates & kill criteria (binary — partial green is red)

**Stages:** backtest → 2wk dry-run → small pilot (measure, not earn) → stepped scaling.
**Go-live gates (all):** fees+rebates in simulator; walk-forward robust params; small
param count; dry-run drift ≥ 0 on targets; hard caps coded & tested.
**Kill:** 30-day net PnL negative → size zero; persistent adverse drift → restrict then
blacklist; realized rebates ≪ model → halt scaling, re-validate; **regime change →
full stop + re-validate.** If the pilot is red across markets, the answer is STOP, not
tune — the problem is the flow, not the math (03 §10).

## 7. Key files in this repo

- `bot-with-dashboard.ts` — strategy setup + `simulateRealisticTrade()` + dashboard; SDK init: `new PolymarketSDK()` + `initialize()` (not `create()`); ws-live-data only connected when non-MM strategies enabled
- `src/services/realtime-service-v2.ts` — WS feeds + recording path
- `src/services/trading-service.ts` — `createLimitOrder` / `cancelAll` / `getOpenOrders`
- `src/services/market-service.ts` — `getProcessedOrderbook`
- `src/utils/price-utils.ts` — `checkArbitrage`, `roundPrice`
- `bot-config.ts` — config + position sizing
- `logs/` — fills / snapshots / journal / incidents / configs

## Companion docs & agents

Docs: `00_MASTER_PLAN.md`, `01_MARKET_MAKING_SPEC.md` (quoting superseded by 03),
`02_VALIDATION_AND_TESTING.md`, `03_MM_STRATEGY_V2.md` (current authority).
Agents: mm-strategist (strategy verdicts) · mm-builder (implementation) · mm-grader
(metrics, gates) · mm-reviewer (rituals, journal) · mm-librarian (sync — sole editor
of this file) · polymarket-quant (red-team code audit, read-only).

Posture: skeptical proprietary-desk. Never assume a strategy works. Quantify, net of
costs, and refuse to greenlight capital until the gates pass. Killing cleanly on the
pre-committed criteria is a success mode.
