/**
 * Market Making Service
 *
 * Inventory-skewed quoting on low-toxicity Polymarket markets.
 * Uses Avellaneda-Stoikov simplified model with event-driven requoting.
 *
 * Edge: makers pay zero taker fees and earn rebates.
 * Selection: geopolitics (fee-free) > finance (50% rebate) > politics/sports.
 * Never crypto (highest fees, most toxic flow).
 */

import { EventEmitter } from 'events';
import { GammaApiClient, type GammaMarket } from '../clients/gamma-api.js';
import { RateLimiter } from '../core/rate-limiter.js';
import { createUnifiedCache } from '../core/unified-cache.js';
import {
  calculateTakerFee,
  categoryFromTags,
  MAKER_REBATE_SHARES,
  type FeeCategory,
} from '../utils/fee-utils.js';
import { roundPrice, type TickSize } from '../utils/price-utils.js';
import type { MarketService } from './market-service.js';
import type { TradingService } from './trading-service.js';
import type {
  RealtimeServiceV2,
  OrderbookSnapshot,
  MarketSubscription,
  Subscription,
  UserTrade,
} from './realtime-service-v2.js';

// ============================================================================
// Types
// ============================================================================

export interface MarketMakingConfig {
  // Market selection
  categories?: FeeCategory[];
  excludeCategories?: FeeCategory[];
  minVolume24h?: number;
  minDepthShares?: number;
  priceBand?: [number, number];
  minHoursToResolution?: number;

  // Quoting
  baseHalfSpreadTicks?: number;
  minSpreadTicks?: number;
  skewWidth?: number;
  orderSize?: number;

  // Inventory
  maxInventoryShares?: number;
  maxGrossExposureUsd?: number;

  // Requoting
  requoteThresholdTicks?: number;

  // Risk
  maxUnrealizedLossPct?: number;

  // Fill-to-mark
  fillToMarkDelaysMs?: number[];

  // Operational
  dryRun?: boolean;
  maxMarkets?: number;
}

export interface MMMarketState {
  conditionId: string;
  name: string;
  yesTokenId: string;
  noTokenId: string;
  tickSize: TickSize;
  feeCategory: FeeCategory;

  // Book
  bestBid: number;
  bestAsk: number;
  mid: number;
  lastBookUpdate: number;

  // Inventory (signed: + = long YES shares, - = short)
  inventory: number;

  // Our resting orders
  restingBidOrderId: string | null;
  restingBidPrice: number;
  restingAskOrderId: string | null;
  restingAskPrice: number;

  // PnL
  realizedSpreadPnL: number;
  modeledRebateIncome: number;
  inventoryMtM: number;

  // Fill-to-mark
  fillToMarkSamples: FillToMarkSample[];
  rollingDriftBps: number;

  // Status
  isBlacklisted: boolean;
  blacklistReason?: string;
  quotingActive: boolean;
}

export interface FillToMarkSample {
  fillTime: number;
  fillPrice: number;
  fillSide: 'BUY' | 'SELL';
  driftDelaysMs: number[];
  driftBps: (number | null)[];
  midAtFill: number;
  completed: boolean;
}

interface QuoteResult {
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
  skipBid: boolean;
  skipAsk: boolean;
}

// Category priority for market selection (lower index = higher priority)
const CATEGORY_PRIORITY: FeeCategory[] = [
  'geopolitics', 'finance', 'politics', 'sports', 'tech',
  'economics', 'culture', 'weather', 'mentions', 'other',
];

const MIN_ORDER_SIZE_SHARES = 5;
const MIN_ORDER_VALUE_USDC = 1;
const MIN_FILL_INTERVAL_MS = 3000; // 3s cooldown between simulated fills per market

// ============================================================================
// Service
// ============================================================================

export class MarketMakingService extends EventEmitter {
  private config: Required<MarketMakingConfig>;
  private markets: Map<string, MMMarketState> = new Map();
  private marketSubscriptions: Map<string, MarketSubscription> = new Map();
  private userSubscription: Subscription | null = null;
  private isRunning = false;
  private requotingMarkets: Set<string> = new Set();  // per-market debounce
  private fillTimers: Map<string, ReturnType<typeof setTimeout>[]> = new Map();

  private stats = {
    quotesPosted: 0,
    fills: 0,
    requotes: 0,
    marketsQuoted: 0,
    startTime: 0,
  };

  constructor(
    private tradingService: TradingService,
    private marketService: MarketService,
    private realtimeService: RealtimeServiceV2,
    config: MarketMakingConfig = {},
  ) {
    super();
    this.config = {
      categories: config.categories ?? ['geopolitics', 'finance', 'politics', 'sports'],
      excludeCategories: config.excludeCategories ?? ['crypto'],
      minVolume24h: config.minVolume24h ?? 5000,
      minDepthShares: config.minDepthShares ?? 50,
      priceBand: config.priceBand ?? [0.20, 0.80],
      minHoursToResolution: config.minHoursToResolution ?? 12,
      baseHalfSpreadTicks: config.baseHalfSpreadTicks ?? 2,
      minSpreadTicks: config.minSpreadTicks ?? 1,
      skewWidth: config.skewWidth ?? 0.02,
      orderSize: config.orderSize ?? 10,
      maxInventoryShares: config.maxInventoryShares ?? 50,
      maxGrossExposureUsd: config.maxGrossExposureUsd ?? 100,
      requoteThresholdTicks: config.requoteThresholdTicks ?? 1,
      maxUnrealizedLossPct: config.maxUnrealizedLossPct ?? 0.10,
      fillToMarkDelaysMs: config.fillToMarkDelaysMs ?? [5000, 15000, 30000],
      dryRun: config.dryRun ?? true,
      maxMarkets: config.maxMarkets ?? 3,
    };
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async start(): Promise<void> {
    if (this.isRunning) throw new Error('MarketMakingService is already running');
    this.isRunning = true;
    this.stats.startTime = Date.now();

    this.log('Starting Market Making Service...');
    this.log(`Mode: ${this.config.dryRun ? 'DRY RUN (simulated)' : 'LIVE'}`);

    // 1. Select markets
    const selected = await this.selectMarkets();
    if (selected.length === 0) {
      this.log('No markets passed selection filter. Stopping.');
      this.isRunning = false;
      return;
    }

    // 2. Store market states
    for (const m of selected) {
      this.markets.set(m.conditionId, m);
      this.emit('marketSelected', { name: m.name, conditionId: m.conditionId, feeCategory: m.feeCategory });
    }
    this.stats.marketsQuoted = this.markets.size;
    this.log(`Selected ${this.markets.size} market(s) for quoting`);

    // 3. Subscribe to user fills (live mode only)
    if (!this.config.dryRun) {
      const creds = this.tradingService.getCredentials();
      if (creds) {
        this.userSubscription = this.realtimeService.subscribeUserEvents(
          creds,
          { onTrade: (trade: UserTrade) => this.handleUserFill(trade) },
        );
      }
    }

    // 4. Subscribe to orderbook data for each market
    for (const market of this.markets.values()) {
      const tokenIds = [market.yesTokenId, market.noTokenId];
      const sub = this.realtimeService.subscribeMarkets(tokenIds, {
        onOrderbook: (book: OrderbookSnapshot) => this.handleOrderbookUpdate(book),
      });
      this.marketSubscriptions.set(market.conditionId, sub);
      market.quotingActive = true;
      this.log(`Subscribed to orderbook: ${market.name} [${market.feeCategory}]`);
    }

    // 5. Re-post quotes after WS reconnection (book snapshot will come, but
    //    the "initial quote" trigger handles it via hasNoQuotes check)
    this.realtimeService.on('marketChannelConnected', () => {
      if (!this.isRunning) return;
      this.log('Market Channel reconnected — clearing resting prices to trigger fresh quotes');
      for (const market of this.markets.values()) {
        if (market.quotingActive && !market.isBlacklisted) {
          // Clear resting prices so the next book event triggers initial quote logic
          market.restingBidPrice = 0;
          market.restingAskPrice = 0;
        }
      }
    });

    this.emit('started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    this.log('Stopping Market Making Service...');

    // Cancel all resting orders
    for (const market of this.markets.values()) {
      await this.cancelMarketOrders(market);
      market.quotingActive = false;
    }

    // Unsubscribe from orderbooks
    for (const sub of this.marketSubscriptions.values()) {
      sub.unsubscribe();
    }
    this.marketSubscriptions.clear();

    // Remove reconnection listener
    this.realtimeService.removeAllListeners('marketChannelConnected');

    // Unsubscribe from user events
    if (this.userSubscription) {
      this.userSubscription.unsubscribe();
      this.userSubscription = null;
    }

    // Clear fill-to-mark timers
    for (const timers of this.fillTimers.values()) {
      timers.forEach(t => clearTimeout(t));
    }
    this.fillTimers.clear();
    this.lastFillTime.clear();

    this.logStats();
    this.emit('stopped');
  }

  isActive(): boolean {
    return this.isRunning;
  }

  getMarkets(): MMMarketState[] {
    return Array.from(this.markets.values());
  }

  getStats() {
    return { ...this.stats };
  }

  // ============================================================================
  // Market Selection
  // ============================================================================

  async selectMarkets(): Promise<MMMarketState[]> {
    const rateLimiter = new RateLimiter();
    const cache = createUnifiedCache();
    const gammaApi = new GammaApiClient(rateLimiter, cache);

    const markets = await gammaApi.getMarkets({
      active: true,
      closed: false,
      limit: 200,
    });

    this.log(`Scanning ${markets.length} active markets...`);

    const candidates: Array<{
      market: GammaMarket;
      category: FeeCategory;
      categoryPriority: number;
      yesTokenId: string;
      noTokenId: string;
      tickSize: TickSize;
      bestBid: number;
      bestAsk: number;
    }> = [];

    // Filter diagnostics
    const filterStats = {
      total: markets.length,
      notBinary: 0,
      cryptoExcluded: 0,
      lowVolume: 0,
      priceBand: 0,
      tooCloseToEnd: 0,
      clobFailed: 0,
      lowDepth: 0,
      passed: 0,
    };

    // Crypto keywords for exclusion (highest taker fees, most toxic flow)
    const CRYPTO_KEYWORDS = [
      'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol',
      'crypto', 'token', 'xrp', 'dogecoin', 'doge',
      'updown', 'up-down', 'up or down',
    ];

    for (const gm of markets) {
      try {
        // Binary markets only
        if (!gm.conditionId || gm.outcomes?.length !== 2) { filterStats.notBinary++; continue; }

        // Crypto exclusion (text-based, since Gamma API no longer returns tags)
        const questionLower = (gm.question || '').toLowerCase();
        const slugLower = (gm.slug || '').toLowerCase();
        const isCrypto = CRYPTO_KEYWORDS.some(kw => questionLower.includes(kw) || slugLower.includes(kw));
        if (isCrypto) { filterStats.cryptoExcluded++; continue; }

        // Category from tags (if available), otherwise default to 'other'
        const category = gm.tags ? categoryFromTags(gm.tags) : 'other';

        // Volume floor
        const volume24h = gm.volume24hr || 0;
        if (volume24h < this.config.minVolume24h) { filterStats.lowVolume++; continue; }

        // Price band
        const yesPrice = gm.outcomePrices?.[0] ?? 0;
        if (yesPrice < this.config.priceBand[0] || yesPrice > this.config.priceBand[1]) { filterStats.priceBand++; continue; }

        // Time-to-resolution
        const endDate = gm.endDate instanceof Date ? gm.endDate : new Date(gm.endDate);
        const hoursToEnd = (endDate.getTime() - Date.now()) / (1000 * 60 * 60);
        if (hoursToEnd < this.config.minHoursToResolution) { filterStats.tooCloseToEnd++; continue; }

        // Resolve CLOB tokens
        let clobMarket;
        try {
          clobMarket = await this.marketService.getClobMarket(gm.conditionId);
          if (!clobMarket) { filterStats.clobFailed++; continue; }
        } catch {
          filterStats.clobFailed++;
          continue;
        }

        const yesToken = clobMarket.tokens[0];
        const noToken = clobMarket.tokens[1];
        if (!yesToken || !noToken) { filterStats.clobFailed++; continue; }

        // Check book depth
        let orderbook;
        try {
          orderbook = await this.marketService.getProcessedOrderbook(gm.conditionId);
        } catch {
          filterStats.clobFailed++;
          continue;
        }

        const yesBidSize = orderbook.yes.bidSize || 0;
        const yesAskSize = orderbook.yes.askSize || 0;
        if (yesBidSize < this.config.minDepthShares || yesAskSize < this.config.minDepthShares) { filterStats.lowDepth++; continue; }

        const categoryPriority = CATEGORY_PRIORITY.indexOf(category);

        candidates.push({
          market: gm,
          category,
          categoryPriority: categoryPriority >= 0 ? categoryPriority : CATEGORY_PRIORITY.length,
          yesTokenId: yesToken.tokenId,
          noTokenId: noToken.tokenId,
          tickSize: (clobMarket.minimumTickSize || '0.01') as TickSize,
          bestBid: orderbook.yes.bid,
          bestAsk: orderbook.yes.ask,
        });
        filterStats.passed++;
      } catch {
        continue;
      }
    }

    // Log filter diagnostics
    this.log(`Filter results: ${JSON.stringify(filterStats)}`);

    // Rank: category priority first, then volume descending
    candidates.sort((a, b) => {
      if (a.categoryPriority !== b.categoryPriority) return a.categoryPriority - b.categoryPriority;
      return (b.market.volume24hr || 0) - (a.market.volume24hr || 0);
    });

    // Take top N
    const selected = candidates.slice(0, this.config.maxMarkets);

    return selected.map(c => this.createMarketState(c));
  }

  private createMarketState(candidate: {
    market: GammaMarket;
    category: FeeCategory;
    yesTokenId: string;
    noTokenId: string;
    tickSize: TickSize;
    bestBid: number;
    bestAsk: number;
  }): MMMarketState {
    const name = candidate.market.question.slice(0, 60) +
      (candidate.market.question.length > 60 ? '...' : '');
    return {
      conditionId: candidate.market.conditionId,
      name,
      yesTokenId: candidate.yesTokenId,
      noTokenId: candidate.noTokenId,
      tickSize: candidate.tickSize,
      feeCategory: candidate.category,
      bestBid: candidate.bestBid,
      bestAsk: candidate.bestAsk,
      mid: (candidate.bestBid + candidate.bestAsk) / 2,
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
      quotingActive: false,
    };
  }

  // ============================================================================
  // Quoting
  // ============================================================================

  computeQuotes(market: MMMarketState): QuoteResult | null {
    if (market.bestBid <= 0 || market.bestAsk <= 0 || market.bestBid >= market.bestAsk) {
      return null;
    }

    const tickSizeValue = parseFloat(market.tickSize);
    const mid = (market.bestBid + market.bestAsk) / 2;
    const qMax = this.config.maxInventoryShares;

    // Normalized inventory: -1 to +1
    const inv = Math.max(-1, Math.min(1, market.inventory / qMax));

    // Reservation price: lean toward flattening
    const reservation = mid - inv * this.config.skewWidth;

    // Half spread in price terms
    const halfSpread = this.config.baseHalfSpreadTicks * tickSizeValue;

    // Raw quote prices
    let bidPrice = roundPrice(reservation - halfSpread, market.tickSize, 'floor');
    let askPrice = roundPrice(reservation + halfSpread, market.tickSize, 'ceil');

    // Enforce minimum spread
    const actualSpreadTicks = Math.round((askPrice - bidPrice) / tickSizeValue);
    if (actualSpreadTicks < this.config.minSpreadTicks) {
      const ticksToAdd = this.config.minSpreadTicks - actualSpreadTicks;
      const halfTicks = Math.ceil(ticksToAdd / 2);
      bidPrice = roundPrice(bidPrice - halfTicks * tickSizeValue, market.tickSize, 'floor');
      askPrice = roundPrice(askPrice + (ticksToAdd - halfTicks) * tickSizeValue, market.tickSize, 'ceil');
    }

    // Sanity: bid must be < ask
    if (bidPrice >= askPrice) return null;

    // One-sided caps
    const skipBid = market.inventory >= qMax;
    const skipAsk = market.inventory <= -qMax;

    // Size: ensure minimum order constraints
    let bidSize = Math.max(this.config.orderSize, MIN_ORDER_SIZE_SHARES);
    let askSize = Math.max(this.config.orderSize, MIN_ORDER_SIZE_SHARES);

    if (bidPrice * bidSize < MIN_ORDER_VALUE_USDC) {
      bidSize = Math.ceil(MIN_ORDER_VALUE_USDC / bidPrice);
    }
    if (askPrice * askSize < MIN_ORDER_VALUE_USDC) {
      askSize = Math.ceil(MIN_ORDER_VALUE_USDC / askPrice);
    }

    return { bidPrice, askPrice, bidSize, askSize, skipBid, skipAsk };
  }

  // ============================================================================
  // Orderbook Updates & Requoting
  // ============================================================================

  private handleOrderbookUpdate(book: OrderbookSnapshot): void {
    // Find which market this book belongs to
    const market = this.findMarketByTokenId(book.assetId || book.tokenId);
    if (!market || !market.quotingActive || market.isBlacklisted) return;

    const prevBestBid = market.bestBid;
    const prevBestAsk = market.bestAsk;
    const prevMid = market.mid;

    // Update cached book state
    this.updateBookState(market, book);

    // Dry-run: check for simulated fills before requoting
    // Pass prevMid so spread PnL is computed against pre-move mid, not post-move mid
    if (this.config.dryRun) {
      this.checkSimulatedFills(market, prevMid);
    }

    // Trigger 0: No resting orders yet → post initial quotes
    const hasNoQuotes = market.restingBidPrice === 0 && market.restingAskPrice === 0;
    if (hasNoQuotes && market.bestBid > 0 && market.bestAsk > 0) {
      this.requote(market, 'initial quote');
      return;
    }

    // Check requote triggers
    const tickSize = parseFloat(market.tickSize);
    let reason = '';

    // Trigger 1: Best bid/ask moved >= threshold
    const bidDelta = Math.abs(market.bestBid - prevBestBid);
    const askDelta = Math.abs(market.bestAsk - prevBestAsk);
    if (bidDelta >= this.config.requoteThresholdTicks * tickSize ||
        askDelta >= this.config.requoteThresholdTicks * tickSize) {
      reason = `book moved ${Math.max(bidDelta, askDelta).toFixed(4)}`;
    }

    // Trigger 2: Our resting bid undercut
    if (!reason && market.restingBidPrice > 0 && market.bestBid > market.restingBidPrice) {
      reason = 'bid undercut';
    }

    // Trigger 3: Our resting ask undercut
    if (!reason && market.restingAskPrice > 0 && market.bestAsk < market.restingAskPrice) {
      reason = 'ask undercut';
    }

    if (reason) {
      this.requote(market, reason);
    }
  }

  private findMarketByTokenId(tokenId: string): MMMarketState | undefined {
    for (const market of this.markets.values()) {
      if (market.yesTokenId === tokenId || market.noTokenId === tokenId) {
        return market;
      }
    }
    return undefined;
  }

  private updateBookState(market: MMMarketState, book: OrderbookSnapshot): void {
    // Only update from YES token orderbook (primary)
    if (book.assetId !== market.yesTokenId && book.tokenId !== market.yesTokenId) return;

    if (book.bids && book.bids.length > 0) {
      market.bestBid = book.bids[0].price;
    }
    if (book.asks && book.asks.length > 0) {
      market.bestAsk = book.asks[0].price;
    }
    if (market.bestBid > 0 && market.bestAsk > 0) {
      market.mid = (market.bestBid + market.bestAsk) / 2;
    }
    market.lastBookUpdate = Date.now();

    // Update inventory MtM
    market.inventoryMtM = market.inventory * market.mid;
  }

  private async requote(market: MMMarketState, reason: string): Promise<void> {
    // Per-market debounce
    if (this.requotingMarkets.has(market.conditionId)) return;
    this.requotingMarkets.add(market.conditionId);

    try {
      this.emit('requote', { market: market.name, reason });
      this.stats.requotes++;

      // 1. Cancel existing orders
      await this.cancelMarketOrders(market);

      // 2. Compute fresh quotes
      const quotes = this.computeQuotes(market);
      if (!quotes) {
        return;
      }

      // 3. Post new orders
      await this.postQuotes(market, quotes);
    } catch (err) {
      this.emit('error', err as Error);
    } finally {
      this.requotingMarkets.delete(market.conditionId);
    }
  }

  // ============================================================================
  // Order Management
  // ============================================================================

  private async cancelMarketOrders(market: MMMarketState): Promise<void> {
    const idsToCancel: string[] = [];
    if (market.restingBidOrderId) idsToCancel.push(market.restingBidOrderId);
    if (market.restingAskOrderId) idsToCancel.push(market.restingAskOrderId);

    if (idsToCancel.length > 0 && !this.config.dryRun) {
      try {
        await this.tradingService.cancelOrders(idsToCancel);
      } catch (err) {
        this.log(`Cancel failed: ${(err as Error).message}`);
      }
    }

    market.restingBidOrderId = null;
    market.restingAskOrderId = null;
  }

  private async postQuotes(market: MMMarketState, quotes: QuoteResult): Promise<void> {
    if (this.config.dryRun) {
      // Simulated: just update state
      if (!quotes.skipBid) {
        market.restingBidPrice = quotes.bidPrice;
      }
      if (!quotes.skipAsk) {
        market.restingAskPrice = quotes.askPrice;
      }
      this.stats.quotesPosted++;
      this.emit('quotePosted', {
        market: market.name,
        bidPrice: quotes.skipBid ? 0 : quotes.bidPrice,
        askPrice: quotes.skipAsk ? 0 : quotes.askPrice,
        bidSize: quotes.skipBid ? 0 : quotes.bidSize,
        askSize: quotes.skipAsk ? 0 : quotes.askSize,
      });
      return;
    }

    // Live: place GTC limit orders
    if (!quotes.skipBid) {
      try {
        const result = await this.tradingService.createLimitOrder({
          tokenId: market.yesTokenId,
          side: 'BUY',
          price: quotes.bidPrice,
          size: quotes.bidSize,
          orderType: 'GTC',
        });
        if (result.success) {
          market.restingBidOrderId = result.orderId || null;
          market.restingBidPrice = quotes.bidPrice;
        }
      } catch (err) {
        this.log(`Bid order failed: ${(err as Error).message}`);
      }
    }

    if (!quotes.skipAsk) {
      try {
        const result = await this.tradingService.createLimitOrder({
          tokenId: market.yesTokenId,
          side: 'SELL',
          price: quotes.askPrice,
          size: quotes.askSize,
          orderType: 'GTC',
        });
        if (result.success) {
          market.restingAskOrderId = result.orderId || null;
          market.restingAskPrice = quotes.askPrice;
        }
      } catch (err) {
        this.log(`Ask order failed: ${(err as Error).message}`);
      }
    }

    this.stats.quotesPosted++;
    this.emit('quotePosted', {
      market: market.name,
      bidPrice: quotes.skipBid ? 0 : quotes.bidPrice,
      askPrice: quotes.skipAsk ? 0 : quotes.askPrice,
      bidSize: quotes.skipBid ? 0 : quotes.bidSize,
      askSize: quotes.skipAsk ? 0 : quotes.askSize,
    });
  }

  // ============================================================================
  // Fill Detection
  // ============================================================================

  private handleUserFill(trade: UserTrade): void {
    // Match by conditionId
    const market = this.markets.get(trade.market);
    if (!market) return;

    // Only process confirmed fills
    if (trade.status !== 'CONFIRMED' && trade.status !== 'MATCHED') return;

    this.recordFill(market, trade.side, trade.price, trade.size);
  }

  private lastFillTime: Map<string, number> = new Map();

  private checkSimulatedFills(market: MMMarketState, prevMid: number): void {
    // Cooldown: prevent fill-requote-fill loop (at most one fill per MIN_FILL_INTERVAL_MS)
    const now = Date.now();
    const lastFill = this.lastFillTime.get(market.conditionId) ?? 0;
    if (now - lastFill < MIN_FILL_INTERVAL_MS) return;

    // In dry-run: simulate fill when book crosses our resting price
    // Use prevMid (before book update) for spread PnL calculation
    let filled = false;
    if (market.restingBidPrice > 0 && market.bestAsk <= market.restingBidPrice) {
      this.recordFill(market, 'BUY', market.restingBidPrice, this.config.orderSize, prevMid);
      market.restingBidPrice = 0;
      market.restingBidOrderId = null;
      filled = true;
    }
    if (!filled && market.restingAskPrice > 0 && market.bestBid >= market.restingAskPrice) {
      this.recordFill(market, 'SELL', market.restingAskPrice, this.config.orderSize, prevMid);
      market.restingAskPrice = 0;
      market.restingAskOrderId = null;
      filled = true;
    }
    if (filled) {
      this.lastFillTime.set(market.conditionId, now);
    }
  }

  private recordFill(market: MMMarketState, side: 'BUY' | 'SELL', price: number, size: number, midOverride?: number): void {
    const prevInventory = market.inventory;

    // Update inventory
    if (side === 'BUY') {
      market.inventory += size;
    } else {
      market.inventory -= size;
    }

    // Realized spread PnL: how far from mid we captured
    // Use midOverride (pre-move mid) for simulated fills to avoid adverse spread calculation
    const midForSpread = midOverride ?? market.mid;
    const sideSign = side === 'BUY' ? -1 : 1;  // buy below mid = positive spread
    const spreadCaptured = (price - midForSpread) * sideSign;
    market.realizedSpreadPnL += spreadCaptured * size;

    // Model rebate income (estimated; actual is daily aggregate)
    const takerFeeOnCounterparty = calculateTakerFee(size, price, market.feeCategory);
    const rebateShare = MAKER_REBATE_SHARES[market.feeCategory] || 0;
    const fillRebateIncome = takerFeeOnCounterparty * rebateShare;
    market.modeledRebateIncome += fillRebateIncome;

    // Update inventory MtM
    market.inventoryMtM = market.inventory * market.mid;

    this.stats.fills++;
    this.emit('fill', {
      market: market.name,
      side,
      price,
      size,
      inventoryAfter: market.inventory,
      spreadPnL: spreadCaptured * size,
      rebateIncome: fillRebateIncome,
    });

    // Start fill-to-mark sampling
    this.startFillToMarkSampling(market, side, price);

    // Check inventory band trigger for requote
    const bandSize = Math.max(1, this.config.maxInventoryShares / 4);
    const prevBand = Math.floor(prevInventory / bandSize);
    const newBand = Math.floor(market.inventory / bandSize);
    if (prevBand !== newBand) {
      this.requote(market, `inventory band ${prevBand} → ${newBand}`);
    }

    // Kill switch
    this.checkKillSwitch(market);
  }

  // ============================================================================
  // Fill-to-Mark Drift Tracking
  // ============================================================================

  private startFillToMarkSampling(market: MMMarketState, side: 'BUY' | 'SELL', fillPrice: number): void {
    const sample: FillToMarkSample = {
      fillTime: Date.now(),
      fillPrice,
      fillSide: side,
      driftDelaysMs: [...this.config.fillToMarkDelaysMs],
      driftBps: this.config.fillToMarkDelaysMs.map(() => null),
      midAtFill: market.mid,
      completed: false,
    };

    market.fillToMarkSamples.push(sample);

    // Keep only last 50 samples
    if (market.fillToMarkSamples.length > 50) {
      market.fillToMarkSamples = market.fillToMarkSamples.slice(-50);
    }

    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 0; i < sample.driftDelaysMs.length; i++) {
      const timer = setTimeout(() => {
        const currentMid = market.mid;
        const sign = sample.fillSide === 'BUY' ? 1 : -1;
        sample.driftBps[i] = ((currentMid - sample.fillPrice) / sample.fillPrice) * 10000 * sign;

        if (sample.driftBps.every(d => d !== null)) {
          sample.completed = true;
          this.updateRollingDrift(market);
          this.emit('fillToMark', sample);
        }
      }, sample.driftDelaysMs[i]);
      timers.push(timer);
    }

    const key = `${market.conditionId}-${sample.fillTime}`;
    this.fillTimers.set(key, timers);
  }

  private updateRollingDrift(market: MMMarketState): void {
    const completed = market.fillToMarkSamples.filter(s => s.completed);
    if (completed.length === 0) return;

    // Use last 20 completed samples, take mean of the longest delay (30s)
    const recent = completed.slice(-20);
    const driftIndex = this.config.fillToMarkDelaysMs.length - 1;
    const drifts = recent
      .map(s => s.driftBps[driftIndex])
      .filter((d): d is number => d !== null);

    if (drifts.length === 0) return;
    market.rollingDriftBps = drifts.reduce((a, b) => a + b, 0) / drifts.length;

    // Blacklist if consistently adverse (>= 10 samples, drift < -5 bps)
    if (drifts.length >= 10 && market.rollingDriftBps < -5) {
      market.isBlacklisted = true;
      market.blacklistReason = `adverse drift ${market.rollingDriftBps.toFixed(1)} bps`;
      market.quotingActive = false;
      this.cancelMarketOrders(market);
      this.emit('marketBlacklisted', { market: market.name, reason: market.blacklistReason });
      this.log(`Blacklisted ${market.name}: ${market.blacklistReason}`);
    }
  }

  // ============================================================================
  // Risk Management
  // ============================================================================

  private checkKillSwitch(market: MMMarketState): void {
    if (market.inventory === 0) return;

    const exposureUsd = Math.abs(market.inventory) * market.mid;
    const unrealizedLoss = -market.inventoryMtM; // negative MtM = loss for long position that dropped

    if (unrealizedLoss > 0 && unrealizedLoss > exposureUsd * this.config.maxUnrealizedLossPct) {
      this.log(`KILL SWITCH: ${market.name} unrealized loss $${unrealizedLoss.toFixed(2)} > ${(this.config.maxUnrealizedLossPct * 100).toFixed(0)}% of exposure`);
      market.quotingActive = false;
      market.isBlacklisted = true;
      market.blacklistReason = 'kill switch: unrealized loss';
      this.cancelMarketOrders(market);
      this.emit('marketBlacklisted', { market: market.name, reason: market.blacklistReason });
    }
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  private log(message: string): void {
    console.log(`[MM] ${message}`);
  }

  private logStats(): void {
    const elapsed = ((Date.now() - this.stats.startTime) / 1000 / 60).toFixed(1);
    this.log(`Stats after ${elapsed}min: ${this.stats.quotesPosted} quotes, ${this.stats.fills} fills, ${this.stats.requotes} requotes across ${this.stats.marketsQuoted} markets`);

    for (const market of this.markets.values()) {
      const netPnL = market.realizedSpreadPnL + market.modeledRebateIncome + market.inventoryMtM;
      this.log(`  ${market.name}: inv=${market.inventory} spread=$${market.realizedSpreadPnL.toFixed(4)} rebate=$${market.modeledRebateIncome.toFixed(4)} mtm=$${market.inventoryMtM.toFixed(4)} net=$${netPnL.toFixed(4)} drift=${market.rollingDriftBps.toFixed(1)}bps${market.isBlacklisted ? ' [BLACKLISTED]' : ''}`);
    }
  }
}
