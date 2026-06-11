/**
 * Polymarket Taker Fee Utilities
 *
 * Fee formula: fee = shares × feeRate × price × (1 − price)
 * - Peaks at price = 0.50
 * - Makers pay 0; takers pay the fee
 * - feeRate is a category-specific constant
 *
 * Maker rebates are paid daily from the taker fee pool, not per-fill.
 *
 * Source: https://help.polymarket.com/en/articles/13364478-trading-fees
 */

// ============================================================================
// Types
// ============================================================================

export type FeeCategory =
  | 'crypto'
  | 'economics'
  | 'culture'
  | 'weather'
  | 'mentions'
  | 'finance'
  | 'politics'
  | 'tech'
  | 'sports'
  | 'geopolitics'
  | 'other';

// ============================================================================
// Constants
// ============================================================================

/**
 * Taker feeRate constants per Polymarket category.
 *
 * Derivation: maxFeePer100Shares = 100 × feeRate × 0.5 × 0.5 = 25 × feeRate
 * So feeRate = maxFeePer100Shares / 25.
 *
 * Crypto: $1.80 max → 1.80/25 = 0.072
 * Economics/Culture/Weather: $1.25 max → 1.25/25 = 0.050
 * Finance/Politics/Tech/Mentions: $1.00 max → 1.00/25 = 0.040
 * Sports: $0.75 max → 0.75/25 = 0.030
 * Geopolitics: fee-free
 */
export const TAKER_FEE_RATES: Record<FeeCategory, number> = {
  crypto:      0.072,
  economics:   0.050,
  culture:     0.050,
  weather:     0.050,
  mentions:    0.040,
  finance:     0.040,
  politics:    0.040,
  tech:        0.040,
  sports:      0.030,
  geopolitics: 0.000,
  other:       0.050,
};

/**
 * Maker rebate share per category.
 * Fraction of taker fees redistributed daily to makers.
 */
export const MAKER_REBATE_SHARES: Record<FeeCategory, number> = {
  crypto:      0.20,
  economics:   0.25,
  culture:     0.25,
  weather:     0.25,
  mentions:    0.25,
  finance:     0.50,
  politics:    0.25,
  tech:        0.25,
  sports:      0.25,
  geopolitics: 0.00,
  other:       0.25,
};

// ============================================================================
// Fee Calculations
// ============================================================================

/**
 * Calculate the taker fee for a single trade leg.
 *
 * @param shares - Number of shares traded
 * @param price - Share price (0 to 1)
 * @param category - Market's fee category (defaults to 'other')
 * @returns Fee in USDC
 */
export function calculateTakerFee(
  shares: number,
  price: number,
  category: FeeCategory = 'other',
): number {
  const feeRate = TAKER_FEE_RATES[category] ?? TAKER_FEE_RATES.other;
  return shares * feeRate * price * (1 - price);
}

/**
 * Calculate total taker fees for a binary arbitrage trade (both legs).
 * Arb requires buying BOTH YES and NO as taker, so fee is charged on each leg.
 *
 * @param shares - Shares per leg
 * @param yesPrice - YES token price
 * @param noPrice - NO token price
 * @param category - Fee category
 * @returns Total fee for both legs in USDC
 */
export function calculateArbTakerFees(
  shares: number,
  yesPrice: number,
  noPrice: number,
  category: FeeCategory = 'other',
): number {
  return (
    calculateTakerFee(shares, yesPrice, category) +
    calculateTakerFee(shares, noPrice, category)
  );
}

/**
 * Estimate maker rebate from a taker fee pool.
 * Rebates are paid daily in aggregate, not per-fill.
 *
 * @param takerFeePool - Total taker fees collected
 * @param category - Fee category
 * @returns Estimated rebate in USDC
 */
export function estimateMakerRebate(
  takerFeePool: number,
  category: FeeCategory = 'other',
): number {
  const share = MAKER_REBATE_SHARES[category] ?? MAKER_REBATE_SHARES.other;
  return takerFeePool * share;
}

// ============================================================================
// Rebate-Aware Break-Even Spread (03 SS3.5, Phase C Item 10)
// ============================================================================

/**
 * Compute the break-even spread in ticks for a maker in a given category.
 *
 * Per 03 SS3.5: "Compute minSpreadTicks per category from the live fee formula
 * + rebate share." As a maker, our per-fill income is:
 *   income = spread/2 + rebatePerShare
 *
 * where rebatePerShare = feeRate * p * (1-p) * rebateShare.
 *
 * The break-even spread is 0 when rebate > 0 (since spread/2 >= 0 always adds
 * to rebate income). But we want a *profitable* floor that accounts for the
 * risk of adverse selection: the floor should ensure that even if the rebate
 * drops, the spread alone still covers flatten costs.
 *
 * Flatten cost per share (worst case, taking at mid):
 *   flattenCost = feeRate * p * (1-p)   (we become taker to flatten)
 *
 * So the dynamic floor = ceil((2 * flattenCost - 2 * rebatePerShare) / tickSize)
 *                       = ceil(2 * feeRate * p * (1-p) * (1 - rebateShare) / tickSize)
 *
 * For fee-free categories: feeRate=0, rebate=0 => floor is 0 ticks from costs
 * (but the config minSpreadTicksByCategory sets a higher floor for spread income).
 *
 * @param category - Market fee category
 * @param price - Current share price (0 to 1), used to evaluate fee at that price point
 * @param tickSize - Tick size string ('0.01', '0.001', etc.)
 * @returns Minimum spread in ticks to break even after costs. Always >= 0.
 */
export function computeBreakEvenSpreadTicks(
  category: FeeCategory,
  price: number,
  tickSize: string,
): number {
  const feeRate = TAKER_FEE_RATES[category] ?? TAKER_FEE_RATES.other;
  const rebateShare = MAKER_REBATE_SHARES[category] ?? MAKER_REBATE_SHARES.other;
  const tickSizeValue = parseFloat(tickSize);

  if (tickSizeValue <= 0) return 0;
  if (feeRate <= 0) return 0; // fee-free: no cost to cover

  // Per-share fee at this price level
  const feePerShare = feeRate * price * (1 - price);
  // Per-share rebate income
  const rebatePerShare = feePerShare * rebateShare;
  // Net cost to flatten one share (we pay taker fee, offset by rebate earned on original fill)
  const netCostPerShare = feePerShare - rebatePerShare;
  // Spread must cover 2 * netCost (one for each side of the round-trip)
  // Actually: we earn spread/2 per fill + rebate. To flatten we pay feePerShare as taker.
  // Net per round-trip: spread - feePerShare + rebatePerShare
  // Break-even: spread >= feePerShare - rebatePerShare = feePerShare * (1 - rebateShare)
  const breakEvenSpread = feePerShare * (1 - rebateShare);
  const breakEvenTicks = Math.ceil(breakEvenSpread / tickSizeValue);

  return Math.max(0, breakEvenTicks);
}

/**
 * Compute the per-share rebate income in bps for a given category and price.
 * Used by edgeScore computation (Phase C Item 9).
 *
 * rebateBps = (feeRate * p * (1-p) * rebateShare) / p * 10000
 * Simplified: rebateBps = feeRate * (1-p) * rebateShare * 10000
 *
 * @param category - Market fee category
 * @param price - Current share price
 * @returns Rebate income in bps per fill
 */
export function computeRebateBpsPerFill(
  category: FeeCategory,
  price: number,
): number {
  const feeRate = TAKER_FEE_RATES[category] ?? TAKER_FEE_RATES.other;
  const rebateShare = MAKER_REBATE_SHARES[category] ?? MAKER_REBATE_SHARES.other;
  if (price <= 0) return 0;
  // Rebate per share = feeRate * p * (1-p) * rebateShare
  // In bps of share price: rebatePerShare / price * 10000
  return (feeRate * (1 - price) * rebateShare) * 10000;
}

// ============================================================================
// Tag-to-Category Mapping
// ============================================================================

const TAG_TO_FEE_CATEGORY: Record<string, FeeCategory> = {
  crypto: 'crypto',
  bitcoin: 'crypto',
  ethereum: 'crypto',
  solana: 'crypto',
  xrp: 'crypto',
  economics: 'economics',
  culture: 'culture',
  weather: 'weather',
  mentions: 'mentions',
  finance: 'finance',
  politics: 'politics',
  sports: 'sports',
  tech: 'tech',
  technology: 'tech',
  geopolitics: 'geopolitics',
};

/**
 * Derive a fee category from GammaMarket tags.
 * Scans tags in order; first recognized tag determines category.
 *
 * @param tags - Array of tag strings from GammaMarket (e.g. ["crypto", "bitcoin"])
 * @returns The fee category, or 'other' if unrecognized
 */
export function categoryFromTags(tags?: string[]): FeeCategory {
  if (!tags || tags.length === 0) return 'other';
  for (const tag of tags) {
    const match = TAG_TO_FEE_CATEGORY[tag.toLowerCase().trim()];
    if (match) return match;
  }
  return 'other';
}
