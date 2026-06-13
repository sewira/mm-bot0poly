/**
 * Fee Utilities Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  calculateTakerFee,
  calculateArbTakerFees,
  estimateMakerRebate,
  categoryFromTags,
  TAKER_FEE_RATES,
  MAKER_REBATE_SHARES,
  type FeeCategory,
} from './fee-utils.js';

describe('Fee Utilities', () => {
  describe('calculateTakerFee', () => {
    it('crypto at p=0.50: 100 shares should cost $1.80 (known max)', () => {
      expect(calculateTakerFee(100, 0.50, 'crypto')).toBeCloseTo(1.80, 6);
    });

    it('sports at p=0.50: 100 shares should cost $0.75', () => {
      expect(calculateTakerFee(100, 0.50, 'sports')).toBeCloseTo(0.75, 6);
    });

    it('finance at p=0.50: 100 shares should cost $1.00', () => {
      expect(calculateTakerFee(100, 0.50, 'finance')).toBeCloseTo(1.00, 6);
    });

    it('geopolitics is always $0 (fee-free)', () => {
      expect(calculateTakerFee(100, 0.50, 'geopolitics')).toBe(0);
      expect(calculateTakerFee(1000, 0.30, 'geopolitics')).toBe(0);
    });

    it('fee is 0 at price extremes (p=0 and p=1)', () => {
      expect(calculateTakerFee(100, 0, 'crypto')).toBe(0);
      expect(calculateTakerFee(100, 1, 'crypto')).toBe(0);
    });

    it('fee peaks at p=0.50', () => {
      const feeAt50 = calculateTakerFee(100, 0.50, 'crypto');
      const feeAt30 = calculateTakerFee(100, 0.30, 'crypto');
      const feeAt70 = calculateTakerFee(100, 0.70, 'crypto');
      expect(feeAt50).toBeGreaterThan(feeAt30);
      expect(feeAt50).toBeGreaterThan(feeAt70);
    });

    it('fee is symmetric around p=0.50', () => {
      const feeAt30 = calculateTakerFee(100, 0.30, 'crypto');
      const feeAt70 = calculateTakerFee(100, 0.70, 'crypto');
      expect(feeAt30).toBeCloseTo(feeAt70, 10);
    });

    it('crypto at p=0.10: 100 * 0.072 * 0.1 * 0.9 = 0.648', () => {
      expect(calculateTakerFee(100, 0.10, 'crypto')).toBeCloseTo(0.648, 6);
    });

    it('scales linearly with shares', () => {
      const fee10 = calculateTakerFee(10, 0.50, 'crypto');
      const fee100 = calculateTakerFee(100, 0.50, 'crypto');
      expect(fee100).toBeCloseTo(fee10 * 10, 10);
    });

    it('defaults to "other" category when not specified', () => {
      const feeDefault = calculateTakerFee(100, 0.50);
      const feeOther = calculateTakerFee(100, 0.50, 'other');
      expect(feeDefault).toBe(feeOther);
    });
  });

  describe('calculateArbTakerFees', () => {
    it('sums fees for both YES and NO legs', () => {
      const yesFee = calculateTakerFee(10, 0.48, 'crypto');
      const noFee = calculateTakerFee(10, 0.52, 'crypto');
      const arbFee = calculateArbTakerFees(10, 0.48, 0.52, 'crypto');
      expect(arbFee).toBeCloseTo(yesFee + noFee, 10);
    });

    it('arb fee at p=0.50/0.50 is exactly double the single-leg fee', () => {
      const singleFee = calculateTakerFee(100, 0.50, 'politics');
      const arbFee = calculateArbTakerFees(100, 0.50, 0.50, 'politics');
      expect(arbFee).toBeCloseTo(singleFee * 2, 10);
    });

    it('crypto arb at p=0.50: 100 shares = $3.60 total fees', () => {
      const arbFee = calculateArbTakerFees(100, 0.50, 0.50, 'crypto');
      expect(arbFee).toBeCloseTo(3.60, 6);
    });

    it('geopolitics arb is free', () => {
      expect(calculateArbTakerFees(100, 0.50, 0.50, 'geopolitics')).toBe(0);
    });
  });

  describe('estimateMakerRebate', () => {
    it('finance rebate is 25% of taker fees', () => {
      expect(estimateMakerRebate(10, 'finance')).toBeCloseTo(2.5, 10);
    });

    it('crypto rebate is 20% of taker fees', () => {
      expect(estimateMakerRebate(10, 'crypto')).toBeCloseTo(2.0, 10);
    });

    it('politics rebate is 25% of taker fees', () => {
      expect(estimateMakerRebate(10, 'politics')).toBeCloseTo(2.5, 10);
    });

    it('geopolitics rebate is 0', () => {
      expect(estimateMakerRebate(10, 'geopolitics')).toBe(0);
    });
  });

  describe('categoryFromTags', () => {
    it('maps crypto tags', () => {
      expect(categoryFromTags(['crypto'])).toBe('crypto');
      expect(categoryFromTags(['bitcoin', 'trending'])).toBe('crypto');
      expect(categoryFromTags(['ethereum'])).toBe('crypto');
      expect(categoryFromTags(['solana'])).toBe('crypto');
    });

    it('maps politics/sports/finance tags', () => {
      expect(categoryFromTags(['politics'])).toBe('politics');
      expect(categoryFromTags(['sports'])).toBe('sports');
      expect(categoryFromTags(['finance'])).toBe('finance');
    });

    it('maps tech and technology', () => {
      expect(categoryFromTags(['tech'])).toBe('tech');
      expect(categoryFromTags(['technology'])).toBe('tech');
    });

    it('returns "other" for unknown tags', () => {
      expect(categoryFromTags(['random', 'stuff'])).toBe('other');
    });

    it('returns "other" for empty or undefined tags', () => {
      expect(categoryFromTags([])).toBe('other');
      expect(categoryFromTags(undefined)).toBe('other');
    });

    it('uses first recognized tag', () => {
      expect(categoryFromTags(['trending', 'crypto', 'politics'])).toBe('crypto');
    });

    it('is case-insensitive', () => {
      expect(categoryFromTags(['CRYPTO'])).toBe('crypto');
      expect(categoryFromTags(['Politics'])).toBe('politics');
    });
  });

  describe('fee rate constants sanity', () => {
    it('all fee rates are non-negative', () => {
      for (const [cat, rate] of Object.entries(TAKER_FEE_RATES)) {
        expect(rate).toBeGreaterThanOrEqual(0);
      }
    });

    it('all rebate shares are between 0 and 1', () => {
      for (const [cat, share] of Object.entries(MAKER_REBATE_SHARES)) {
        expect(share).toBeGreaterThanOrEqual(0);
        expect(share).toBeLessThanOrEqual(1);
      }
    });

    it('crypto has the highest fee rate', () => {
      for (const [cat, rate] of Object.entries(TAKER_FEE_RATES)) {
        expect(TAKER_FEE_RATES.crypto).toBeGreaterThanOrEqual(rate);
      }
    });
  });
});
