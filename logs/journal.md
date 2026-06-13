# Decision Journal

## 2026-06-10 | SYNC | Fee model V2 propagation across all artifacts

**Triggering change:** mm-strategist review found fee/rebate model stale across all docs.
Polymarket Fee Structure V2 (effective 2026-03-30) adds maker rebates to ALL fee-bearing
categories (not just Finance). Old docs showed only Finance with a rebate and used
percentage-based rate notation instead of feeRate constants.

**Verified source:** Polymarket official fee page + help center (WebSearch 2026-06-10).
Fee Structure V2 confirmed: Crypto 0.07/20%, Economics+Culture+Weather+Other 0.05/25%,
Finance+Politics+Tech+Mentions 0.04/25% (Finance 50%), Sports 0.03/25%, Geopolitics
0.00/N/A. Grandfathering: fees only on markets deployed on or after activation date.

**Artifacts touched:**
- `docs/00_MASTER_PLAN.md` -- fee table rewritten with feeRate + rebate share columns,
  grandfathering rule added, consequence text updated, Phase 3 roadmap updated.
- `docs/03_MM_STRATEGY_V2.md` -- section 2 category hierarchy updated with all rebate tiers,
  grandfathering filter added to market selection table, section 3.5 updated to note
  rebates on all fee-bearing categories, section 9 scaling path updated.
- `docs/02_VALIDATION_AND_TESTING.md` -- section 1 feeRate mapping updated with correct
  rates and rebate info, verification date added.
- `docs/01_MARKET_MAKING_SPEC.md` -- supersession tombstone added at top pointing to 03.
- `.claude/skills/polymarket-strategy/SKILL.md` -- BLOCKED (file permission denied).
  Required edits: update fee table in section 1, add grandfathering rule, fix section 4
  cross-reference (pointed to "03 section 8" but 03 has no section 8 for the record system),
  update section 3 selection hierarchy.

**Code check (flagged, not edited):**
- `src/utils/fee-utils.ts` -- TAKER_FEE_RATES and MAKER_REBATE_SHARES maps already match
  V2 rates. Minor discrepancy: code uses crypto=0.072 (yields $1.80 peak) while V2 docs
  show feeRate=0.07 (yields $1.75 peak). Web search returns both "$1.80" and "0.07" which
  are contradictory. Needs verification against the actual API/contract. Route to mm-builder.

**Remaining inconsistencies:**
1. SKILL.md not updated (permission blocked) -- must be edited manually or permission granted.
2. Crypto feeRate: 0.07 (docs, user, web search text) vs 0.072 (code, web search peak fee).
   Cannot resolve without checking Polymarket's actual fee contract or API response.
3. 03_MM_STRATEGY_V2.md has no section for the four-log record system. SKILL.md section 4
   and agent prompts (mm-builder, mm-reviewer) reference "03 section 8" for log schemas,
   but 03 section 8 is actually "Kill criteria." This predates this sync -- noted, not fixed.
4. Agent prompts: checked, no leaked fee constants found. All reference docs correctly.

---

## 2026-06-13 | VERDICT | Daily review -- Day 1 VPS dry-run (17h elapsed)

**Type:** DAILY REVIEW (first daily since dry-run start)
**Config hash:** a60c397cac2f
**Stage:** dry-run

**Observed (user-reported, not from logs -- see below):**
- 7 fills total, 57% win rate (4W/3L), net PnL +$0.10 (spread +$0.04, rebate ~$0.06)
- 0.4 fills/hr across 10 active markets, only 2 generating fills (NBA Finals)
- Drift: Knicks -24.7 bps, Spurs -79.4 bps (negative on all fills)

**Red flags:**
1. FILL LOGGING NOT RECORDING PRODUCTION DATA. `logs/fills.jsonl` contains only "Test Market"
   unit-test entries. The 7 real VPS fills are not in the institutional record. Without recorded
   fills with drift backfills, the dry-run clock has not started per 03 section 7.
2. Fill rate far too low for the 2-week gate window. At 0.4/hr, 2 weeks yields ~130 total fills
   across all markets -- well below the 100-per-market minimum on 5+ markets.
3. Drift negative on both active markets. N too small to be statistically meaningful, but the
   sign is not favorable. Spurs at -79.4 bps would be a blacklist if it held past 30 fills.
4. `logs/snapshots.jsonl` does not exist. `journal.jsonl` does not exist (journal is .md only).
5. Four operational incidents (429 rate limit, DipArb gate bug, filter restrictions, stale feed)
   are unlogged in the journal or incidents file.

**Decision:** NO-CHANGE (no config changes warranted yet). The problem is infrastructure, not
parameters. Fix fill recording first, then accumulate data, then evaluate.

**Expected effect:** Once fill logging is fixed, expect the same ~0.4 fills/hr rate to persist
unless market count or spread is adjusted. The drift numbers will likely remain noisy and
negative for the first 50-100 fills on sports/NBA markets -- these are high-flow, potentially
toxic categories. If drift is still negative at 100 fills on these NBA markets, they should be
restricted per 03 section 9 before considering sports category more broadly.

**Review date:** 2026-06-16 (next daily, or sooner if fill logging is fixed)

---

## 2026-06-13 | INCIDENT-REVIEW | Four VPS deployment bugs (retroactive)

**Type:** INCIDENT-REVIEW (retroactive -- these occurred between 2026-06-12 and 2026-06-13
during VPS deployment, logged here because no incident entries were written at the time)

1. **ws-live-data 429 rate limiting:** RTDS WebSocket connection triggered Polymarket rate
   limits. Fix: skip RTDS connection, rely on REST polling. Impact: reduced real-time feed
   quality, increased staleFeedMs sensitivity. No fills lost (fills come from CLOB, not RTDS).

2. **DipArb auto-rotate running when disabled:** `setupDipArb()` was called regardless of the
   `DIPARB_ENABLED` config flag. Fix: gated the call. Impact: unnecessary API calls and
   potential interference with market selection. DipArb is a KILLED strategy (SKILL.md section 2).

3. **Market filters too restrictive:** priceBand and minVolume thresholds excluded most eligible
   markets. Fix: widened priceBand, lowered minVolume, added volume-sorted scan. Impact: went
   from ~2 to ~10 markets passing filters. Config hash change not recorded (should have been).

4. **Stale feed pulling quotes on 5/10 markets:** staleFeedMs was 10s (per config
   a60c397cac2f), too aggressive for REST-polled markets. Fix: increased to 30s. Impact:
   half of markets were being treated as stale and having quotes pulled constantly.

**Note:** Items 3 and 4 changed config parameters but no new configHash was saved. This is a
process violation per 03 section 8.2 -- every config change requires a new hash and a saved
config file. The current running config on the VPS may not match a60c397cac2f.

**Review date:** N/A (retroactive, no prediction to grade)

---

## 2026-06-13 | SYNC | Post-dry-run config changes + external regime updates

**Triggering changes:** (1) User-reported config changes from VPS deployment: priceBand
widened to [0.10, 0.90], minVolume24h to 0, baseHalfSpreadTicks to 1, maxMarkets to 15,
maxGrossExposureUsd to 50, staleFeedMs to 30000, paper capital $100. (2) SDK init changed
to `new PolymarketSDK()` + `initialize()`, ws-live-data gated. (3) DipArb setup gated
behind config flag. (4) Market scan sorted by volume24hr descending. (5) VPS deployment
docs created.

**Verified source (WebSearch 2026-06-13):** Three external changes discovered:
- Finance maker rebate now 25% (was 50% at V2 launch). All non-crypto categories 25%.
  Code (`fee-utils.ts`) still has `finance: 0.50`. BLOCKER for category prioritization.
- Exchange V2 (2026-04-28): USDC.e replaced by pUSD. Code still references USDC.e.
- Taker Rebate Program (2026-05-28): tiered taker rebates up to 50%. Not in any docs.

**Artifacts touched:**
- `docs/03_MM_STRATEGY_V2.md` -- Status line updated to "DRY-RUN"; Finance 50% references
  corrected to 25%; priceBand reference updated; regime notes added for pUSD migration
  and taker rebate program; scaling path corrected.
- `docs/00_MASTER_PLAN.md` -- Finance 50% corrected to 25%; verification date to 2026-06-13;
  priceBand reference updated; scaling path corrected; pUSD/taker rebate noted.
- `docs/02_VALIDATION_AND_TESTING.md` -- Finance 50% corrected to 25%; verification date
  to 2026-06-13.
- `.claude/skills/polymarket-strategy/SKILL.md` -- Stage updated to dry-run; Finance 50%
  corrected; pUSD + taker rebate program noted; selection hierarchy updated; SDK init
  pattern noted; rebate description corrected.
- `CLAUDE.md` -- SDK initialization pattern updated to reflect current bot usage.

**Code drift flagged (NOT edited -- route to mm-builder):**
1. `src/utils/fee-utils.ts` line 71: `finance: 0.50` -- must be changed to `0.25` per
   current Polymarket documentation. This is a BLOCKER for any Finance-category spread
   floor calculation.
2. `src/services/swap-service.ts`, `src/services/dip-arb-service.ts`,
   `src/services/onchain-service.ts` -- extensive USDC.e references that need pUSD
   migration review (Exchange V2, 2026-04-28).
3. `bot-with-dashboard.ts` line 879-880: paper balance uses hardcoded `100` rather than
   reading from CONFIG.capital.totalUsd. Minor inconsistency.

**Agent prompts:** Checked all 6 agent files. No leaked constants found.

**Remaining inconsistencies:**
1. Finance rebate 0.50 in code vs 0.25 in docs -- code must be updated by mm-builder.
2. USDC.e vs pUSD throughout codebase -- needs migration assessment.
3. Crypto feeRate 0.07 vs 0.072 -- still unresolved from 2026-06-10 sync.
4. 03 section numbering: "section 8" references in agents point to the record system
   (which is 03 section 8), while "section 9" is kill criteria (actually 03 section 9).
   This was noted as wrong in the 2026-06-10 entry but is actually correct -- 03 does
   have sections 8-11. The previous sync entry was incorrect about this.
5. No journal entries are in JSONL format as specified by 03 section 8.1 -- journal is
   markdown only. This is a known deviation.
