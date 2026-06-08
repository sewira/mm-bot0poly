import { describe, it, expect, vi, beforeEach } from 'vitest';
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

function createTestMarketState(overrides: Partial<MMMarketState> = {}): MMMarketState {
  return {
    conditionId: 'cond-1',
    name: 'Test Market',
    yesTokenId: 'yes-token-123',
    noTokenId: 'no-token-456',
    tickSize: '0.01',
    feeCategory: 'politics',
    bestBid: 0.50,
    bestAsk: 0.52,
    mid: 0.51,
    lastBookUpdate: Date.now(),
    inventory: 0,
    restingBidOrderId: null,
    restingBidPrice: 0,
    restingAskOrderId: null,
    restingAskPrice: 0,
    realizedSpreadPnL: 0,
    modeledRebateIncome: 0,
    inventoryMtM: 0,
    fillToMarkSamples: [],
    rollingDriftBps: 0,
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
  describe('computeQuotes', () => {
    it('computes symmetric quotes at zero inventory', () => {
      const { service } = createService({ baseHalfSpreadTicks: 2 });
      const market = createTestMarketState({ bestBid: 0.50, bestAsk: 0.52, mid: 0.51 });

      const quotes = service.computeQuotes(market);

      expect(quotes).not.toBeNull();
      // mid=0.51, inv=0, reservation=0.51
      // halfSpread = 2 * 0.01 = 0.02
      // bid = floor(0.51 - 0.02) = floor(0.49) = 0.49
      // ask = ceil(0.51 + 0.02) = ceil(0.53) = 0.53
      expect(quotes!.bidPrice).toBe(0.49);
      expect(quotes!.askPrice).toBe(0.53);
      expect(quotes!.skipBid).toBe(false);
      expect(quotes!.skipAsk).toBe(false);
    });

    it('skews quotes when inventory is positive (long)', () => {
      const { service } = createService({
        baseHalfSpreadTicks: 2,
        skewWidth: 0.02,
        maxInventoryShares: 50,
      });
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52, mid: 0.51,
        inventory: 25,  // 50% of max → inv = 0.5
      });

      const quotes = service.computeQuotes(market);

      expect(quotes).not.toBeNull();
      // reservation = 0.51 - 0.5 * 0.02 = 0.51 - 0.01 = 0.50
      // bid = floor(0.50 - 0.02) = 0.48
      // ask = ceil(0.50 + 0.02) = 0.52
      expect(quotes!.bidPrice).toBe(0.48);
      expect(quotes!.askPrice).toBe(0.52);
    });

    it('skews quotes when inventory is negative (short)', () => {
      const { service } = createService({
        baseHalfSpreadTicks: 2,
        skewWidth: 0.02,
        maxInventoryShares: 50,
      });
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52, mid: 0.51,
        inventory: -25,  // -50% of max → inv = -0.5
      });

      const quotes = service.computeQuotes(market);

      expect(quotes).not.toBeNull();
      // reservation = 0.51 - (-0.5) * 0.02 = 0.51 + 0.01 = 0.52
      // bid = floor(0.52 - 0.02) = 0.50
      // ask = ceil(0.52 + 0.02) = 0.54
      expect(quotes!.bidPrice).toBe(0.50);
      expect(quotes!.askPrice).toBe(0.54);
    });

    it('skips bid when inventory at max (one-sided cap)', () => {
      const { service } = createService({ maxInventoryShares: 50 });
      const market = createTestMarketState({ inventory: 50 });

      const quotes = service.computeQuotes(market);

      expect(quotes).not.toBeNull();
      expect(quotes!.skipBid).toBe(true);
      expect(quotes!.skipAsk).toBe(false);
    });

    it('skips ask when inventory at negative max', () => {
      const { service } = createService({ maxInventoryShares: 50 });
      const market = createTestMarketState({ inventory: -50 });

      const quotes = service.computeQuotes(market);

      expect(quotes).not.toBeNull();
      expect(quotes!.skipBid).toBe(false);
      expect(quotes!.skipAsk).toBe(true);
    });

    it('returns null when bid >= ask', () => {
      const { service } = createService({ baseHalfSpreadTicks: 0, minSpreadTicks: 0 });
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

    it('enforces minimum spread', () => {
      const { service } = createService({
        baseHalfSpreadTicks: 0,  // would produce zero spread
        minSpreadTicks: 2,
      });
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52, mid: 0.51,
      });

      const quotes = service.computeQuotes(market);

      expect(quotes).not.toBeNull();
      const spreadTicks = Math.round((quotes!.askPrice - quotes!.bidPrice) / 0.01);
      expect(spreadTicks).toBeGreaterThanOrEqual(2);
    });

    it('clamps inventory ratio to [-1, +1]', () => {
      const { service } = createService({
        maxInventoryShares: 50,
        baseHalfSpreadTicks: 2,
        skewWidth: 0.02,
      });
      // Inventory exceeds max
      const market = createTestMarketState({
        bestBid: 0.50, bestAsk: 0.52, mid: 0.51,
        inventory: 100,  // 2x max, but should clamp to +1
      });

      const quotes = service.computeQuotes(market);

      expect(quotes).not.toBeNull();
      // Clamped inv=1.0, reservation = 0.51 - 1.0 * 0.02 = 0.49
      expect(quotes!.bidPrice).toBe(0.47);
      expect(quotes!.askPrice).toBe(0.51);
      expect(quotes!.skipBid).toBe(true);  // inventory >= qMax
    });

    it('uses correct tick size for 0.001 markets', () => {
      const { service } = createService({ baseHalfSpreadTicks: 2 });
      const market = createTestMarketState({
        bestBid: 0.500, bestAsk: 0.510, mid: 0.505,
        tickSize: '0.001',
      });

      const quotes = service.computeQuotes(market);

      expect(quotes).not.toBeNull();
      // halfSpread = 2 * 0.001 = 0.002
      // bid = floor(0.505 - 0.002) = floor(0.503) = 0.503
      // ask = ceil(0.505 + 0.002) = ceil(0.507) = 0.507
      expect(quotes!.bidPrice).toBe(0.503);
      expect(quotes!.askPrice).toBe(0.507);
    });
  });

  describe('inventory tracking', () => {
    it('increases inventory on BUY fill', () => {
      const { service } = createService();
      const market = createTestMarketState({ inventory: 0 });

      // Access private method via prototype
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

      // Buy at 0.49 (below mid of 0.51) → positive spread
      (service as any).recordFill(market, 'BUY', 0.49, 10);

      // spreadCaptured = (0.49 - 0.51) * -1 = 0.02 per share
      // realizedSpreadPnL = 0.02 * 10 = 0.20
      expect(market.realizedSpreadPnL).toBeCloseTo(0.20, 4);
    });

    it('uses midOverride (prevMid) for spread PnL when provided', () => {
      const { service } = createService();
      const market = createTestMarketState({
        inventory: 0,
        mid: 0.49,  // mid already moved down (post-move)
      });

      (service as any).markets.set(market.conditionId, market);

      // Fill at 0.49 — without midOverride, spread would be 0 (price == mid)
      // With midOverride=0.51 (pre-move mid), spread = (0.49 - 0.51) * -1 = 0.02
      (service as any).recordFill(market, 'BUY', 0.49, 10, 0.51);

      expect(market.realizedSpreadPnL).toBeCloseTo(0.20, 4);
    });

    it('tracks modeled rebate income on fill', () => {
      const { service } = createService();
      const market = createTestMarketState({
        feeCategory: 'finance',  // 50% rebate
      });

      (service as any).markets.set(market.conditionId, market);
      (service as any).recordFill(market, 'BUY', 0.50, 100);

      // Taker fee on counterparty = 100 * 0.040 * 0.50 * 0.50 = 1.00
      // Rebate = 1.00 * 0.50 = 0.50
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
      // Check spreadPnL and rebateIncome are present and numeric
      const call = fillHandler.mock.calls[0][0];
      expect(call.spreadPnL).toBeCloseTo(0.20, 4);  // (0.49-0.51)*-1 * 10
      expect(typeof call.rebateIncome).toBe('number');
      expect(call.rebateIncome).toBeGreaterThanOrEqual(0);
    });
  });

  describe('fill-to-mark drift', () => {
    it('calculates positive drift for non-toxic buy (price went up)', () => {
      vi.useFakeTimers();
      const { service } = createService({ fillToMarkDelaysMs: [100] });
      const market = createTestMarketState({ mid: 0.50 });
      (service as any).markets.set(market.conditionId, market);

      (service as any).startFillToMarkSampling(market, 'BUY', 0.50);

      // Mid moved up after fill (good for buyer)
      market.mid = 0.51;
      vi.advanceTimersByTime(100);

      const sample = market.fillToMarkSamples[0];
      expect(sample.completed).toBe(true);
      // drift = (0.51 - 0.50) / 0.50 * 10000 * 1 = 200 bps
      expect(sample.driftBps[0]).toBeCloseTo(200, 0);

      vi.useRealTimers();
    });

    it('calculates negative drift for adverse buy (price went down)', () => {
      vi.useFakeTimers();
      const { service } = createService({ fillToMarkDelaysMs: [100] });
      const market = createTestMarketState({ mid: 0.50 });
      (service as any).markets.set(market.conditionId, market);

      (service as any).startFillToMarkSampling(market, 'BUY', 0.50);

      // Mid moved down after fill (bad for buyer — adverse selection)
      market.mid = 0.49;
      vi.advanceTimersByTime(100);

      const sample = market.fillToMarkSamples[0];
      expect(sample.completed).toBe(true);
      // drift = (0.49 - 0.50) / 0.50 * 10000 * 1 = -200 bps
      expect(sample.driftBps[0]).toBeCloseTo(-200, 0);

      vi.useRealTimers();
    });

    it('calculates positive drift for non-toxic sell (price went down)', () => {
      vi.useFakeTimers();
      const { service } = createService({ fillToMarkDelaysMs: [100] });
      const market = createTestMarketState({ mid: 0.50 });
      (service as any).markets.set(market.conditionId, market);

      (service as any).startFillToMarkSampling(market, 'SELL', 0.50);

      // Mid moved down after sell (good for seller)
      market.mid = 0.49;
      vi.advanceTimersByTime(100);

      const sample = market.fillToMarkSamples[0];
      // drift = (0.49 - 0.50) / 0.50 * 10000 * -1 = 200 bps (positive = good)
      expect(sample.driftBps[0]).toBeCloseTo(200, 0);

      vi.useRealTimers();
    });
  });

  describe('simulated fills (dry-run)', () => {
    it('simulates buy fill when ask crosses resting bid', () => {
      const { service } = createService({ dryRun: true, orderSize: 10 });
      const market = createTestMarketState({
        restingBidPrice: 0.49,
        bestAsk: 0.49,  // ask dropped to our bid → fill
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

    it('simulates sell fill when bid crosses resting ask', () => {
      const { service } = createService({ dryRun: true, orderSize: 10 });
      const market = createTestMarketState({
        restingAskPrice: 0.53,
        bestBid: 0.53,  // bid rose to our ask → fill
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
      const { service } = createService({ dryRun: true, orderSize: 10 });
      const market = createTestMarketState({
        restingBidPrice: 0.49,
        bestAsk: 0.49,
      });
      (service as any).markets.set(market.conditionId, market);

      const fillHandler = vi.fn();
      service.on('fill', fillHandler);

      // First fill should work
      (service as any).checkSimulatedFills(market, market.mid);
      expect(fillHandler).toHaveBeenCalledTimes(1);

      // Reset resting price (simulating a requote)
      market.restingBidPrice = 0.49;
      market.bestAsk = 0.49;

      // Second fill immediately after should be blocked by cooldown
      (service as any).checkSimulatedFills(market, market.mid);
      expect(fillHandler).toHaveBeenCalledTimes(1);  // still 1, not 2
    });

    it('allows fill after cooldown period', () => {
      vi.useFakeTimers();
      const { service } = createService({ dryRun: true, orderSize: 10 });
      const market = createTestMarketState({
        restingBidPrice: 0.49,
        bestAsk: 0.49,
      });
      (service as any).markets.set(market.conditionId, market);

      const fillHandler = vi.fn();
      service.on('fill', fillHandler);

      // First fill
      (service as any).checkSimulatedFills(market, market.mid);
      expect(fillHandler).toHaveBeenCalledTimes(1);

      // Advance time past cooldown (3s)
      vi.advanceTimersByTime(3001);

      // Reset resting price
      market.restingBidPrice = 0.49;
      market.bestAsk = 0.49;

      // Second fill should work after cooldown
      (service as any).checkSimulatedFills(market, market.mid);
      expect(fillHandler).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('only fills one side per check (no double fill)', () => {
      const { service } = createService({ dryRun: true, orderSize: 10 });
      const market = createTestMarketState({
        restingBidPrice: 0.49,
        restingAskPrice: 0.53,
        bestAsk: 0.49,   // bid crossed
        bestBid: 0.53,   // ask also crossed
      });
      (service as any).markets.set(market.conditionId, market);

      const fillHandler = vi.fn();
      service.on('fill', fillHandler);

      (service as any).checkSimulatedFills(market, market.mid);

      // Should only fill one side (bid first, since it's checked first)
      expect(fillHandler).toHaveBeenCalledTimes(1);
      expect(fillHandler).toHaveBeenCalledWith(
        expect.objectContaining({ side: 'BUY' }),
      );
    });

    it('does not fill when book does not cross', () => {
      const { service } = createService({ dryRun: true });
      const market = createTestMarketState({
        restingBidPrice: 0.49,
        restingAskPrice: 0.53,
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
});
