# Validation & Testing Plan

The point of this file: **no capital goes live until the system can tell you the truth.** Right now it can't — the simulator omits fees and there is no backtester. Fix the instruments first.

---

## 1. Fix the cost model FIRST (blocks everything)

`simulateRealisticTrade()` currently does slippage 0.5× and competition 0.7× but **no explicit fee**. Add the real formula per category:

```typescript
// fee = C × feeRate × p × (1 − p), taker only, maker = 0
function takerFee(notionalShares: number, price: number, feeRate: number): number {
  return notionalShares * feeRate * price * (1 - price);
}
```

- Map category → feeRate (Crypto 0.07, Economics 0.05, Culture/Weather/Other 0.05, Finance/Politics/Tech/Mentions 0.04, Sports 0.03, Geopolitics 0.00). All fee-bearing categories pay maker rebates (Finance 50%, Crypto 20%, others 25%). Confirm against the official fee page — rates last verified 2026-06-10 (Fee Structure V2, effective 2026-03-30).
- Charge it on **every taker leg**. Arb pays it **twice** (both legs taker). Maker orders pay **zero** and *accrue a rebate* (model separately).
- Add a dashboard line: `rawPnl`, `adjPnl (incl. fees)`, `realism = adj/raw`. If realism is wildly < 1 for a strategy, that strategy is fee-dead.

**Acceptance:** re-run dry-run for arb/DipArb. If adjusted PnL goes negative (it should for crypto taker arb), the model is now honest. That's the goal.

---

## 2. Record the RIGHT data

Your docs admit arb/DipArb run their own WS connections that the SDK recorder misses. Backtesting arb on data that doesn't contain arb orderbooks is impossible.

- [ ] Route arb/MM market orderbook subscriptions through the recorded `RealtimeServiceV2` path, or add recording to those connections.
- [ ] Verify each recording day contains `clob_market` agg_orderbook for the **specific markets** you intend to MM/arb, not just crypto prices + activity.
- [ ] Sanity check: `wc -l`, and confirm orderbook events per target market per minute is non-trivial.

---

## 3. Backtester requirements (ReplayEngine)

Build to `src/backtest/replay.ts` per your plan, but with these **non-negotiable invariants**:

### Anti-look-ahead (the classic way backtests lie)
- A fill decision at time `t` may only use orderbook/price state with `ts <= t`. Never the snapshot that *includes* your own hypothetical order's effect.
- Resolution outcome must NOT be readable by entry logic. Outcome is revealed only at/after `endDate`.
- Model fill realistically: a maker order fills only when the book *trades through* your price, not when mid merely touches it. A taker order fills at the *walked* book (consume depth level by level), not at best price for full size.

### Walk-forward / out-of-sample (the classic way params overfit)
- Split recordings: **train** (tune params) / **validate** (lock params, measure). Never report train-set PnL as expected performance.
- Rolling walk-forward: tune on weeks 1–2, test on week 3; roll. Edge that only exists in-sample is noise.
- **Cap parameter count.** A 2–4 week sample cannot support a 4-D grid (dipThreshold × sumTarget × window × ...). With enough knobs you *will* find a "profitable" fit that is pure curve-fitting. Tune ≤ 2 params at a time, coarse grid, prefer robustness (flat profit plateau) over peak PnL.

### Output (per `BacktestResult`)
`totalPnl, tradeCount, winRate, maxDrawdown, sharpe, fill-to-mark drift, fees paid, rebates earned, params`. Always net of fees.

---

## 4. Per-strategy test protocol

### Market Making (priority)
- Replay target markets; simulate resting orders with through-trade fills.
- Metrics: realized spread, modeled rebate, fill-to-mark drift per market, max inventory reached, resolution PnL on residual inventory.
- **Pass:** net edge (spread + rebate + inventory MtM − flatten fees) positive on **validate set**, across **multiple markets**, with drift ≥ 0.
- Then dry-run live-data 1–2 weeks before tiny real size.

### Convergence (satellite)
- Replay favorites at 0.92–0.97 within `maxDaysToExpiry`; maker entry (fee-free), settle at outcome.
- **Critical test — negative skew:** group trades by event cluster (same election night, same macro print). Measure worst-cluster drawdown, not just average. The risk is correlated losses.
- **Pass:** positive net EV on validate set AND survivable worst-cluster loss under per-cluster exposure cap.

### Binary Arb (maker-only, low expectation)
- Replay; require **maker** fills (post and wait), charge zero fee but realistic *non-fill* rate (most resting arb orders never fill).
- **Pass bar is low:** if even maker-only arb can't clear positive net after realistic non-fill rates, treat as learning exercise only. Do NOT resurrect taker arb.

### Smart Money (as research signal)
- No PnL of its own. Test only: does "credible wallet accumulating" *predict* lower fill-to-mark toxicity / better MM PnL in that market? If yes, it's a useful feature. If not, drop it.

### DipArb / Direct Trading
- Not tested. Deleted. (If you insist on a sanity check: run DipArb through the fee-corrected simulator once, watch it go negative on crypto taker fees, and move on.)

---

## 5. Data sufficiency

| Strategy | Min recording | Why |
|----------|---------------|-----|
| Market Making | 1–2 weeks per target market | spread capture is continuous; need many fills + drift samples |
| Convergence | several resolution cycles across **uncorrelated** events | skew risk only shows across clusters |
| Binary Arb (maker) | 2 weeks of target-market orderbooks | non-fill rate is the key unknown |

If a market has too few events to measure drift with confidence, you cannot conclude it's safe — treat unproven as untradeable.

---

## 6. Go-live gates (copy of Master Plan §7 — all must be true)

1. Simulator includes real per-category taker fees + maker rebate model.
2. Backtest is walk-forward / out-of-sample, params robust (flat plateau, not a spike).
3. Parameter count small vs sample size.
4. Dry-run fill-to-mark drift non-negative on target markets.
5. Hard caps coded & tested: per-market inventory, portfolio gross, per-event-cluster.

## 7. Kill criteria (live)

- 30-day net PnL (all costs) negative → size to zero, back to research.
- Persistent adverse fill-to-mark drift → blacklist/exit market.
- Realized rebates materially below model → edge may be gone; re-validate.

---

## 8. Statistical traps checklist (re-read before trusting any "it works")

- [ ] Did I select wallets/markets on realized PnL? (survivorship) → use out-of-sample forward test.
- [ ] Does the backtest sample only contain markets that resolved/stayed liquid? (selection bias) → note the survivorship in the data itself.
- [ ] Could outcome or future book state leak into an entry decision? (look-ahead) → assert `ts <= t` everywhere.
- [ ] Are there more parameters than the data can support? (overfitting) → cut knobs, prefer plateaus.
- [ ] Did the fee regime change during my sample? (regime change) → it did in Jan–Mar 2026; segment data by regime, don't pool blindly.
