# Market Making Strategy v2 — The One Book

**Status: DRY-RUN (paper, $100 capital).** First results: 7 fills / 17h, $0.10 gross, negative drift on all fills. This supersedes the quoting logic in `01_MARKET_MAKING_SPEC.md`. Market selection, risk caps, and validation gates from the original spec and `02_VALIDATION_AND_TESTING.md` remain in force. Everything here is pre-validation design — no number in this file is trusted until the dry-run says so.

**Thesis:** Be the patient, subsidized liquidity provider on markets nobody is fighting over. The edge is venue-paid (maker rebates + fee-free categories) plus spread capture from benign retail flow. You win by *selection and survival*, not speed or cleverness.

**Honest prior:** ~50–55% this makes money on Polymarket at all. The dominant uncertainty is whether enough benign flow exists on fee-free/rebate markets — an empirical question only the dry-run answers. The upgrades below raise the *conditional* probability (if the flow exists, you capture it and survive event days). They do not guarantee the flow exists.

---

## 1. Where the PnL actually comes from (priority order)

1. **Market & schedule selection** — quoting only benign markets, only at benign hours. Worth more than everything below combined.
2. **Not dying on event days** — an MM book's year is steady accrual minus 3–4 bad days. Delete the bad days.
3. **Fill quality** — queue position determines whether your fills are income or poison.
4. **Quote placement** — microprice centering + nonlinear inventory skew.
5. **Spread math refinements** — last, and only if the data asks for them.

Build and tune in that order. A dumb fixed spread in a benign market beats perfect Avellaneda–Stoikov in a toxic one.

---

## 2. Market selection (unchanged core + schedule layer)

Quote only markets passing ALL:

| Filter | Rule |
|---|---|
| Category | geopolitics (fee-free) > finance/politics/sports/economics (25% maker rebate each) > culture/weather/other (25% rebate). Never crypto (20% rebate, max fee + toxic flow), never breaking-news. |
| Liquidity | 24h volume ≥ `minVolume24h`; depth both sides ≥ `minDepthShares` |
| Price band | mid in [`priceBand`] (currently [0.10, 0.90] in config); tighten to [0.30, 0.70] inside 24h to resolution |
| Time to resolution | ≥ `minHoursToResolution` (12h), with sloped spread widening inside 48h (§4.4) |
| Toxicity | rolling fill-to-mark drift ≥ 0 after warmup |
| Grandfathering | Only markets deployed on or after March 30, 2026 carry V2 fees/rebates. Pre-existing markets have no taker fees and no maker rebates — fee-free but also rebate-free. Filter accordingly: a "finance" market from January 2026 earns zero rebate. |

**NEW — quoting schedule per market:** segment fill-to-mark drift by hour-of-day (UTC buckets) and by event proximity. A market can be benign at 03:00 UTC and toxic during US market hours. Once data exists, quote each market only in its non-toxic windows. This is free money and zero code risk.

**NEW — continuous capital allocator (replaces binary blacklist):**

```
edgeScore(market) = E[spreadCapture bps/fill] + rebate bps/fill + meanDriftBps
```

Allocate quote size proportional to `edgeScore`, re-ranked daily. Blacklist remains as the hard floor (drift persistently < −X bps), but capital drains out of decaying markets continuously, weeks before the blacklist would trip.

---

## 3. Quoting logic v2

### 3.1 Center on microprice, not mid

```
microprice = (bestBid × askSize + bestAsk × bidSize) / (bidSize + askSize)
```

Book imbalance is the cheapest adverse-selection predictor available. Centering on microprice means you stop quoting a stale ask into a rising book. One line of code; keep `mid` for marking/PnL, use `microprice` for quote placement.

### 3.2 Nonlinear inventory skew

```
inv         = q / qMax                       # -1..+1
skew        = inv × |inv| × skewWidth        # convex: gentle near flat, hard near cap
reservation = microprice − skew
```

Linear skew either gives up spread when nearly flat or under-reacts near the cap. Convex skew captures more at low inventory and flattens aggressively exactly when jump risk matters.

### 3.3 Asymmetric size (second flattening lever)

```
bidSize = baseSize × max(0, 1 − inv)         # long → smaller bid
askSize = baseSize × min(2, 1 + inv)         # long → bigger ask
```

Price skew + size skew flatten faster together, and shrinking the dangerous side cuts the worst-case fill. The original one-sided rule at `|q| ≥ qMax` becomes the natural limit of this curve instead of a discontinuity.

### 3.4 Spread = base + volatility + resolution clock

```
halfSpread = baseHalfSpread
           + volTerm(realized mid-vol over volWindowMs, book thinness)
           + jumpTerm × g(hoursToResolution)     # 0 beyond 48h, ramps up inside
floor: halfSpread ≥ minSpreadTicks (per-category, see §3.5)
```

Binaries have two clocks: volatility now, and jump-to-resolution later. The 12h hard cutoff stays; this makes the approach to it a slope, not a cliff.

### 3.5 Rebate-aware spread floor (per category)

Break-even spread differs by category. Every fee-bearing category now pays a maker rebate (all non-crypto 25%, Crypto 20%), so your per-fill income is spread/2 + rebate. The profitable floor is *tighter* in rebate categories than in fee-free geopolitics (where there is no rebate at all, only spread). Compute `minSpreadTicks` per category from the live fee formula + rebate share and quote down to it only where the rebate supports it. This lets you sit inside lazier competitors who use one floor everywhere — a structural advantage the venue is paying you to take. (Fee Structure V2 rates, verified 2026-06-13; see `src/utils/fee-utils.ts` for the map. **Note:** Finance rebate was 50% at initial V2 launch but current Polymarket docs show 25% as of 2026-06-13 -- confirm via API before relying on any Finance-specific advantage.)

### 3.6 Queue-position awareness

Track estimated queue position: `sizeAheadAtPost − tradedVolumeSince`. Rules:

- **Deep in queue at an eroding level → cancel.** The only fill left there is the toxic sweep.
- **Prefer fronting a new tick** (one tick inside, front of empty queue) over joining the back of a crowd, when spread permits. Worse price, much better fill quality.
- Tag every fill with queue-position-at-post so the drift instrumentation can verify this empirically (it will — this is the standard result).

### 3.7 Requote triggers (event-driven, unchanged) + news circuit breaker

Requote on: best bid/ask moves ≥ `requoteThresholdTicks`, OR your order leaves top-of-book region, OR inventory crosses a skew band. Never on a timer.

**NEW — circuit breaker:** if mid moves ≥ `breakerTicks` within `breakerWindowMs` (set both from your recorded feed's tail distribution, e.g. 99.5th percentile), `cancelAll()` for that market and sit out `cooldownMs`. During real news the correct spread is infinite. This single rule is expected to be worth more than every quoting refinement above.

---

## 4. Risk caps (hard, enforced in code)

Unchanged from the original spec, restated because they're non-negotiable:

- Per-market `maxInventoryShares` (qMax) → one-sided quoting at the cap.
- Portfolio `maxGrossExposureUsd` → no new markets when hit.
- Per-event-cluster exposure cap (markets resolving on the same catalyst count as one).
- Kill switch: single-market unrealized loss > X% → cancel all, flatten, blacklist for session.
- Stale-data guard: if the orderbook feed is silent > `staleFeedMs`, pull quotes. Quoting on a dead feed is how books die during outages.

---

## 5. Config (full v2 shape)

```typescript
marketMaking: {
  enabled: boolean;
  categories: string[];              // ['geopolitics','finance','politics']
  minVolume24h: number;
  minDepthShares: number;
  priceBand: [number, number];       // [0.10, 0.90] (widened for dry-run); auto-tighten near expiry
  minHoursToResolution: number;      // 12
  // quoting
  baseHalfSpreadTicks: number;
  minSpreadTicksByCategory: Record<string, number>;  // rebate-aware floors
  skewWidth: number;
  baseSize: number;
  // spread terms
  volWindowMs: number;
  jumpTermTicks: number;             // max resolution-clock widening
  // requote + breaker
  requoteThresholdTicks: number;
  breakerTicks: number;
  breakerWindowMs: number;
  cooldownMs: number;
  staleFeedMs: number;
  // risk
  maxInventoryShares: number;
  maxGrossExposureUsd: number;
  maxClusterExposureUsd: number;
  killSwitchLossPct: number;
}
```

**Parameter discipline:** that's a lot of knobs. Tune at most 2 at a time on the train set (`02_VALIDATION_AND_TESTING.md §3`). Everything else gets a sane default and stays frozen until the validate set earns the right to touch it. Prefer flat profit plateaus over peaks.

---

## 6. Build plan (order matters)

**Phase A — Plumbing (week 1)**
1. Market selection filter + `getMarkets` ranking by volume.
2. Static-spread quoting, cancel/replace, tick rounding via `roundPrice()`. Get fills working in dry-run.
3. Fill-to-mark logging from day one: `{market, side, fillPrice, fillTime, inventoryAfter, queuePosAtPost, hourBucket}`, mid sampled at +5s/+15s/+30s. **Not after — with.**

**Phase B — The real quoter (weeks 1–3)**
4. Event-driven requote off `RealtimeServiceV2` orderbook stream.
5. Microprice centering (§3.1).
6. Nonlinear skew + asymmetric size + one-sided caps (§3.2–3.3).
7. News circuit breaker + stale-feed guard (§3.7, §4). **Must exist before any real capital.**

**Phase C — Selection intelligence (weeks 3–5, needs accumulated data)**
8. Per-market, per-hour drift aggregation → quoting schedules.
9. Continuous capital allocator (`edgeScore`).
10. Rebate modeling per category + rebate-aware spread floors; reconcile modeled vs. actual USDC rebates when readable.
11. Queue-position tracking + front-vs-join logic.

**Phase D — Last (only if data demands)**
12. Volatility-scaled spread refinement; resolution-clock `jumpTerm` calibration.
13. Smart Money feature: credible-wallet accumulation → widen inventory tolerance on that market. Nudges allocation, never fires an order.

Backtest Phases A–B logic on recorded data via the ReplayEngine (anti-look-ahead invariants per `02_VALIDATION_AND_TESTING.md §3`: maker fills only on through-trades, `ts ≤ t` everywhere) **before and during** the dry-run.

---

## 7. Test plan & grading — how you know it works

### 7.1 Stage gates

| Stage | Duration | Capital | Pass criteria |
|---|---|---|---|
| Backtest (replay) | recorded history | $0 | Net edge positive on **validate set**, ≥ 5 markets, params on a plateau |
| Dry-run live feed | 2 weeks min | $0 | All §7.2 metrics green |
| Pilot | 4 weeks | $2–5k total | §7.2 green at real fills; goal = *measure*, not earn |
| Scale step 1 | ongoing | up to $15–30k | 30-day net PnL > 0 AND drift ≥ 0 holding |

No stage skipping. Each gate is binary — partial green is red.

### 7.2 Grading metrics (the report card)

**Primary — these decide everything:**

| Metric | Definition | Green | Yellow | Red |
|---|---|---|---|---|
| Fill-to-mark drift | mean driftBps at +15s, per market, ≥ 100 fills | ≥ 0 | −5 to 0 | < −5 |
| Net edge per fill | spread/2 + rebate + drift − flatten cost (bps) | > +3 | 0 to +3 | < 0 |
| Markets passing | count of markets with green drift | ≥ 5 | 3–4 | < 3 |

**Secondary — health checks:**

| Metric | Green |
|---|---|
| Worst single-day loss | < 3× median daily gross PnL |
| Max inventory excursion | never exceeds qMax (a breach = code bug = halt) |
| Resolution PnL on residual inventory | ≥ 0 cumulative (negative = band/timing filters failing) |
| Realized vs. modeled rebates | within 20% (worse = re-check fee model or market mix) |
| Circuit breaker saves | breaker-triggered windows show mid moves that would have been losing fills (verify it's earning its keep) |
| Fill rate | enough fills to measure (≥ 100/market over the window) — a book that never fills proves nothing |

**The single number:** if forced to grade with one metric, it's **per-market fill-to-mark drift at +15s**. Positive = the venue's flow is feeding you. Negative = you are the product. Everything else is decoration.

### 7.3 Statistical honesty rules

- Minimum 100 fills per market before trusting any per-market number; below that, the market is *unproven*, which means *untradeable*, not "probably fine."
- Drift is noisy: report mean ± standard error, not just mean. A drift of +2 ± 6 bps is not green.
- Segment all metrics by fee-regime period and by week. An edge that only existed in week 1 is noise.
- Never report train-set numbers as expectations. Validate-set or it didn't happen.

---

## 8. The record system (institutional memory)

### 8.1 Four logs (append-only JSONL)

| Log | File | Row frequency | Key fields |
|-----|------|---------------|------------|
| Fills | `logs/fills.jsonl` | Every maker fill | `{ts, market, conditionId, side, fillPrice, fillSizeShares, inventoryAfter, queuePosAtPost, hourBucket, mid5s, mid15s, mid30s, driftBps15s, configHash}` |
| Snapshots | `logs/snapshots.jsonl` | Daily (end of UTC day) | `{date, configHash, regime, stage, marketsQuoted, totalFills, meanDrift15sBps, netPnlUsd, grossExposureUsd, worstMarketDrift, rebateAccruedUsd}` |
| Journal | `logs/journal.jsonl` | Every human decision | `{ts, type, decision, expectedEffect, reviewDate, previousConfigHash, newConfigHash}`. `type` includes `NO-CHANGE` as a first-class entry. |
| Incidents | `logs/incidents.jsonl` | Every breaker/kill/outage | `{ts, market, trigger, midBefore, midAfter60s, quotesActive, action}` |

**Field notes:**
- `queuePosAtPost`: `null` during Phases A and B; populated when Phase C queue-position tracking comes online. The `null` is self-documenting ("recorded before queue tracking existed") and requires no retroactive correction.
- `hourBucket`: UTC hour (0–23) at fill time. Must be present from day one for Phase C per-hour drift segmentation.
- `configHash`: SHA-256 of the `MarketMakingConfig` object (keys sorted deterministically), truncated to 12 hex characters. Full config stored in `logs/configs/{hash}.json`.
- `regime`: versioned string, manually set (e.g., `"2026-dynamic-v1"`). Format: `YYYY-{description}-v{N}`. Increment on any fee/rebate change. Never pool data across regimes.
- `stage`: one of `"backtest" | "dry-run" | "pilot" | "scale-1"`, matching the §7.1 gate table.

### 8.2 Integrity rules

- **No UPDATE path.** History is corrected by appending a new entry with a `corrects` field pointing to the original `ts`, never by editing.
- Full config saved to `logs/configs/{configHash}.json` on every hash change.
- `mid5s`, `mid15s`, `mid30s` in fills are backfilled by a scheduled sampler (not inline with the fill handler, to avoid blocking the order path). Unfilled samples (market went offline) are logged as `null`.

### 8.3 Review cadence

- **Daily:** 3-line summary in journal (fills, drift direction, any incidents).
- **Weekly:** drift report per market, edgeScore re-ranking.
- **Monthly:** written verdict: `SCALE | HOLD | RESTRICT | KILL` with a falsifiable prediction for next month, graded against last month's prediction.

---

## 9. Kill criteria (live, pre-committed)

- 30-day live net PnL (all costs, including your flattening taker fees) < 0 → size to zero, back to research.
- Drift persistently negative on a market → schedule-restrict first, blacklist second.
- Realized rebates materially below model → the subsidy may be changing; halt scaling, re-read the fee page.
- **Regime kill:** Polymarket changes maker rebates or adds fees to current fee-free categories → halt everything, re-derive per-category floors, re-validate from the dry-run stage. The entire edge is a policy choice the venue can revoke.

**Regime notes (2026-06-13):**
- Exchange V2 (2026-04-28): collateral migrated from USDC.e to pUSD (1:1 USDC-backed ERC-20). Maker rebates now paid in pUSD. Code still references USDC.e in swap-service / dip-arb-service / onchain-service -- needs migration review.
- Taker Rebate Program (2026-05-28): tiered taker rebates (Bronze $2k wV through Obsidian $10M wV, up to 50% taker fee rebate). Does not directly affect our maker-side strategy but changes counterparty economics -- high-tier takers pay less effective fee, which may reduce the maker rebate pool. Monitor via realized-vs-modeled rebate check.
- Finance maker rebate: Polymarket docs as of 2026-06-13 show 25%, not 50%. If confirmed, Finance loses its rebate advantage over other categories. Verify via the rebate API endpoint before any category-priority decisions.

---

## 10. What comes after — the decision tree

**If pilot is green (drift ≥ 0 on ≥ 5 markets, net edge positive):**
1. Scale capital in steps (×2–3 per step, monthly), watching for *self-impact*: if your own quotes become the book, spread capture falls. Expect a capacity ceiling around $10–30k deployed — these books are thin. Hitting the ceiling is success, not failure.
2. Add finance/politics/sports/economics markets (all 25% rebate) with tighter floors.
3. Add the convergence satellite (favorites 0.92–0.97, maker entry, per-cluster caps) — it reuses the same instrumentation and diversifies the PnL stream.
4. Turn on the Smart Money selection feature and measure whether it actually predicts lower toxicity (test in `02 §4`); drop it if it doesn't.
5. Only then revisit maker-only binary arb as a low-expectation add-on.

**If pilot is yellow (drift ≈ 0, net edge ≈ 0):**
- The rebate alone may carry a thin book in finance markets. Restrict to highest-rebate markets + best hour buckets only, run 4 more weeks. If still yellow → treat as red.

**If pilot is red (drift negative across markets):**
- The flow on these markets is bots, not retail. Do **not** iterate on quoting math — that's not the problem. The conclusion is that Polymarket MM is not viable for you in this regime. Stop, keep the recording infra running cheaply, and re-test if/when the venue's flow composition changes (new fee regime, growth event, new categories). The discipline to accept red is the whole point of pre-committing these criteria.

**Either way:** the recording + replay + drift instrumentation outlives any single strategy. It's the durable asset.

---

## 11. One-page summary

- **Edge:** venue-paid (rebates/fee-free) + spread from benign flow. Selection > survival > fill quality > quote math.
- **Quote:** microprice center, convex inventory skew, asymmetric size, rebate-aware per-category floors, event-driven requote, news circuit breaker.
- **Risk:** hard inventory/gross/cluster caps, kill switch, stale-feed guard, resolution-clock widening.
- **Grade:** fill-to-mark drift at +15s per market is the god metric. ≥ 100 fills, mean ± SE, validate-set only.
- **Gates:** backtest → 2wk dry-run → $2–5k pilot → stepped scaling. Binary gates, no skipping.
- **Kill:** pre-committed, including the regime-change kill. If drift is red, the answer is "stop," not "tune."
- **Ceiling:** small, capacity-constrained, low-double-digit annualized if it works. A grind, not a printer. Build the boring version and protect it ruthlessly.
