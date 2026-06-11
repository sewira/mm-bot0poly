# Market Making Spec — the one book worth building

> **SUPERSEDED (2026-06-10):** The quoting logic, spread math, and config shape in this file are superseded by `docs/03_MM_STRATEGY_V2.md`. Market selection filters, risk caps, and the fill-to-mark instrumentation concept originated here and remain valid but are now specified authoritatively in 03. Read 03 for current strategy; keep this file as historical context only.

This replaces the naive `mid ± halfSpread` / 5–10s timer design. Drop-in target: `setupMarketMaking()` in `bot-with-dashboard.ts`, config in `bot-config.ts`, orderbook from `RealtimeServiceV2`, orders via `TradingService.createLimitOrder()` / `cancelAll()`, tick snapping via `roundPrice()` (`src/utils/price-utils.ts`).

The edge is **maker rebate + spread on low-toxicity markets**, NOT speed. You win by *selection and inventory discipline*, not by being fast.

---

## 1. Market selection filter (this is most of the edge)

Only quote markets passing ALL:

- **Category:** geopolitics (fee-free) > finance (50% maker rebate) > liquid politics/sports. **Never crypto, never breaking-news.**
- **Liquidity:** 24h volume above a floor; book depth on both sides above `minDepthShares`. Use `GammaApiClient.getMarkets({ order: 'volume24hr' })`.
- **Price band:** mid in **[0.20, 0.80]**. Outside this, binary jump-to-resolution risk dominates — skip.
- **Time to resolution:** not within `minHoursToResolution` (default 12h). Avoid quoting into a resolution you can't react to.
- **Toxicity (after warmup):** rolling fill-to-mark drift ≥ 0. Blacklist markets that consistently mark against you.

Rank survivors by realized fill-to-mark; route more capital to the best, blacklist the worst.

---

## 2. Quoting logic — inventory-skewed reservation price

Do **not** quote symmetrically around mid. Skew around a *reservation price* that pulls toward flattening inventory (Avellaneda–Stoikov, simplified):

```
mid          = (bestBid + bestAsk) / 2
q            = net inventory in this market (signed, in shares)
qMax         = maxInventory (hard cap)
inv          = q / qMax                      # normalized inventory, -1..+1

# reservation price: shift away from inventory you want to shed
reservation  = mid - inv * skewWidth         # long inventory -> lower reservation -> cheaper asks
halfSpread   = baseHalfSpread + volTerm      # widen in volatility / thin books

bidPrice     = roundPrice(reservation - halfSpread)
askPrice     = roundPrice(reservation + halfSpread)
```

- `skewWidth` controls how hard you lean to flatten. Larger = flatten faster, capture less.
- `volTerm` widens the spread when the book is thin or recent mid-volatility is high. A fixed spread gets run over in fast markets.
- Round to valid tick with `roundPrice()`; reject if `bidPrice >= askPrice` after rounding.

**One-sided quoting at caps:**
- `q >= +qMax` → stop posting bids, only post ask (shed long).
- `q <= -qMax` → stop posting asks, only post bid (cover short).

**Spread floor for rebate economics:** in fee-free/rebate markets you can quote tighter (you're subsidized), but never tighter than `minSpreadTicks` — otherwise you're paying yourself to accumulate toxic inventory.

---

## 3. Requoting — event-driven, NOT a timer

A 5–10s timer gets you picked off between ticks. Requote when:
- Best bid/ask changes by ≥ `requoteThresholdTicks`, OR
- Your resting order is no longer at/near top of book, OR
- Inventory crosses a skew band boundary.

Flow on each trigger:
```
1. cancelAll() for this market (or cancel-replace if SDK supports it — cheaper)
2. recompute mid from live RealtimeServiceV2 orderbook
3. recompute reservation + spread with current inventory
4. post fresh bid/ask (respect one-sided rules at caps)
```
Subscribe via `RealtimeServiceV2.subscribeMarkets()`; drive requote off the orderbook event handler, not `setInterval`.

---

## 4. Inventory & risk caps (hard, enforced — not config-only like Direct Trading was)

```typescript
marketMaking: {
  enabled: boolean;
  categories: string[];          // ['geopolitics','finance','politics']
  minVolume24h: number;
  minDepthShares: number;
  priceBand: [number, number];   // [0.20, 0.80]
  minHoursToResolution: number;  // 12
  baseHalfSpreadTicks: number;
  minSpreadTicks: number;
  skewWidth: number;             // reservation skew per unit inventory
  maxInventoryShares: number;    // per-market hard cap (qMax)
  maxGrossExposureUsd: number;   // portfolio-level cap across all MM markets
  requoteThresholdTicks: number;
  volWindowMs: number;           // window for volTerm
}
```

- Per-market `maxInventoryShares` → triggers one-sided quoting.
- Portfolio `maxGrossExposureUsd` → stop opening new MM markets when hit.
- **Kill switch:** if any single market's unrealized loss exceeds `X%`, cancel all, flatten via market order, blacklist for the session.

---

## 5. Fill-to-mark instrumentation (build this with the strategy, not after)

On every fill, log: `{market, side, fillPrice, fillTime, inventoryAfter}`. Then sample mid at +5s, +15s, +30s:

```
driftBps(t) = (mid(fillTime + t) - fillPrice) / fillPrice * 10000 * sign(side)
```

- Positive = market moved your way after filling you (good — non-toxic flow).
- Negative = you were adversely selected (bad).

Aggregate per market (rolling mean + count). This is the routing signal **and** the kill signal. Surface it on the dashboard next to PnL.

---

## 6. PnL accounting (do it right or you'll fool yourself)

Per market, track:
- **Realized spread PnL** from round-trip fills.
- **Rebate income** — model from the fee formula (counterparty's taker fee × rebate share for your category) until you can read actual daily USDC rebates, then reconcile.
- **Inventory mark-to-market** — unrealized, at current mid.
- **Resolution PnL** — what residual inventory settles to at 0/1.

Net edge per market = spread + rebate + inventory MtM − any taker fees you paid flattening. If that's not positive after a meaningful sample, the market is not for you.

---

## 7. Smart Money as a feature here (not a trader)

Poll top-wallet positions (`WalletService.getWalletPositions`); where credible wallets are accumulating, *widen the inventory tolerance and quote band* on that market — lean into informed conviction instead of racing it. It nudges allocation; it never fires an order. This neutralizes the latency problem entirely.

---

## 8. Build order

1. Market selection + `getMarkets` filter.
2. Static-spread quoting + cancel/replace + tick rounding (get plumbing right).
3. Event-driven requote off orderbook stream.
4. Inventory skew + one-sided caps.
5. Fill-to-mark logging + dashboard surfacing.
6. Rebate modeling + full PnL accounting.
7. Volatility-scaled spread last.

Run 1–5 in dry-run for 1–2 weeks before $1 goes live. Gate on `00_MASTER_PLAN.md §7`.
