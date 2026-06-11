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
