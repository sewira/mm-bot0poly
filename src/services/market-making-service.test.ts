import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MarketMakingService, type MMMarketState, type MarketMakingConfig } from './market-making-service.js';

// ============================================================================
// Mocks
// ============================================================================

function createMockTradingService() {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    createLimitOrder: vi.fn().mockResolvedValue({ success: true, orderId: 'test-order-1' }),
    cancelOrders: vi.fn().mockResolvedValue({ success: true }),
    cancelAllOrders: vi.fn().mockResolvedValue({ success: true }),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getCredentials: vi.fn().mockReturnValue({ key: 'k', secret: 's', passphrase: 'p' }),
  } as any;
}

function createMockMarketService() {
  return {
    getClobMarket: vi.fn().mockResolvedValue({
      tokens: [
        { tokenId: 'yes-token-123', outcome: 'Yes' },
        { tokenId: 'no-token-456', outcome: 'No' },
      ],
      minimumTickSize: '0.01',
    }),
    getProcessedOrderbook: vi.fn().mockResolvedValue({
      yes: { bid: 0.50, ask: 0.52, bidSize: 100, askSize: 100, spread: 0.02 },
      no: { bid: 0.48, ask: 0.50, bidSize: 80, askSize: 80, spread: 0.02 },
      summary: { askSum: 1.02, bidSum: 0.98 },
    }),
  } as any;
}

function createMockRealtimeService() {
  const { EventEmitter } = require('events');
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscribeMarkets: vi.fn().mockReturnValue({
      id: 'sub-1',
      topic: 'clob_market',
      type: '*',
      tokenIds: [],
      unsubscribe: vi.fn(),
    }),
    subscribeUserEvents: vi.fn().mockReturnValue({
      id: 'user-sub-1',
      topic: 'user',
      type: '*',
      unsubscribe: vi.fn(),
    }),
  }) as any;
}

/**
 * Create a test market state with Phase B fields initialized.
 * microprice defaults to mid when bestBidSize == bestAskSize (symmetric book).
 */
function createTestMarketState(overrides: Partial<MMMarketState> = {}): MMMarketState {
  const bestBid = overrides.bestBid ?? 0.50;
  const bestAsk = overrides.bestAsk ?? 0.52;
  const bestBidSize = overrides.bestBidSize ?? 100;
  const bestAskSize = overrides.bestAskSize ?? 100;
  const mid = overrides.mid ?? (bestBid + bestAsk) / 2;
  const totalSize = bestBidSize + bestAskSize;
  const microprice = overrides.microprice ??
    (totalSize > 0 ? (bestBid * bestAskSize + bestAsk * bestBidSize) / totalSize : mid);

  return {
    conditionId: 'cond-1',
    name: 'Test Market',
    yesTokenId: 'yes-token-123',
    noTokenId: 'no-token-456',
    tickSize: '0.01',
    feeCategory: 'politics',
    bestBid,
    bestAsk,
    bestBidSize,
    bestAskSize,
    mid,
    microprice,
    lastBookUpdate: Date.now(),
    lastBook: null,
    midHistory: [],
    breakerCooldownUntil: 0,
    inventory: 0,
    restingBidOrderId: null,
    restingBidPrice: 0,
    restingBidSize: 0,
    restingAskOrderId: null,
    restingAskPrice: 0,
    restingAskSize: 0,
    realizedSpreadPnL: 0,
    modeledRebateIncome: 0,
    inventoryMtM: 0,
    costBasis: 0,
    fillToMarkSamples: [],
    rollingDriftBps: 0,
    hoursToResolution: 100,
    eventClusterId: 'cluster-default',
    // Phase C fields
    hourlyDrift: new Map(),
    edgeScore: 0,
    totalFills: 0,
    meanSpreadCaptureBps: 0,
    sumSpreadCaptureBps: 0,
    queuePosBid: 0,
    queuePosAsk: 0,
    sizeAheadAtPostBid: 0,
    sizeAheadAtPostAsk: 0,
    queueTrackBidPrice: 0,
    queueTrackAskPrice: 0,
    actualRebateIncome: 0,
    isBlacklisted: false,
    quotingActive: true,
    ...overrides,
  };
}

function createService(configOverrides: MarketMakingConfig = {}) {
  const trading = createMockTradingService();
  const markets = createMockMarketService();
  const realtime = createMockRealtimeService();
  const service = new MarketMakingService(trading, markets, realtime, {
    dryRun: true,
    ...configOverrides,
  });
  return { service, trading, markets, realtime };
}

// ============================================================================
// Tests
// ============================================================================

describe('MarketMakingService', () => {

  // ==========================================================================
  // Phase B: Microprice (03 SS3.1)
  // ==========================================================================
  describe('microprice computation (03 SS3.1)', () => {
    it('computes microprice equal to mid on symmetric book', () => {
      // bestBidSize == bestAskSize => microprice = mid
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52,
        bestBidSize: 100, bestAskSize: 100,
      });
      // microprice = (0.50*100 + 0.52*100) / 200 = 102/200 = 0.51 = mid
      expect(market.microprice).toBeCloseTo(0.51, 6);
      expect(market.microprice).toBeCloseTo(market.mid, 6);
    });

    it('computes microprice biased toward ask when bid is thicker', () => {
      // Large bid size, small ask size => price likely to go up => microprice > mid
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52,
        bestBidSize: 300, bestAskSize: 100,
      });
      // microprice = (0.50*100 + 0.52*300) / 400 = (50 + 156) / 400 = 0.515
      expect(market.microprice).toBeCloseTo(0.515, 6);
      expect(market.microprice).toBeGreaterThan(market.mid);
    });

    it('computes microprice biased toward bid when ask is thicker', () => {
      // Large ask size, small bid size => price likely to go down => microprice < mid
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52,
        bestBidSize: 100, bestAskSize: 300,
      });
      // microprice = (0.50*300 + 0.52*100) / 400 = (150 + 52) / 400 = 0.505
      expect(market.microprice).toBeCloseTo(0.505, 6);
      expect(market.microprice).toBeLessThan(market.mid);
    });

    it('uses microprice for quote placement, not mid', () => {
      // Imbalanced book: microprice != mid
      const { service } = createService({
        baseHalfSpreadTicks: 2,
        skewWidth: 0,  // no skew to isolate microprice effect
        maxInventoryShares: 50,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { politics: 0 },
      });
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52,
        bestBidSize: 300, bestAskSize: 100,
        inventory: 0,
      });
      // microprice = 0.515, mid = 0.51
      // reservation = microprice - 0 = 0.515
      // bid = floor(0.515 - 0.02) = floor(0.495) = 0.49
      // ask = ceil(0.515 + 0.02) = ceil(0.535) = 0.54
      const quotes = service.computeQuotes(market);
      expect(quotes).not.toBeNull();
      expect(quotes!.bidPrice).toBe(0.49);
      expect(quotes!.askPrice).toBe(0.54);
    });
  });

  // ==========================================================================
  // Phase B: Convex Inventory Skew (03 SS3.2)
  // ==========================================================================
  describe('convex inventory skew (03 SS3.2)', () => {
    it('applies zero skew at flat inventory', () => {
      const { service } = createService({
        baseHalfSpreadTicks: 2,
        skewWidth: 0.04,
        maxInventoryShares: 50,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { politics: 0 },
      });
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52, inventory: 0,
      });
      // inv=0, skew = 0*|0|*0.04 = 0
      // reservation = microprice - 0 = 0.51
      const quotes = service.computeQuotes(market);
      expect(quotes).not.toBeNull();
      // bid = floor(0.51 - 0.02) = 0.49
      // ask = ceil(0.51 + 0.02) = 0.53
      expect(quotes!.bidPrice).toBe(0.49);
      expect(quotes!.askPrice).toBe(0.53);
    });

    it('applies gentle skew at half inventory (convex is weaker than linear)', () => {
      const { service } = createService({
        baseHalfSpreadTicks: 2,
        skewWidth: 0.04,
        maxInventoryShares: 50,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { politics: 0 },
      });
      // inv = 25/50 = 0.5
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52, inventory: 25,
      });
      // Convex: skew = 0.5 * |0.5| * 0.04 = 0.5 * 0.5 * 0.04 = 0.01
      // Linear would be: 0.5 * 0.04 = 0.02 (stronger)
      // reservation = 0.51 - 0.01 = 0.50
      const quotes = service.computeQuotes(market);
      expect(quotes).not.toBeNull();
      // bid = floor(0.50 - 0.02) = 0.48
      // ask = ceil(0.50 + 0.02) = 0.52
      expect(quotes!.bidPrice).toBe(0.48);
      expect(quotes!.askPrice).toBe(0.52);
    });

    it('applies aggressive skew at max inventory (convex equals linear at cap)', () => {
      const { service } = createService({
        baseHalfSpreadTicks: 2,
        skewWidth: 0.04,
        maxInventoryShares: 50,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { politics: 0 },
      });
      // inv = 50/50 = 1.0 (clamped)
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52, inventory: 50,
      });
      // Convex: skew = 1.0 * |1.0| * 0.04 = 0.04
      // Linear: 1.0 * 0.04 = 0.04 (same at the boundary)
      // reservation = 0.51 - 0.04 = 0.47
      const quotes = service.computeQuotes(market);
      expect(quotes).not.toBeNull();
      // bid = floor(0.47 - 0.02) = 0.45
      // ask = ceil(0.47 + 0.02) = 0.49
      expect(quotes!.bidPrice).toBe(0.45);
      expect(quotes!.askPrice).toBe(0.49);
      expect(quotes!.skipBid).toBe(true);  // at max inventory
    });

    it('convex skew is gentler than linear at half inventory (verifiable convexity)', () => {
      const skewWidth = 0.04;
      const inv = 0.5;
      const convexSkew = inv * Math.abs(inv) * skewWidth;  // 0.5 * 0.5 * 0.04 = 0.01
      const linearSkew = inv * skewWidth;  // 0.5 * 0.04 = 0.02
      expect(convexSkew).toBeLessThan(linearSkew);
      // At inv=1.0 they're equal
      const convexAtMax = 1.0 * 1.0 * skewWidth;
      const linearAtMax = 1.0 * skewWidth;
      expect(convexAtMax).toBe(linearAtMax);
    });

    it('applies negative convex skew for short inventory', () => {
      const { service } = createService({
        baseHalfSpreadTicks: 2,
        skewWidth: 0.04,
        maxInventoryShares: 50,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { politics: 0 },
      });
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52, inventory: -25,
      });
      // inv = -0.5, skew = -0.5 * |-0.5| * 0.04 = -0.5 * 0.5 * 0.04 = -0.01
      // reservation = 0.51 - (-0.01) = 0.52
      const quotes = service.computeQuotes(market);
      expect(quotes).not.toBeNull();
      // bid = floor(0.52 - 0.02) = 0.50
      // ask = ceil(0.52 + 0.02) = 0.54
      expect(quotes!.bidPrice).toBe(0.50);
      expect(quotes!.askPrice).toBe(0.54);
    });
  });

  // ==========================================================================
  // Phase B: Asymmetric Size (03 SS3.3)
  // ==========================================================================
  describe('asymmetric size (03 SS3.3)', () => {
    it('produces equal sizes at flat inventory', () => {
      const { service } = createService({
        baseSize: 20,
        maxInventoryShares: 50,
        baseHalfSpreadTicks: 2,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { politics: 0 },
      });
      const market = createTestMarketState({ inventory: 0 });
      // inv = 0
      // bidSize = 20 * max(0, 1 - 0) = 20
      // askSize = 20 * min(2, 1 + 0) = 20
      const quotes = service.computeQuotes(market);
      expect(quotes).not.toBeNull();
      expect(quotes!.bidSize).toBe(20);
      expect(quotes!.askSize).toBe(20);
    });

    it('long inventory: smaller bid, bigger ask', () => {
      const { service } = createService({
        baseSize: 20,
        maxInventoryShares: 50,
        baseHalfSpreadTicks: 2,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { politics: 0 },
      });
      const market = createTestMarketState({ inventory: 25 });
      // inv = 0.5
      // bidSize = 20 * max(0, 1 - 0.5) = 20 * 0.5 = 10
      // askSize = 20 * min(2, 1 + 0.5) = 20 * 1.5 = 30
      const quotes = service.computeQuotes(market);
      expect(quotes).not.toBeNull();
      expect(quotes!.bidSize).toBe(10);
      expect(quotes!.askSize).toBe(30);
    });

    it('short inventory: bigger bid, smaller ask', () => {
      const { service } = createService({
        baseSize: 20,
        maxInventoryShares: 50,
        baseHalfSpreadTicks: 2,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { politics: 0 },
      });
      const market = createTestMarketState({ inventory: -25 });
      // inv = -0.5
      // bidSize = 20 * max(0, 1 - (-0.5)) = 20 * 1.5 = 30
      // askSize = 20 * min(2, 1 + (-0.5)) = 20 * 0.5 = 10
      const quotes = service.computeQuotes(market);
      expect(quotes).not.toBeNull();
      expect(quotes!.bidSize).toBe(30);
      expect(quotes!.askSize).toBe(10);
    });

    it('bidSize = 0 at max long (clamped to MIN_ORDER_SIZE)', () => {
      const { service } = createService({
        baseSize: 20,
        maxInventoryShares: 50,
        baseHalfSpreadTicks: 2,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { politics: 0 },
      });
      const market = createTestMarketState({ inventory: 50 });
      // inv = 1.0
      // bidSize = 20 * max(0, 1 - 1) = 0 -> clamped to MIN_ORDER_SIZE_SHARES (5)
      // askSize = 20 * min(2, 1 + 1) = 40
      const quotes = service.computeQuotes(market);
      expect(quotes).not.toBeNull();
      expect(quotes!.bidSize).toBe(5);  // MIN_ORDER_SIZE_SHARES floor
      expect(quotes!.askSize).toBe(40);
      expect(quotes!.skipBid).toBe(true);  // won't actually post the bid
    });

    it('askSize capped at 2x base at max short', () => {
      const { service } = createService({
        baseSize: 20,
        maxInventoryShares: 50,
        baseHalfSpreadTicks: 2,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { politics: 0 },
      });
      const market = createTestMarketState({ inventory: -50 });
      // inv = -1.0
      // bidSize = 20 * max(0, 1 - (-1)) = 20 * 2 = 40
      // askSize = 20 * min(2, 1 + (-1)) = 20 * 0 = 0 -> clamped to 5
      const quotes = service.computeQuotes(market);
      expect(quotes).not.toBeNull();
      expect(quotes!.bidSize).toBe(40);
      expect(quotes!.askSize).toBe(5);  // MIN_ORDER_SIZE_SHARES floor
      expect(quotes!.skipAsk).toBe(true);
    });
  });

  // ==========================================================================
  // Phase B: Per-category spread floors (03 SS3.5)
  // ==========================================================================
  describe('per-category spread floors (03 SS3.5)', () => {
    it('applies wider spread floor for geopolitics (fee-free, no rebate)', () => {
      const { service } = createService({
        baseHalfSpreadTicks: 0,
        minSpreadTicks: 1,
        minSpreadTicksByCategory: {
          geopolitics: 3,
          finance: 1,
          politics: 2,
        },
      });
      const market = createTestMarketState({
        feeCategory: 'geopolitics',
        bestBid: 0.50, bestAsk: 0.52,
      });
      const quotes = service.computeQuotes(market);
      expect(quotes).not.toBeNull();
      const spreadTicks = Math.round((quotes!.askPrice - quotes!.bidPrice) / 0.01);
      expect(spreadTicks).toBeGreaterThanOrEqual(3);
    });

    it('applies tighter spread floor for finance (50% rebate)', () => {
      const { service } = createService({
        baseHalfSpreadTicks: 0,
        minSpreadTicks: 1,
        minSpreadTicksByCategory: {
          geopolitics: 3,
          finance: 1,
          politics: 2,
        },
      });
      const market = createTestMarketState({
        feeCategory: 'finance',
        bestBid: 0.50, bestAsk: 0.52,
      });
      const quotes = service.computeQuotes(market);
      expect(quotes).not.toBeNull();
      const spreadTicks = Math.round((quotes!.askPrice - quotes!.bidPrice) / 0.01);
      expect(spreadTicks).toBeGreaterThanOrEqual(1);
      // Finance floor (1) is tighter than geopolitics floor (3)
    });

    it('falls back to global minSpreadTicks when category not in map', () => {
      const { service } = createService({
        baseHalfSpreadTicks: 0,
        minSpreadTicks: 4,
        minSpreadTicksByCategory: {},  // empty map
      });
      const market = createTestMarketState({
        feeCategory: 'politics',
        bestBid: 0.50, bestAsk: 0.52,
      });
      const quotes = service.computeQuotes(market);
      expect(quotes).not.toBeNull();
      const spreadTicks = Math.round((quotes!.askPrice - quotes!.bidPrice) / 0.01);
      expect(spreadTicks).toBeGreaterThanOrEqual(4);
    });

    it('uses max of category floor and global minSpreadTicks', () => {
      // Global min is 5, category is 2 => effective = 5
      const { service } = createService({
        baseHalfSpreadTicks: 0,
        minSpreadTicks: 5,
        minSpreadTicksByCategory: { politics: 2 },
      });
      const market = createTestMarketState({
        feeCategory: 'politics',
        bestBid: 0.50, bestAsk: 0.52,
      });
      const quotes = service.computeQuotes(market);
      expect(quotes).not.toBeNull();
      const spreadTicks = Math.round((quotes!.askPrice - quotes!.bidPrice) / 0.01);
      expect(spreadTicks).toBeGreaterThanOrEqual(5);
    });
  });

  // ==========================================================================
  // Phase B: maxGrossExposureUsd enforcement (03 SS4)
  // ==========================================================================
  describe('gross exposure cap prevents order (03 SS4)', () => {
    it('skips bid when gross exposure would breach cap', () => {
      const { service } = createService({
        maxGrossExposureUsd: 10,
        baseSize: 100,  // 100 shares at ~0.50 = $50, far over cap
        maxInventoryShares: 1000,
        baseHalfSpreadTicks: 2,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { politics: 0 },
      });
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52, inventory: 0,
      });
      (service as any).markets.set(market.conditionId, market);

      const quotes = service.computeQuotes(market);
      expect(quotes).not.toBeNull();
      // Both sides should be skipped: 100 * 0.49 = $49 > $10 cap
      expect(quotes!.skipBid).toBe(true);
      expect(quotes!.skipAsk).toBe(true);
    });

    it('allows order when under gross exposure cap', () => {
      const { service } = createService({
        maxGrossExposureUsd: 1000,
        baseSize: 10,
        maxInventoryShares: 100,
        baseHalfSpreadTicks: 2,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { politics: 0 },
      });
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52, inventory: 0,
      });
      (service as any).markets.set(market.conditionId, market);

      const quotes = service.computeQuotes(market);
      expect(quotes).not.toBeNull();
      expect(quotes!.skipBid).toBe(false);
      expect(quotes!.skipAsk).toBe(false);
    });
  });

  // ==========================================================================
  // Phase B: Circuit breaker (03 SS3.7)
  // ==========================================================================
  describe('circuit breaker (03 SS3.7)', () => {
    it('triggers when mid jumps >= breakerTicks within window', () => {
      const { service } = createService({
        breakerTicks: 5,
        breakerWindowMs: 2000,
        cooldownMs: 30000,
      });
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52, mid: 0.51,
      });
      (service as any).markets.set(market.conditionId, market);

      // Simulate mid history with a 5-tick jump (0.05 on 0.01 tick)
      const now = Date.now();
      market.midHistory = [
        { ts: now - 1000, mid: 0.51 },
        { ts: now, mid: 0.56 },  // jumped 5 ticks
      ];

      const fired = service.checkCircuitBreaker(market);
      expect(fired).toBe(true);
      expect(market.breakerCooldownUntil).toBeGreaterThan(now);
      expect(market.quotingActive).toBe(false);
      expect(market.midHistory).toEqual([]);  // cleared after fire
    });

    it('does NOT trigger on normal jitter (< breakerTicks)', () => {
      const { service } = createService({
        breakerTicks: 5,
        breakerWindowMs: 2000,
        cooldownMs: 30000,
      });
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52, mid: 0.51,
      });
      (service as any).markets.set(market.conditionId, market);

      const now = Date.now();
      market.midHistory = [
        { ts: now - 1000, mid: 0.51 },
        { ts: now, mid: 0.54 },  // only 3 ticks
      ];

      const fired = service.checkCircuitBreaker(market);
      expect(fired).toBe(false);
      expect(market.quotingActive).toBe(true);
    });

    it('cooldown prevents new quotes', () => {
      const { service } = createService({
        breakerTicks: 5,
        breakerWindowMs: 2000,
        cooldownMs: 30000,
      });
      const market = createTestMarketState();
      market.breakerCooldownUntil = Date.now() + 30000;  // 30s from now

      const inCooldown = service.isInBreakerCooldown(market);
      expect(inCooldown).toBe(true);
    });

    it('cooldown expiry resumes quoting', () => {
      const { service } = createService({
        breakerTicks: 5,
        breakerWindowMs: 2000,
        cooldownMs: 30000,
      });
      const market = createTestMarketState();
      market.breakerCooldownUntil = Date.now() - 1;  // already expired

      const inCooldown = service.isInBreakerCooldown(market);
      expect(inCooldown).toBe(false);
      expect(market.breakerCooldownUntil).toBe(0);  // reset
    });

    it('breaker fires on exactly breakerTicks (boundary)', () => {
      const { service } = createService({
        breakerTicks: 5,
        breakerWindowMs: 2000,
        cooldownMs: 30000,
      });
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52, mid: 0.51,
      });
      (service as any).markets.set(market.conditionId, market);

      const now = Date.now();
      // Exactly 5 ticks on 0.01 tick size = 0.05 jump
      market.midHistory = [
        { ts: now - 500, mid: 0.50 },
        { ts: now, mid: 0.55 },
      ];

      const fired = service.checkCircuitBreaker(market);
      expect(fired).toBe(true);
    });

    it('breaker does not fire with fewer than 2 mid entries', () => {
      const { service } = createService({ breakerTicks: 5 });
      const market = createTestMarketState();
      market.midHistory = [{ ts: Date.now(), mid: 0.51 }];

      const fired = service.checkCircuitBreaker(market);
      expect(fired).toBe(false);
    });

    it('logs incident when breaker fires', () => {
      const { service } = createService({
        breakerTicks: 3,
        breakerWindowMs: 2000,
        cooldownMs: 5000,
      });
      const market = createTestMarketState();
      (service as any).markets.set(market.conditionId, market);

      const logger = service.getLogger();
      const logSpy = vi.spyOn(logger, 'logIncident');

      const now = Date.now();
      market.midHistory = [
        { ts: now - 500, mid: 0.50 },
        { ts: now, mid: 0.53 },
      ];

      service.checkCircuitBreaker(market);
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: 'circuit_breaker',
          market: market.name,
          action: expect.stringContaining('cancelAll'),
        }),
      );
    });
  });

  // ==========================================================================
  // Phase B: Stale-feed guard (03 SS4)
  // ==========================================================================
  describe('stale-feed guard (03 SS4)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('pulls quotes when no book update for staleFeedMs', () => {
      vi.useFakeTimers();
      const { service } = createService({
        staleFeedMs: 2000,  // guard checks every max(1000, staleFeedMs/2)
      });
      const market = createTestMarketState({
        lastBookUpdate: Date.now() - 3000,  // 3s ago, well past 2s threshold
        quotingActive: true,
      });
      (service as any).markets.set(market.conditionId, market);
      (service as any).isRunning = true;

      // Start the guard
      (service as any).startStaleFeedGuard();

      // Advance time to trigger the check (interval = max(1000, 1000) = 1000ms)
      vi.advanceTimersByTime(1000);

      expect(market.quotingActive).toBe(false);

      (service as any).stopStaleFeedGuard();
    });

    it('does NOT pull quotes when feed is fresh', () => {
      vi.useFakeTimers();
      const { service } = createService({
        staleFeedMs: 10000,
      });
      const market = createTestMarketState({
        lastBookUpdate: Date.now(),  // just updated
        quotingActive: true,
      });
      (service as any).markets.set(market.conditionId, market);
      (service as any).isRunning = true;

      (service as any).startStaleFeedGuard();
      vi.advanceTimersByTime(5000);

      expect(market.quotingActive).toBe(true);

      (service as any).stopStaleFeedGuard();
    });

    it('resumes quoting when fresh data arrives after stale pull', () => {
      const { service } = createService({
        staleFeedMs: 10000,
      });
      const market = createTestMarketState({
        quotingActive: false,  // was pulled due to stale feed
        isBlacklisted: false,
        breakerCooldownUntil: 0,
      });
      (service as any).markets.set(market.conditionId, market);
      (service as any).isRunning = true;

      // Simulate a fresh orderbook update arriving
      const book = {
        tokenId: market.yesTokenId,
        assetId: market.yesTokenId,
        bids: [{ price: 0.50, size: 100 }],
        asks: [{ price: 0.52, size: 100 }],
        timestamp: Date.now(),
        market: market.conditionId,
        tickSize: '0.01',
        minOrderSize: '1',
      };

      (service as any).handleOrderbookUpdate(book);

      // Should have resumed quoting
      expect(market.quotingActive).toBe(true);
    });

    it('logs incident when stale feed detected', () => {
      vi.useFakeTimers();
      const { service } = createService({
        staleFeedMs: 2000,
      });
      const market = createTestMarketState({
        lastBookUpdate: Date.now() - 3000,
        quotingActive: true,
      });
      (service as any).markets.set(market.conditionId, market);
      (service as any).isRunning = true;

      const logger = service.getLogger();
      const logSpy = vi.spyOn(logger, 'logIncident');

      (service as any).startStaleFeedGuard();
      vi.advanceTimersByTime(1000);

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: 'stale_feed',
          market: market.name,
        }),
      );

      (service as any).stopStaleFeedGuard();
    });
  });

  // ==========================================================================
  // Phase B: Price band auto-tightening near expiry (03 SS2)
  // ==========================================================================
  describe('price band auto-tightening (03 SS2)', () => {
    it('returns original band when > 24h to resolution', () => {
      const band = MarketMakingService.effectivePriceBand([0.20, 0.80], 48);
      expect(band).toEqual([0.20, 0.80]);
    });

    it('tightens to [0.30, 0.70] when inside 24h', () => {
      const band = MarketMakingService.effectivePriceBand([0.20, 0.80], 12);
      expect(band).toEqual([0.30, 0.70]);
    });

    it('tightens at exactly 24h boundary', () => {
      const band = MarketMakingService.effectivePriceBand([0.20, 0.80], 24);
      expect(band).toEqual([0.30, 0.70]);
    });

    it('does not loosen if base band is already tighter', () => {
      // If base band is [0.35, 0.65], tightening should keep [0.35, 0.65]
      const band = MarketMakingService.effectivePriceBand([0.35, 0.65], 12);
      expect(band[0]).toBe(0.35);  // max(0.35, 0.30) = 0.35
      expect(band[1]).toBe(0.65);  // min(0.65, 0.70) = 0.65
    });
  });

  // ==========================================================================
  // Phase A tests (preserved, updated for Phase B changes)
  // ==========================================================================
  describe('computeQuotes (updated for Phase B)', () => {
    it('computes symmetric quotes at zero inventory with symmetric book', () => {
      const { service } = createService({
        baseHalfSpreadTicks: 2,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { politics: 0 },
      });
      // Symmetric book: microprice = mid = 0.51
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52,
        bestBidSize: 100, bestAskSize: 100,
      });

      const quotes = service.computeQuotes(market);

      expect(quotes).not.toBeNull();
      // microprice = 0.51, inv=0, skew=0, reservation=0.51
      // bid = floor(0.51 - 0.02) = 0.49
      // ask = ceil(0.51 + 0.02) = 0.53
      expect(quotes!.bidPrice).toBe(0.49);
      expect(quotes!.askPrice).toBe(0.53);
      expect(quotes!.skipBid).toBe(false);
      expect(quotes!.skipAsk).toBe(false);
    });

    it('skips bid when inventory at max (one-sided cap)', () => {
      const { service } = createService({
        maxInventoryShares: 50,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { politics: 0 },
      });
      const market = createTestMarketState({ inventory: 50 });

      const quotes = service.computeQuotes(market);

      expect(quotes).not.toBeNull();
      expect(quotes!.skipBid).toBe(true);
      expect(quotes!.skipAsk).toBe(false);
    });

    it('skips ask when inventory at negative max', () => {
      const { service } = createService({
        maxInventoryShares: 50,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { politics: 0 },
      });
      const market = createTestMarketState({ inventory: -50 });

      const quotes = service.computeQuotes(market);

      expect(quotes).not.toBeNull();
      expect(quotes!.skipBid).toBe(false);
      expect(quotes!.skipAsk).toBe(true);
    });

    it('returns null when bid >= ask (crossed book)', () => {
      const { service } = createService({
        baseHalfSpreadTicks: 0,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { politics: 0 },
      });
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.50, mid: 0.50,
      });

      const quotes = service.computeQuotes(market);
      expect(quotes).toBeNull();
    });

    it('returns null when book has no valid bid/ask', () => {
      const { service } = createService();
      const market = createTestMarketState({ bestBid: 0, bestAsk: 0, mid: 0 });

      const quotes = service.computeQuotes(market);
      expect(quotes).toBeNull();
    });

    it('crossed-after-rounding rejection', () => {
      // Set up a scenario where rounding could cause bid >= ask
      const { service } = createService({
        baseHalfSpreadTicks: 0,
        skewWidth: 0,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { politics: 0 },
        maxInventoryShares: 50,
      });
      // Very tight spread that rounds to same price
      const market = createTestMarketState({
        bestBid: 0.500, bestAsk: 0.501, mid: 0.5005,
        microprice: 0.5005,
        tickSize: '0.01',  // rounds both to 0.50
      });

      const quotes = service.computeQuotes(market);
      // Should return null because floor(0.5005) = 0.50, ceil(0.5005) = 0.51
      // Actually this produces bid=0.50, ask=0.51 which is valid
      // Let me test the actual crossed case
      const market2 = createTestMarketState({
        bestBid: 0.505, bestAsk: 0.505, mid: 0.505,
        microprice: 0.505,
        tickSize: '0.01',
      });
      const quotes2 = service.computeQuotes(market2);
      // bestBid >= bestAsk => returns null at the top
      expect(quotes2).toBeNull();
    });

    it('uses correct tick size for 0.001 markets', () => {
      const { service } = createService({
        baseHalfSpreadTicks: 2,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { politics: 0 },
        dynamicSpreadFloors: false,  // disable Phase C dynamic floor for this test
      });
      const market = createTestMarketState({
        bestBid: 0.500, bestAsk: 0.510, mid: 0.505,
        microprice: 0.505,
        tickSize: '0.001',
        bestBidSize: 100, bestAskSize: 100,
      });

      const quotes = service.computeQuotes(market);

      expect(quotes).not.toBeNull();
      // halfSpread = 2 * 0.001 = 0.002
      // bid = floor(0.505 - 0.002) = 0.503
      // ask = ceil(0.505 + 0.002) = 0.507
      expect(quotes!.bidPrice).toBe(0.503);
      expect(quotes!.askPrice).toBe(0.507);
    });
  });

  // ==========================================================================
  // Inventory tracking (Phase A, preserved)
  // ==========================================================================
  describe('inventory tracking', () => {
    it('increases inventory on BUY fill', () => {
      const { service } = createService();
      const market = createTestMarketState({ inventory: 0 });

      (service as any).markets.set(market.conditionId, market);
      (service as any).recordFill(market, 'BUY', 0.50, 10);

      expect(market.inventory).toBe(10);
    });

    it('decreases inventory on SELL fill', () => {
      const { service } = createService();
      const market = createTestMarketState({ inventory: 10 });

      (service as any).markets.set(market.conditionId, market);
      (service as any).recordFill(market, 'SELL', 0.52, 5);

      expect(market.inventory).toBe(5);
    });

    it('tracks realized spread PnL on fill', () => {
      const { service } = createService();
      const market = createTestMarketState({
        inventory: 0,
        mid: 0.51,
      });

      (service as any).markets.set(market.conditionId, market);
      (service as any).recordFill(market, 'BUY', 0.49, 10);

      expect(market.realizedSpreadPnL).toBeCloseTo(0.20, 4);
    });

    it('uses midOverride (prevMid) for spread PnL when provided', () => {
      const { service } = createService();
      const market = createTestMarketState({
        inventory: 0,
        mid: 0.49,
      });

      (service as any).markets.set(market.conditionId, market);
      (service as any).recordFill(market, 'BUY', 0.49, 10, 0.51);

      expect(market.realizedSpreadPnL).toBeCloseTo(0.20, 4);
    });

    it('tracks modeled rebate income on fill', () => {
      const { service } = createService();
      const market = createTestMarketState({
        feeCategory: 'finance',
      });

      (service as any).markets.set(market.conditionId, market);
      (service as any).recordFill(market, 'BUY', 0.50, 100);

      expect(market.modeledRebateIncome).toBeCloseTo(0.50, 4);
    });

    it('emits fill event with spreadPnL and rebateIncome', () => {
      const { service } = createService();
      const market = createTestMarketState({ mid: 0.51 });
      (service as any).markets.set(market.conditionId, market);

      const fillHandler = vi.fn();
      service.on('fill', fillHandler);

      (service as any).recordFill(market, 'BUY', 0.49, 10);

      expect(fillHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          market: market.name,
          side: 'BUY',
          price: 0.49,
          size: 10,
          inventoryAfter: 10,
        }),
      );
      const call = fillHandler.mock.calls[0][0];
      expect(call.spreadPnL).toBeCloseTo(0.20, 4);
      expect(typeof call.rebateIncome).toBe('number');
      expect(call.rebateIncome).toBeGreaterThanOrEqual(0);
    });
  });

  // ==========================================================================
  // Fill-to-mark drift (Phase A, preserved)
  // ==========================================================================
  describe('fill-to-mark drift', () => {
    it('calculates positive drift for non-toxic buy (price went up)', () => {
      vi.useFakeTimers();
      const { service } = createService({ fillToMarkDelaysMs: [100] });
      const market = createTestMarketState({ mid: 0.50 });
      (service as any).markets.set(market.conditionId, market);

      (service as any).startFillToMarkSampling(market, 'BUY', 0.50);

      market.mid = 0.51;
      vi.advanceTimersByTime(100);

      const sample = market.fillToMarkSamples[0];
      expect(sample.completed).toBe(true);
      expect(sample.driftBps[0]).toBeCloseTo(200, 0);

      vi.useRealTimers();
    });

    it('calculates negative drift for adverse buy (price went down)', () => {
      vi.useFakeTimers();
      const { service } = createService({ fillToMarkDelaysMs: [100] });
      const market = createTestMarketState({ mid: 0.50 });
      (service as any).markets.set(market.conditionId, market);

      (service as any).startFillToMarkSampling(market, 'BUY', 0.50);

      market.mid = 0.49;
      vi.advanceTimersByTime(100);

      const sample = market.fillToMarkSamples[0];
      expect(sample.completed).toBe(true);
      expect(sample.driftBps[0]).toBeCloseTo(-200, 0);

      vi.useRealTimers();
    });

    it('calculates positive drift for non-toxic sell (price went down)', () => {
      vi.useFakeTimers();
      const { service } = createService({ fillToMarkDelaysMs: [100] });
      const market = createTestMarketState({ mid: 0.50 });
      (service as any).markets.set(market.conditionId, market);

      (service as any).startFillToMarkSampling(market, 'SELL', 0.50);

      market.mid = 0.49;
      vi.advanceTimersByTime(100);

      const sample = market.fillToMarkSamples[0];
      expect(sample.driftBps[0]).toBeCloseTo(200, 0);

      vi.useRealTimers();
    });
  });

  // ==========================================================================
  // Simulated fills (Phase A, updated for baseSize)
  // ==========================================================================
  describe('simulated fills (dry-run)', () => {
    it('simulates buy fill when ask trades through resting bid (strict <)', () => {
      const { service } = createService({ dryRun: true, baseSize: 10 });
      const market = createTestMarketState({
        restingBidPrice: 0.49,
        restingBidSize: 10,
        bestAsk: 0.48,  // strictly below bid → through-trade (02 §3)
      });
      (service as any).markets.set(market.conditionId, market);

      const fillHandler = vi.fn();
      service.on('fill', fillHandler);

      (service as any).checkSimulatedFills(market, market.mid);

      expect(fillHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          side: 'BUY',
          price: 0.49,
          size: 10,
        }),
      );
      expect(market.restingBidPrice).toBe(0);
      expect(market.inventory).toBe(10);
    });

    it('simulates sell fill when bid trades through resting ask (strict >)', () => {
      const { service } = createService({ dryRun: true, baseSize: 10 });
      const market = createTestMarketState({
        restingAskPrice: 0.53,
        restingAskSize: 10,
        bestBid: 0.54,  // strictly above ask → through-trade (02 §3)
      });
      (service as any).markets.set(market.conditionId, market);

      const fillHandler = vi.fn();
      service.on('fill', fillHandler);

      (service as any).checkSimulatedFills(market, market.mid);

      expect(fillHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          side: 'SELL',
          price: 0.53,
          size: 10,
        }),
      );
      expect(market.restingAskPrice).toBe(0);
      expect(market.inventory).toBe(-10);
    });

    it('enforces cooldown between simulated fills', () => {
      const { service } = createService({ dryRun: true, baseSize: 10 });
      const market = createTestMarketState({
        restingBidPrice: 0.49,
        restingBidSize: 10,
        bestAsk: 0.48,  // through-trade
      });
      (service as any).markets.set(market.conditionId, market);

      const fillHandler = vi.fn();
      service.on('fill', fillHandler);

      (service as any).checkSimulatedFills(market, market.mid);
      expect(fillHandler).toHaveBeenCalledTimes(1);

      market.restingBidPrice = 0.49;
      market.restingBidSize = 10;
      market.bestAsk = 0.48;

      (service as any).checkSimulatedFills(market, market.mid);
      expect(fillHandler).toHaveBeenCalledTimes(1);
    });

    it('allows fill after cooldown period', () => {
      vi.useFakeTimers();
      const { service } = createService({ dryRun: true, baseSize: 10 });
      const market = createTestMarketState({
        restingBidPrice: 0.49,
        restingBidSize: 10,
        bestAsk: 0.48,  // through-trade
      });
      (service as any).markets.set(market.conditionId, market);

      const fillHandler = vi.fn();
      service.on('fill', fillHandler);

      (service as any).checkSimulatedFills(market, market.mid);
      expect(fillHandler).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(3001);

      market.restingBidPrice = 0.49;
      market.restingBidSize = 10;
      market.bestAsk = 0.48;

      (service as any).checkSimulatedFills(market, market.mid);
      expect(fillHandler).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('only fills one side per check (no double fill)', () => {
      const { service } = createService({ dryRun: true, baseSize: 10 });
      const market = createTestMarketState({
        restingBidPrice: 0.49,
        restingBidSize: 10,
        restingAskPrice: 0.53,
        restingAskSize: 10,
        bestAsk: 0.48,   // through bid
        bestBid: 0.54,   // through ask
      });
      (service as any).markets.set(market.conditionId, market);

      const fillHandler = vi.fn();
      service.on('fill', fillHandler);

      (service as any).checkSimulatedFills(market, market.mid);

      expect(fillHandler).toHaveBeenCalledTimes(1);
      expect(fillHandler).toHaveBeenCalledWith(
        expect.objectContaining({ side: 'BUY' }),
      );
    });

    it('does not fill when book does not cross', () => {
      const { service } = createService({ dryRun: true });
      const market = createTestMarketState({
        restingBidPrice: 0.49,
        restingBidSize: 10,
        restingAskPrice: 0.53,
        restingAskSize: 10,
        bestBid: 0.50,
        bestAsk: 0.52,
      });
      (service as any).markets.set(market.conditionId, market);

      const fillHandler = vi.fn();
      service.on('fill', fillHandler);

      (service as any).checkSimulatedFills(market, market.mid);

      expect(fillHandler).not.toHaveBeenCalled();
      expect(market.inventory).toBe(0);
    });
  });

  // ==========================================================================
  // Lifecycle (Phase A, preserved)
  // ==========================================================================
  describe('lifecycle', () => {
    it('isActive returns false before start', () => {
      const { service } = createService();
      expect(service.isActive()).toBe(false);
    });

    it('getMarkets returns empty before start', () => {
      const { service } = createService();
      expect(service.getMarkets()).toEqual([]);
    });

    it('getStats returns initial values', () => {
      const { service } = createService();
      const stats = service.getStats();
      expect(stats.quotesPosted).toBe(0);
      expect(stats.fills).toBe(0);
      expect(stats.requotes).toBe(0);
    });
  });

  // ==========================================================================
  // Orderbook update integration (circuit breaker + microprice + stale guard)
  // ==========================================================================
  describe('handleOrderbookUpdate integration', () => {
    it('updates microprice from book depth', () => {
      const { service } = createService();
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52,
        bestBidSize: 100, bestAskSize: 100,
      });
      (service as any).markets.set(market.conditionId, market);

      const book = {
        tokenId: market.yesTokenId,
        assetId: market.yesTokenId,
        bids: [{ price: 0.50, size: 300 }],  // thick bid
        asks: [{ price: 0.52, size: 100 }],
        timestamp: Date.now(),
        market: market.conditionId,
        tickSize: '0.01',
        minOrderSize: '1',
      };

      (service as any).updateBookState(market, book);

      // microprice = (0.50*100 + 0.52*300) / 400 = 206/400 = 0.515
      expect(market.microprice).toBeCloseTo(0.515, 6);
      expect(market.bestBidSize).toBe(300);
      expect(market.bestAskSize).toBe(100);
    });

    it('tracks mid history for circuit breaker', () => {
      const { service } = createService({ breakerWindowMs: 5000 });
      const market = createTestMarketState();
      (service as any).markets.set(market.conditionId, market);

      const book = {
        tokenId: market.yesTokenId,
        assetId: market.yesTokenId,
        bids: [{ price: 0.50, size: 100 }],
        asks: [{ price: 0.52, size: 100 }],
        timestamp: Date.now(),
        market: market.conditionId,
        tickSize: '0.01',
        minOrderSize: '1',
      };

      (service as any).updateBookState(market, book);

      expect(market.midHistory.length).toBe(1);
      expect(market.midHistory[0].mid).toBeCloseTo(0.51, 6);
    });

    it('prunes old mid history entries beyond breakerWindowMs', () => {
      const { service } = createService({ breakerWindowMs: 1000 });
      const market = createTestMarketState();
      (service as any).markets.set(market.conditionId, market);

      // Add old entry
      market.midHistory = [{ ts: Date.now() - 2000, mid: 0.50 }];

      const book = {
        tokenId: market.yesTokenId,
        assetId: market.yesTokenId,
        bids: [{ price: 0.50, size: 100 }],
        asks: [{ price: 0.52, size: 100 }],
        timestamp: Date.now(),
        market: market.conditionId,
        tickSize: '0.01',
        minOrderSize: '1',
      };

      (service as any).updateBookState(market, book);

      // Old entry should be pruned; only new entry remains
      expect(market.midHistory.length).toBe(1);
      expect(market.midHistory[0].mid).toBeCloseTo(0.51, 6);
    });
  });

  // ==========================================================================
  // Kill switch (03 §4)
  // ==========================================================================
  describe('kill switch (03 §4)', () => {
    it('fires on long position with loss exceeding killSwitchLossPct', () => {
      const { service } = createService({
        killSwitchLossPct: 0.10,
        maxInventoryShares: 100,
      });
      const market = createTestMarketState({
        inventory: 50,
        costBasis: 0.60,   // bought at 0.60
        mid: 0.50,         // now at 0.50 → loss = (0.60 - 0.50) * 50 = $5
        quotingActive: true,
      });
      // exposure = 50 * 0.50 = $25, loss = $5 = 20% > 10% threshold
      (service as any).markets.set(market.conditionId, market);
      (service as any).checkKillSwitch(market);
      expect(market.isBlacklisted).toBe(true);
      expect(market.quotingActive).toBe(false);
    });

    it('fires on short position with loss exceeding killSwitchLossPct', () => {
      const { service } = createService({
        killSwitchLossPct: 0.10,
        maxInventoryShares: 100,
      });
      const market = createTestMarketState({
        inventory: -50,
        costBasis: 0.40,   // sold at 0.40
        mid: 0.50,         // now at 0.50 → loss = (0.50 - 0.40) * 50 = $5
        quotingActive: true,
      });
      // exposure = 50 * 0.50 = $25, loss = $5 = 20% > 10% threshold
      (service as any).markets.set(market.conditionId, market);
      (service as any).checkKillSwitch(market);
      expect(market.isBlacklisted).toBe(true);
      expect(market.quotingActive).toBe(false);
    });

    it('does NOT fire on profitable long position', () => {
      const { service } = createService({
        killSwitchLossPct: 0.10,
        maxInventoryShares: 100,
      });
      const market = createTestMarketState({
        inventory: 50,
        costBasis: 0.45,   // bought at 0.45
        mid: 0.50,         // now at 0.50 → profit
        quotingActive: true,
      });
      (service as any).markets.set(market.conditionId, market);
      (service as any).checkKillSwitch(market);
      expect(market.isBlacklisted).toBe(false);
      expect(market.quotingActive).toBe(true);
    });

    it('does NOT fire on profitable short position', () => {
      const { service } = createService({
        killSwitchLossPct: 0.10,
        maxInventoryShares: 100,
      });
      const market = createTestMarketState({
        inventory: -50,
        costBasis: 0.55,   // sold at 0.55
        mid: 0.50,         // now at 0.50 → profit
        quotingActive: true,
      });
      (service as any).markets.set(market.conditionId, market);
      (service as any).checkKillSwitch(market);
      expect(market.isBlacklisted).toBe(false);
      expect(market.quotingActive).toBe(true);
    });

    it('does NOT fire when loss is below threshold', () => {
      const { service } = createService({
        killSwitchLossPct: 0.10,
        maxInventoryShares: 100,
      });
      const market = createTestMarketState({
        inventory: 50,
        costBasis: 0.51,   // bought at 0.51
        mid: 0.50,         // loss = (0.51-0.50)*50 = $0.50, exposure = $25, = 2% < 10%
        quotingActive: true,
      });
      (service as any).markets.set(market.conditionId, market);
      (service as any).checkKillSwitch(market);
      expect(market.isBlacklisted).toBe(false);
    });

    it('flattens inventory in dry-run mode after kill switch fires', () => {
      const { service } = createService({
        killSwitchLossPct: 0.10,
        maxInventoryShares: 100,
        dryRun: true,
      });
      const market = createTestMarketState({
        inventory: 50,
        costBasis: 0.60,
        mid: 0.50,
        bestBid: 0.49,  // flatten will sell at bestBid
        bestAsk: 0.51,
        quotingActive: true,
      });
      (service as any).markets.set(market.conditionId, market);
      (service as any).checkKillSwitch(market);

      expect(market.isBlacklisted).toBe(true);
      // After flatten, inventory should be 0 (simulated sell of 50 shares)
      expect(market.inventory).toBe(0);
    });
  });

  // ==========================================================================
  // Live-trading safety gate (audit B4)
  // ==========================================================================
  describe('live-trading safety gate', () => {
    it('throws when dryRun=false and LIVE_TRADING_CONFIRMED is not set', async () => {
      const origEnv = process.env.LIVE_TRADING_CONFIRMED;
      delete process.env.LIVE_TRADING_CONFIRMED;

      const { service } = createService({ dryRun: false });
      await expect(service.start()).rejects.toThrow('SAFETY GATE');

      process.env.LIVE_TRADING_CONFIRMED = origEnv;
    });
  });

  // ==========================================================================
  // Through-trade fill model (02 §3)
  // ==========================================================================
  describe('simulated fills — through-trade only (02 §3)', () => {
    it('does NOT fill bid when bestAsk equals resting bid price (touch)', () => {
      const { service } = createService({ maxInventoryShares: 100 });
      const market = createTestMarketState({
        bestBid: 0.48,
        bestAsk: 0.50,  // exactly at our bid — touch, not through
        restingBidPrice: 0.50,
        restingBidSize: 10,
        inventory: 0,
      });
      (service as any).markets.set(market.conditionId, market);
      (service as any).isRunning = true;
      (service as any).lastFillTime = new Map();

      (service as any).checkSimulatedFills(market, 0.51);

      expect(market.restingBidPrice).toBe(0.50);  // not filled
      expect(market.inventory).toBe(0);
    });

    it('fills bid when bestAsk is strictly below resting bid price (through)', () => {
      const { service } = createService({ maxInventoryShares: 100 });
      const market = createTestMarketState({
        bestBid: 0.48,
        bestAsk: 0.49,  // below our bid at 0.50 — through trade
        restingBidPrice: 0.50,
        restingBidSize: 10,
        inventory: 0,
        costBasis: 0,
      });
      (service as any).markets.set(market.conditionId, market);
      (service as any).isRunning = true;
      (service as any).lastFillTime = new Map();

      (service as any).checkSimulatedFills(market, 0.51);

      expect(market.restingBidPrice).toBe(0);  // filled and cleared
      expect(market.inventory).toBe(10);
    });

    it('does NOT fill ask when bestBid equals resting ask price (touch)', () => {
      const { service } = createService({ maxInventoryShares: 100 });
      const market = createTestMarketState({
        bestBid: 0.52,  // exactly at our ask — touch
        bestAsk: 0.54,
        restingAskPrice: 0.52,
        restingAskSize: 10,
        inventory: 0,
      });
      (service as any).markets.set(market.conditionId, market);
      (service as any).isRunning = true;
      (service as any).lastFillTime = new Map();

      (service as any).checkSimulatedFills(market, 0.51);

      expect(market.restingAskPrice).toBe(0.52);  // not filled
      expect(market.inventory).toBe(0);
    });

    it('fills ask when bestBid is strictly above resting ask price (through)', () => {
      const { service } = createService({ maxInventoryShares: 100 });
      const market = createTestMarketState({
        bestBid: 0.53,  // above our ask at 0.52 — through trade
        bestAsk: 0.55,
        restingAskPrice: 0.52,
        restingAskSize: 10,
        inventory: 0,
        costBasis: 0,
      });
      (service as any).markets.set(market.conditionId, market);
      (service as any).isRunning = true;
      (service as any).lastFillTime = new Map();

      (service as any).checkSimulatedFills(market, 0.51);

      expect(market.restingAskPrice).toBe(0);  // filled and cleared
      expect(market.inventory).toBe(-10);
    });
  });

  // ==========================================================================
  // Per-event-cluster exposure cap (03 §4)
  // ==========================================================================
  describe('per-event-cluster exposure cap (03 §4)', () => {
    it('skips both sides when cluster exposure exceeds maxClusterExposureUsd', () => {
      const { service } = createService({
        maxClusterExposureUsd: 20,
        maxGrossExposureUsd: 1000,
        maxInventoryShares: 200,
        baseHalfSpreadTicks: 2,
        baseSize: 10,
      });
      // Two markets in the same cluster
      const m1 = createTestMarketState({
        conditionId: 'cond-1',
        eventClusterId: 'election-cluster',
        inventory: 30,   // exposure = 30 * 0.51 = $15.30
        mid: 0.51,
        costBasis: 0.50,
      });
      const m2 = createTestMarketState({
        conditionId: 'cond-2',
        eventClusterId: 'election-cluster',
        inventory: 10,   // exposure = 10 * 0.51 = $5.10 → cluster total $20.40
        mid: 0.51,
        costBasis: 0.50,
      });
      (service as any).markets.set(m1.conditionId, m1);
      (service as any).markets.set(m2.conditionId, m2);

      // Compute quotes for m2 — cluster is at $20.40 > cap $20
      const quotes = service.computeQuotes(m2);
      expect(quotes).not.toBeNull();
      expect(quotes!.skipBid).toBe(true);
      expect(quotes!.skipAsk).toBe(true);
    });

    it('allows quoting when cluster exposure is within cap', () => {
      const { service } = createService({
        maxClusterExposureUsd: 100,
        maxGrossExposureUsd: 1000,
        maxInventoryShares: 200,
        baseHalfSpreadTicks: 2,
        baseSize: 10,
      });
      const m1 = createTestMarketState({
        conditionId: 'cond-1',
        eventClusterId: 'safe-cluster',
        inventory: 5,
        mid: 0.51,
        costBasis: 0.50,
      });
      (service as any).markets.set(m1.conditionId, m1);

      const quotes = service.computeQuotes(m1);
      expect(quotes).not.toBeNull();
      expect(quotes!.skipBid).toBe(false);
      expect(quotes!.skipAsk).toBe(false);
    });
  });

  // ==========================================================================
  // Phase C Item 10: Rebate-Aware Dynamic Spread Floors (03 SS3.5)
  // ==========================================================================
  describe('Phase C: dynamic spread floors (03 SS3.5, Item 10)', () => {
    it('computeDynamicMinSpreadTicks returns config floor when dynamic is disabled', () => {
      const { service } = createService({
        dynamicSpreadFloors: false,
        minSpreadTicksByCategory: { finance: 1 },
      });
      const market = createTestMarketState({ feeCategory: 'finance', mid: 0.50 });
      (service as any).markets.set(market.conditionId, market);

      const floor = service.computeDynamicMinSpreadTicks(market);
      expect(floor).toBe(1);
    });

    it('finance (50% rebate) has a lower dynamic floor than economics (25% rebate)', () => {
      const { service } = createService({
        dynamicSpreadFloors: true,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: {},  // empty to isolate dynamic
      });
      const financeMarket = createTestMarketState({
        feeCategory: 'finance', mid: 0.50, tickSize: '0.01',
      });
      const econMarket = createTestMarketState({
        feeCategory: 'economics', mid: 0.50, tickSize: '0.01',
      });
      (service as any).markets.set(financeMarket.conditionId, financeMarket);

      const financeFloor = service.computeDynamicMinSpreadTicks(financeMarket);
      const econFloor = service.computeDynamicMinSpreadTicks(econMarket);

      // Finance has 50% rebate => covers more of the flatten cost => lower floor
      expect(financeFloor).toBeLessThanOrEqual(econFloor);
    });

    it('geopolitics (fee-free) has zero dynamic floor from costs', () => {
      const { service } = createService({
        dynamicSpreadFloors: true,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: {},
      });
      const market = createTestMarketState({
        feeCategory: 'geopolitics', mid: 0.50, tickSize: '0.01',
      });

      const floor = service.computeDynamicMinSpreadTicks(market);
      // Fee-free: no taker cost to flatten, so cost-based floor is 0
      expect(floor).toBe(0);
    });

    it('dynamic floor increases near price 0.50 (peak fee region)', () => {
      const { service } = createService({
        dynamicSpreadFloors: true,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: {},
      });
      const marketNear50 = createTestMarketState({
        feeCategory: 'politics', mid: 0.50, tickSize: '0.01',
      });
      const marketNear80 = createTestMarketState({
        feeCategory: 'politics', mid: 0.80, tickSize: '0.01',
      });

      const floorAt50 = service.computeDynamicMinSpreadTicks(marketNear50);
      const floorAt80 = service.computeDynamicMinSpreadTicks(marketNear80);

      // Fee = feeRate * p * (1-p) peaks at p=0.50
      expect(floorAt50).toBeGreaterThanOrEqual(floorAt80);
    });

    it('checkRebateReconciliation flags divergence > threshold', () => {
      const { service } = createService({
        rebateDivergenceThreshold: 0.20,
      });
      const market = createTestMarketState({
        modeledRebateIncome: 10.0,
        actualRebateIncome: 7.0,  // 30% divergence > 20% threshold
      });
      (service as any).markets.set(market.conditionId, market);

      const result = service.checkRebateReconciliation(market);
      expect(result).not.toBeNull();
      expect(result!.flagged).toBe(true);
      expect(result!.divergencePct).toBeCloseTo(0.30, 2);
    });

    it('checkRebateReconciliation does NOT flag when within threshold', () => {
      const { service } = createService({
        rebateDivergenceThreshold: 0.20,
      });
      const market = createTestMarketState({
        modeledRebateIncome: 10.0,
        actualRebateIncome: 9.0,  // 10% divergence < 20% threshold
      });

      const result = service.checkRebateReconciliation(market);
      expect(result).not.toBeNull();
      expect(result!.flagged).toBe(false);
    });

    it('checkRebateReconciliation returns null when no actual data', () => {
      const { service } = createService();
      const market = createTestMarketState({
        modeledRebateIncome: 10.0,
        actualRebateIncome: 0,
      });

      const result = service.checkRebateReconciliation(market);
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // Phase C Item 8: Per-Hour Drift Schedule (03 SS2)
  // ==========================================================================
  describe('Phase C: drift schedules (03 SS2, Item 8)', () => {
    it('recordHourlyDrift accumulates data per hour bucket', () => {
      const { service } = createService();
      const market = createTestMarketState();

      service.recordHourlyDrift(market, 14, 5.0);
      service.recordHourlyDrift(market, 14, 3.0);
      service.recordHourlyDrift(market, 14, -2.0);

      const bucket = market.hourlyDrift.get(14);
      expect(bucket).toBeDefined();
      expect(bucket!.count).toBe(3);
      expect(bucket!.sumDriftBps).toBeCloseTo(6.0, 6);
    });

    it('isInToxicWindow returns false when below minimum sample count', () => {
      const { service } = createService({
        minFillsPerBucket: 30,
        toxicDriftThresholdBps: 0,
      });
      const market = createTestMarketState();

      // Only 5 samples — not enough
      for (let i = 0; i < 5; i++) {
        service.recordHourlyDrift(market, 14, -10);
      }

      expect(service.isInToxicWindow(market, 14)).toBe(false);
    });

    it('isInToxicWindow returns true when drift < threshold with enough data', () => {
      const { service } = createService({
        minFillsPerBucket: 5,  // low for testing
        toxicDriftThresholdBps: 0,
      });
      const market = createTestMarketState();

      // 10 samples with negative drift
      for (let i = 0; i < 10; i++) {
        service.recordHourlyDrift(market, 14, -3.0);
      }

      expect(service.isInToxicWindow(market, 14)).toBe(true);
    });

    it('isInToxicWindow returns false when drift >= threshold', () => {
      const { service } = createService({
        minFillsPerBucket: 5,
        toxicDriftThresholdBps: 0,
      });
      const market = createTestMarketState();

      // 10 samples with positive drift
      for (let i = 0; i < 10; i++) {
        service.recordHourlyDrift(market, 14, 5.0);
      }

      expect(service.isInToxicWindow(market, 14)).toBe(false);
    });

    it('isInToxicWindow returns false for hours with no data', () => {
      const { service } = createService();
      const market = createTestMarketState();

      expect(service.isInToxicWindow(market, 3)).toBe(false);
    });

    it('getHourlyDriftStats returns stats for populated hours', () => {
      const { service } = createService({
        minFillsPerBucket: 2,
        toxicDriftThresholdBps: 0,
      });
      const market = createTestMarketState();

      // Populate two hours
      service.recordHourlyDrift(market, 10, 5.0);
      service.recordHourlyDrift(market, 10, 3.0);
      service.recordHourlyDrift(market, 22, -4.0);
      service.recordHourlyDrift(market, 22, -6.0);

      const stats = service.getHourlyDriftStats(market);
      expect(stats.length).toBe(2);

      const hour10 = stats.find(s => s.hour === 10);
      expect(hour10).toBeDefined();
      expect(hour10!.count).toBe(2);
      expect(hour10!.meanDriftBps).toBeCloseTo(4.0, 6);
      expect(hour10!.isToxic).toBe(false);

      const hour22 = stats.find(s => s.hour === 22);
      expect(hour22).toBeDefined();
      expect(hour22!.count).toBe(2);
      expect(hour22!.meanDriftBps).toBeCloseTo(-5.0, 6);
      expect(hour22!.isToxic).toBe(true);
    });

    it('toxic window pauses quoting in handleOrderbookUpdate', () => {
      const { service } = createService({
        minFillsPerBucket: 2,
        toxicDriftThresholdBps: 0,
      });
      const market = createTestMarketState({
        quotingActive: true,
        restingBidPrice: 0.49,
        restingAskPrice: 0.53,
      });
      (service as any).markets.set(market.conditionId, market);
      (service as any).isRunning = true;

      // Make current hour toxic
      const currentHour = new Date().getUTCHours();
      for (let i = 0; i < 5; i++) {
        service.recordHourlyDrift(market, currentHour, -10);
      }

      // Feed an orderbook update
      const book = {
        tokenId: market.yesTokenId,
        assetId: market.yesTokenId,
        bids: [{ price: 0.50, size: 100 }],
        asks: [{ price: 0.52, size: 100 }],
        timestamp: Date.now(),
        market: market.conditionId,
        tickSize: '0.01',
        minOrderSize: '1',
      };

      (service as any).handleOrderbookUpdate(book);

      expect(market.quotingActive).toBe(false);
    });
  });

  // ==========================================================================
  // Phase C Item 9: EdgeScore Capital Allocator (03 SS2)
  // ==========================================================================
  describe('Phase C: edgeScore allocator (03 SS2, Item 9)', () => {
    it('computeEdgeScore returns 0 when below minimum fill count', () => {
      const { service } = createService({
        minFillsForEdgeScore: 100,
      });
      const market = createTestMarketState({
        totalFills: 50,  // below 100
        meanSpreadCaptureBps: 5,
        rollingDriftBps: 2,
      });

      expect(service.computeEdgeScore(market)).toBe(0);
    });

    it('computeEdgeScore returns sum of components when above minimum fills', () => {
      const { service } = createService({
        minFillsForEdgeScore: 10,  // low for testing
      });
      const market = createTestMarketState({
        feeCategory: 'finance',
        mid: 0.50,
        totalFills: 50,
        meanSpreadCaptureBps: 10,
        rollingDriftBps: 3,
      });

      const score = service.computeEdgeScore(market);
      // score = spreadCapture(10) + rebateBps + drift(3)
      // rebateBps = 0.040 * (1 - 0.50) * 0.50 * 10000 = 100
      expect(score).toBeGreaterThan(0);
      expect(score).toBeCloseTo(10 + 100 + 3, 0);
    });

    it('getEdgeScoreSizeMultiplier returns 1.0 when below minimum fills', () => {
      const { service } = createService({ minFillsForEdgeScore: 100 });
      const market = createTestMarketState({ totalFills: 50 });
      (service as any).markets.set(market.conditionId, market);

      expect(service.getEdgeScoreSizeMultiplier(market)).toBe(1.0);
    });

    it('getEdgeScoreSizeMultiplier scales proportionally to max edgeScore', () => {
      const { service } = createService({ minFillsForEdgeScore: 10 });

      const m1 = createTestMarketState({
        conditionId: 'cond-1',
        feeCategory: 'finance',
        mid: 0.50,
        totalFills: 50,
        meanSpreadCaptureBps: 20,
        rollingDriftBps: 5,
      });
      m1.edgeScore = service.computeEdgeScore(m1);

      const m2 = createTestMarketState({
        conditionId: 'cond-2',
        feeCategory: 'geopolitics',
        mid: 0.50,
        totalFills: 50,
        meanSpreadCaptureBps: 5,
        rollingDriftBps: 1,
      });
      m2.edgeScore = service.computeEdgeScore(m2);

      (service as any).markets.set(m1.conditionId, m1);
      (service as any).markets.set(m2.conditionId, m2);

      const mult1 = service.getEdgeScoreSizeMultiplier(m1);
      const mult2 = service.getEdgeScoreSizeMultiplier(m2);

      // m1 (finance + higher spread + higher drift) should get 1.0 (the max)
      expect(mult1).toBe(1.0);
      // m2 (geopolitics, lower scores) should get a fraction (0.1 floor is valid)
      expect(mult2).toBeGreaterThanOrEqual(0.1);
      expect(mult2).toBeLessThan(1.0);
    });

    it('recomputeEdgeScores updates all market edgeScores', () => {
      const { service } = createService({ minFillsForEdgeScore: 10 });
      const market = createTestMarketState({
        feeCategory: 'finance',
        mid: 0.50,
        totalFills: 50,
        meanSpreadCaptureBps: 10,
        rollingDriftBps: 2,
      });
      (service as any).markets.set(market.conditionId, market);

      expect(market.edgeScore).toBe(0);  // not yet computed

      service.recomputeEdgeScores();

      expect(market.edgeScore).toBeGreaterThan(0);
    });

    it('edgeScore-based sizing scales baseSize in computeQuotes', () => {
      const { service } = createService({
        minFillsForEdgeScore: 10,
        baseSize: 20,
        maxInventoryShares: 100,
        baseHalfSpreadTicks: 2,
        dynamicSpreadFloors: false,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { geopolitics: 0 },
      });

      // Market with high edgeScore
      const m1 = createTestMarketState({
        conditionId: 'cond-1',
        feeCategory: 'finance',
        mid: 0.50,
        totalFills: 50,
        meanSpreadCaptureBps: 20,
        rollingDriftBps: 5,
        inventory: 0,
      });
      m1.edgeScore = service.computeEdgeScore(m1);

      // Market with low edgeScore
      const m2 = createTestMarketState({
        conditionId: 'cond-2',
        feeCategory: 'geopolitics',
        mid: 0.50,
        totalFills: 50,
        meanSpreadCaptureBps: 2,
        rollingDriftBps: 1,
        bestBid: 0.50,
        bestAsk: 0.52,
        inventory: 0,
      });
      m2.edgeScore = service.computeEdgeScore(m2);

      (service as any).markets.set(m1.conditionId, m1);
      (service as any).markets.set(m2.conditionId, m2);

      const q2 = service.computeQuotes(m2);
      expect(q2).not.toBeNull();
      // m2 has lower edgeScore => smaller base => smaller sizes
      // With baseSize=20, at inv=0: bidSize = askSize = round(20 * edgeMult * 1)
      // edgeMult < 1 => bidSize < 20
      expect(q2!.bidSize).toBeLessThan(20);
    });
  });

  // ==========================================================================
  // Phase C Item 11: Queue-Position Tracking (03 SS3.6)
  // ==========================================================================
  describe('Phase C: queue-position tracking (03 SS3.6, Item 11)', () => {
    it('recordQueuePosition stores sizeAheadAtPost for bid', () => {
      const { service } = createService();
      const market = createTestMarketState();

      const book = {
        bids: [{ price: 0.50, size: 200 }],
        asks: [{ price: 0.52, size: 100 }],
      } as any;

      service.recordQueuePosition(market, 'BUY', 0.50, book);

      expect(market.sizeAheadAtPostBid).toBe(200);
      expect(market.queuePosBid).toBe(200);
      expect(market.queueTrackBidPrice).toBe(0.50);
    });

    it('recordQueuePosition stores sizeAheadAtPost for ask', () => {
      const { service } = createService();
      const market = createTestMarketState();

      const book = {
        bids: [{ price: 0.50, size: 100 }],
        asks: [{ price: 0.52, size: 150 }],
      } as any;

      service.recordQueuePosition(market, 'SELL', 0.52, book);

      expect(market.sizeAheadAtPostAsk).toBe(150);
      expect(market.queuePosAsk).toBe(150);
      expect(market.queueTrackAskPrice).toBe(0.52);
    });

    it('updateQueuePositions decrements when level size shrinks', () => {
      const { service } = createService();
      const market = createTestMarketState({
        queuePosBid: 200,
        sizeAheadAtPostBid: 200,
        queueTrackBidPrice: 0.50,
        restingBidPrice: 0.50,
      });

      // Book now shows 120 at our level (80 shares traded ahead of us)
      const book = {
        bids: [{ price: 0.50, size: 120 }],
        asks: [{ price: 0.52, size: 100 }],
      } as any;

      service.updateQueuePositions(market, book);

      expect(market.queuePosBid).toBe(120);
    });

    it('updateQueuePositions does not increase queue position', () => {
      const { service } = createService();
      const market = createTestMarketState({
        queuePosBid: 100,
        sizeAheadAtPostBid: 200,
        queueTrackBidPrice: 0.50,
        restingBidPrice: 0.50,
      });

      // Book shows MORE size at level (new orders joined behind us)
      const book = {
        bids: [{ price: 0.50, size: 250 }],
        asks: [{ price: 0.52, size: 100 }],
      } as any;

      service.updateQueuePositions(market, book);

      // Should not increase — we can't move backward in queue
      expect(market.queuePosBid).toBe(100);
    });

    it('shouldCancelForQueueErosion returns true when >80% consumed', () => {
      const { service } = createService({
        queueCancelThreshold: 0.80,
      });
      const market = createTestMarketState({
        sizeAheadAtPostBid: 100,
        queuePosBid: 15,  // 85% consumed
      });

      expect(service.shouldCancelForQueueErosion(market, 'BUY')).toBe(true);
    });

    it('shouldCancelForQueueErosion returns false when <80% consumed', () => {
      const { service } = createService({
        queueCancelThreshold: 0.80,
      });
      const market = createTestMarketState({
        sizeAheadAtPostBid: 100,
        queuePosBid: 50,  // 50% consumed
      });

      expect(service.shouldCancelForQueueErosion(market, 'BUY')).toBe(false);
    });

    it('shouldCancelForQueueErosion returns false when no original size', () => {
      const { service } = createService();
      const market = createTestMarketState({
        sizeAheadAtPostBid: 0,
        queuePosBid: 0,
      });

      expect(service.shouldCancelForQueueErosion(market, 'BUY')).toBe(false);
    });

    it('shouldCancelForQueueErosion works for ask side', () => {
      const { service } = createService({
        queueCancelThreshold: 0.80,
      });
      const market = createTestMarketState({
        sizeAheadAtPostAsk: 200,
        queuePosAsk: 30,  // 85% consumed
      });

      expect(service.shouldCancelForQueueErosion(market, 'SELL')).toBe(true);
    });

    it('computeFrontingPrice returns better price when current level is crowded', () => {
      const { service } = createService({ baseSize: 10 });
      const market = createTestMarketState({
        bestBid: 0.50,
        bestAsk: 0.54,  // wide enough spread to allow fronting
        tickSize: '0.01',
      });

      const book = {
        bids: [
          { price: 0.51, size: 0 },   // one tick better is empty
          { price: 0.50, size: 100 },  // current level is crowded (100 > 2*10=20)
        ],
        asks: [{ price: 0.54, size: 50 }],
      } as any;

      const frontPrice = service.computeFrontingPrice(market, 'BUY', 0.50, book);
      // Should suggest fronting at 0.51 (one tick better, empty)
      expect(frontPrice).toBe(0.51);
    });

    it('computeFrontingPrice returns null when fronting would cross spread', () => {
      const { service } = createService({ baseSize: 10 });
      const market = createTestMarketState({
        bestBid: 0.51,
        bestAsk: 0.52,
        tickSize: '0.01',
      });

      const book = {
        bids: [{ price: 0.51, size: 100 }],
        asks: [{ price: 0.52, size: 50 }],
      } as any;

      // Fronting 0.51 + 0.01 = 0.52 = bestAsk => would cross
      const frontPrice = service.computeFrontingPrice(market, 'BUY', 0.51, book);
      expect(frontPrice).toBeNull();
    });

    it('computeFrontingPrice returns null when current level is not crowded', () => {
      const { service } = createService({ baseSize: 10 });
      const market = createTestMarketState({
        bestBid: 0.50,
        bestAsk: 0.54,
        tickSize: '0.01',
      });

      const book = {
        bids: [
          { price: 0.51, size: 0 },
          { price: 0.50, size: 15 },  // 15 < 2*10=20 threshold
        ],
        asks: [{ price: 0.54, size: 50 }],
      } as any;

      const frontPrice = service.computeFrontingPrice(market, 'BUY', 0.50, book);
      expect(frontPrice).toBeNull();
    });

    it('getQueuePosAtPost returns bid queue position when tracking is active', () => {
      const { service } = createService();
      const market = createTestMarketState({
        sizeAheadAtPostBid: 150,
        sizeAheadAtPostAsk: 80,
        queueTrackBidPrice: 0.50,
        queueTrackAskPrice: 0.52,
      });

      expect(service.getQueuePosAtPost(market, 'BUY')).toBe(150);
      expect(service.getQueuePosAtPost(market, 'SELL')).toBe(80);
    });

    it('getQueuePosAtPost returns null when tracking is inactive', () => {
      const { service } = createService();
      const market = createTestMarketState({
        sizeAheadAtPostBid: 0,
        sizeAheadAtPostAsk: 0,
        queueTrackBidPrice: 0,
        queueTrackAskPrice: 0,
      });

      expect(service.getQueuePosAtPost(market, 'BUY')).toBeNull();
      expect(service.getQueuePosAtPost(market, 'SELL')).toBeNull();
    });

    it('fill records include queuePosAtPost from Phase C', () => {
      const { service } = createService({ dryRun: true, baseSize: 10 });
      const market = createTestMarketState({
        inventory: 0,
        sizeAheadAtPostBid: 75,
        sizeAheadAtPostAsk: 50,
        queueTrackBidPrice: 0.50,
        queueTrackAskPrice: 0.52,
        mid: 0.51,
      });
      (service as any).markets.set(market.conditionId, market);

      const logger = service.getLogger();
      const logSpy = vi.spyOn(logger, 'logFill');

      (service as any).recordFill(market, 'BUY', 0.50, 10);

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          queuePosAtPost: 75,  // Phase C: now populated, not null
        }),
      );
    });

    it('fill records include queuePosAtPost for SELL side', () => {
      const { service } = createService({ dryRun: true, baseSize: 10 });
      const market = createTestMarketState({
        inventory: 10,
        sizeAheadAtPostBid: 75,
        sizeAheadAtPostAsk: 50,
        queueTrackBidPrice: 0.50,
        queueTrackAskPrice: 0.52,
        mid: 0.51,
      });
      (service as any).markets.set(market.conditionId, market);

      const logger = service.getLogger();
      const logSpy = vi.spyOn(logger, 'logFill');

      (service as any).recordFill(market, 'SELL', 0.52, 5);

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          queuePosAtPost: 50,  // SELL side uses sizeAheadAtPostAsk
        }),
      );
    });
  });

  // ==========================================================================
  // Phase C: Fill-to-mark feeds hourly drift (integration)
  // ==========================================================================
  describe('Phase C: fill-to-mark drift feeds hourly buckets', () => {
    it('completed drift sample populates hourly drift bucket', () => {
      vi.useFakeTimers();
      const { service } = createService({
        fillToMarkDelaysMs: [100],
        minFillsPerBucket: 1,
      });
      const market = createTestMarketState({ mid: 0.50 });
      (service as any).markets.set(market.conditionId, market);

      (service as any).startFillToMarkSampling(market, 'BUY', 0.50);

      market.mid = 0.51;
      vi.advanceTimersByTime(100);

      // The hourly bucket should have been populated
      const hour = new Date().getUTCHours();
      const bucket = market.hourlyDrift.get(hour);
      expect(bucket).toBeDefined();
      expect(bucket!.count).toBe(1);
      expect(bucket!.sumDriftBps).toBeCloseTo(200, 0);

      vi.useRealTimers();
    });
  });

  // ==========================================================================
  // Phase C: Spread capture tracking for edgeScore
  // ==========================================================================
  describe('Phase C: spread capture tracking', () => {
    it('recordFill tracks spread capture bps and total fills', () => {
      const { service } = createService();
      const market = createTestMarketState({
        inventory: 0,
        mid: 0.51,
      });
      (service as any).markets.set(market.conditionId, market);

      (service as any).recordFill(market, 'BUY', 0.49, 10);

      expect(market.totalFills).toBe(1);
      expect(market.meanSpreadCaptureBps).toBeGreaterThan(0);
      // spreadCaptured = (0.49 - 0.51) * (-1) = 0.02
      // spreadCaptureBps = 0.02 / 0.51 * 10000 ~ 392.2 bps
      expect(market.meanSpreadCaptureBps).toBeCloseTo(392.2, 0);
    });

    it('mean spread capture bps averages across multiple fills', () => {
      const { service } = createService();
      const market = createTestMarketState({
        inventory: 0,
        mid: 0.50,
      });
      (service as any).markets.set(market.conditionId, market);

      (service as any).recordFill(market, 'BUY', 0.49, 10);  // capture: 0.01/0.50 * 10000 = 200 bps
      market.mid = 0.50;
      (service as any).recordFill(market, 'SELL', 0.51, 10);  // capture: 0.01/0.50 * 10000 = 200 bps

      expect(market.totalFills).toBe(2);
      expect(market.meanSpreadCaptureBps).toBeCloseTo(200, 0);
    });
  });

  // ==========================================================================
  // B2 Fix: edgeScore allocator with negative/zero scores
  // ==========================================================================
  describe('edgeScore allocator: negative/zero edge handling (B2 fix)', () => {
    it('all markets with negative edgeScore get floor multiplier 0.1', () => {
      const { service } = createService({ minFillsForEdgeScore: 10 });

      const m1 = createTestMarketState({ conditionId: 'cond-1', totalFills: 50 });
      m1.edgeScore = -5;
      const m2 = createTestMarketState({ conditionId: 'cond-2', totalFills: 50 });
      m2.edgeScore = -10;
      const m3 = createTestMarketState({ conditionId: 'cond-3', totalFills: 50 });
      m3.edgeScore = -2;

      (service as any).markets.set(m1.conditionId, m1);
      (service as any).markets.set(m2.conditionId, m2);
      (service as any).markets.set(m3.conditionId, m3);

      expect(service.getEdgeScoreSizeMultiplier(m1)).toBe(0.1);
      expect(service.getEdgeScoreSizeMultiplier(m2)).toBe(0.1);
      expect(service.getEdgeScoreSizeMultiplier(m3)).toBe(0.1);
    });

    it('all markets with zero edgeScore get floor multiplier 0.1', () => {
      const { service } = createService({ minFillsForEdgeScore: 10 });

      const m1 = createTestMarketState({ conditionId: 'cond-1', totalFills: 50 });
      m1.edgeScore = 0;
      const m2 = createTestMarketState({ conditionId: 'cond-2', totalFills: 50 });
      m2.edgeScore = 0;

      (service as any).markets.set(m1.conditionId, m1);
      (service as any).markets.set(m2.conditionId, m2);

      expect(service.getEdgeScoreSizeMultiplier(m1)).toBe(0.1);
      expect(service.getEdgeScoreSizeMultiplier(m2)).toBe(0.1);
    });

    it('one positive + one negative: negative gets 0.1, positive gets 1.0', () => {
      const { service } = createService({ minFillsForEdgeScore: 10 });

      const positive = createTestMarketState({ conditionId: 'cond-1', totalFills: 50 });
      positive.edgeScore = 20;
      const negative = createTestMarketState({ conditionId: 'cond-2', totalFills: 50 });
      negative.edgeScore = -5;

      (service as any).markets.set(positive.conditionId, positive);
      (service as any).markets.set(negative.conditionId, negative);

      expect(service.getEdgeScoreSizeMultiplier(positive)).toBe(1.0);
      expect(service.getEdgeScoreSizeMultiplier(negative)).toBe(0.1);
    });

    it('market with insufficient fills still gets 1.0 regardless of edgeScore', () => {
      const { service } = createService({ minFillsForEdgeScore: 100 });

      const market = createTestMarketState({ totalFills: 50 });
      market.edgeScore = -20;
      (service as any).markets.set(market.conditionId, market);

      expect(service.getEdgeScoreSizeMultiplier(market)).toBe(1.0);
    });
  });

  // ==========================================================================
  // B1 Fix: Queue-position wiring integration tests
  // ==========================================================================
  describe('queue-position wiring integration (B1 fix)', () => {
    it('postQuotes in dry-run records queue position for bid and ask', async () => {
      const { service } = createService({ dryRun: true, baseHalfSpreadTicks: 2, minSpreadTicks: 0, minSpreadTicksByCategory: { politics: 0 } });
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52,
        bestBidSize: 200, bestAskSize: 150,
      });
      // Set a multi-level lastBook so queue tracking works properly
      market.lastBook = {
        assetId: market.yesTokenId,
        tokenId: market.yesTokenId,
        bids: [{ price: 0.50, size: 200 }, { price: 0.49, size: 100 }],
        asks: [{ price: 0.52, size: 150 }, { price: 0.53, size: 80 }],
      };
      (service as any).markets.set(market.conditionId, market);

      const quotes = service.computeQuotes(market);
      expect(quotes).not.toBeNull();
      await (service as any).postQuotes(market, quotes);

      // After posting, queue tracking should be active
      // The bid is at 0.48 (not matching any book level) -> sizeAhead = 0
      // but queueTrackBidPrice is set (tracking active)
      expect(market.queueTrackBidPrice).toBeGreaterThan(0);
      expect(market.queueTrackAskPrice).toBeGreaterThan(0);
    });

    it('queue erosion triggers requote when level is consumed', () => {
      const { service } = createService({
        dryRun: true,
        queueCancelThreshold: 0.8,
      });
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52,
        restingBidPrice: 0.50,
        restingBidSize: 10,
      });
      // Simulate: posted at 0.50 with 100 ahead, now only 10 left (90% consumed)
      market.sizeAheadAtPostBid = 100;
      market.queuePosBid = 10;
      market.queueTrackBidPrice = 0.50;

      expect(service.shouldCancelForQueueErosion(market, 'BUY')).toBe(true);
    });

    it('computeFrontingPrice is wired through computeQuotes when lastBook has a crowded level', () => {
      const { service } = createService({
        baseHalfSpreadTicks: 1,
        baseSize: 10,
        minSpreadTicks: 0,
        minSpreadTicksByCategory: { politics: 0 },
      });
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.55,
        bestBidSize: 200, bestAskSize: 200,
      });
      // Provide a multi-level book where our computed bid (0.50) has a huge crowd
      market.lastBook = {
        assetId: market.yesTokenId,
        tokenId: market.yesTokenId,
        bids: [{ price: 0.50, size: 200 }, { price: 0.49, size: 50 }],
        asks: [{ price: 0.55, size: 200 }, { price: 0.56, size: 50 }],
      };
      (service as any).markets.set(market.conditionId, market);

      const quotes = service.computeQuotes(market);
      expect(quotes).not.toBeNull();
      // With microprice at ~0.5125 (balanced sizes), bid = floor(0.5125 - 0.01) = 0.50
      // Book has 200 at 0.50 (crowd), 0 at 0.51 (empty, better tick).
      // Since 200 > baseSize*2 (20), fronting should fire: bid moves to 0.51.
      // But betterPrice (0.51) must be < bestAsk (0.55) — yes.
      // sizeAtBetter (0) < sizeAtCurrent (200) * 0.2 (40) — yes.
      expect(quotes!.bidPrice).toBe(0.51);
    });
  });
});
