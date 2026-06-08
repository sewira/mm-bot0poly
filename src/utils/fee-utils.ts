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
