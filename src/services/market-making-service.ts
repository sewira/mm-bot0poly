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
  computeBreakEvenSpreadTicks,
  computeRebateBpsPerFill,
  MAKER_REBATE_SHARES,
  type FeeCategory,
} from '../utils/fee-utils.js';
import { roundPrice, type TickSize } from '../utils/price-utils.js';
import type { MarketService } from './market-service.js';
import { MmLogger, computeConfigHash, type FillRecord } from './mm-logger.js';
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

  // Quoting (03 SS3.1–3.5, SS5)
  baseHalfSpreadTicks?: number;
  /** @deprecated Use minSpreadTicksByCategory. Falls back to this if per-category floor missing. (03 SS3.5) */
  minSpreadTicks?: number;
  /** Per-category minimum spread floors, rebate-aware. (03 SS3.5, SS5) */
  minSpreadTicksByCategory?: Record<string, number>;
  skewWidth?: number;
  /** Base order size in shares. Asymmetric sizing scales from this. (03 SS3.3, SS5) */
  baseSize?: number;
  /** @deprecated Alias for baseSize. If both set, baseSize wins. */
  orderSize?: number;

  // Inventory (03 SS4)
  maxInventoryShares?: number;
  /** Portfolio gross exposure cap in USD. Enforced in order path, not config-only. (03 SS4) */
  maxGrossExposureUsd?: number;
  /** Per-event-cluster exposure cap in USD. (03 SS4, SS5) */
  maxClusterExposureUsd?: number;

  // Requoting + circuit breaker (03 SS3.7, SS5)
  requoteThresholdTicks?: number;
  /** Mid ticks jump that triggers circuit breaker. (03 SS3.7) */
  breakerTicks?: number;
  /** Rolling window (ms) in which breakerTicks jump is measured. (03 SS3.7) */
  breakerWindowMs?: number;
  /** Cooldown (ms) after circuit breaker fires — no new quotes. (03 SS3.7) */
  cooldownMs?: number;
  /** Stale-feed guard: pull quotes if no book update for this many ms. (03 SS4) */
  staleFeedMs?: number;

  // Risk
  /** Per-market kill switch: unrealized loss > this % of exposure → cancel, flatten, blacklist. (03 §4, §5) */
  killSwitchLossPct?: number;

  // Spread terms (03 SS3.4, SS5)
  /** Volatility observation window in ms. Phase D. */
  volWindowMs?: number;
  /** Max resolution-clock spread widening in ticks. Phase D. */
  jumpTermTicks?: number;

  // Fill-to-mark
  fillToMarkDelaysMs?: number[];

  // Phase C: Drift schedule (03 SS2, SS6 Item 8)
  /** Minimum fills per hour-bucket before acting on drift data. (03 SS6 Item 8) */
  minFillsPerBucket?: number;
  /** Drift threshold (bps) below which an hour-bucket is toxic. (03 SS6 Item 8) */
  toxicDriftThresholdBps?: number;

  // Phase C: EdgeScore capital allocator (03 SS2, SS6 Item 9)
  /** Minimum total fills per market before edgeScore is trusted. (03 SS7.3) */
  minFillsForEdgeScore?: number;

  // Phase C: Queue-position tracking (03 SS3.6, SS6 Item 11)
  /** Queue depth fraction (0-1) at which we cancel (deep-in-queue eroding level). (03 SS3.6) */
  queueCancelThreshold?: number;

  // Phase C: Rebate reconciliation (03 SS3.5, SS6 Item 10)
  /** Max allowed divergence between modeled and actual rebates before flagging. (03 SS7.2) */
  rebateDivergenceThreshold?: number;
  /** Enable dynamic break-even spread floor computation. (03 SS3.5, Phase C) */
  dynamicSpreadFloors?: boolean;

  // Operational
  dryRun?: boolean;
  maxMarkets?: number;
  /** Replace markets with no fills after this duration (ms). 0 = disabled. Default: 2h. */
  inactiveRotationMs?: number;
  /** How often to check for inactive markets (ms). Default: 30min. */
  rotationCheckIntervalMs?: number;

  // Record system (03 SS8.1) — regime + stage tag every snapshot/fill row
  /** Versioned regime string, e.g. "2026-dynamic-v1". Increment on any fee/rebate change. */
  regime?: string;
  /** Current stage per SS7.1 gate table. */
  stage?: 'backtest' | 'dry-run' | 'pilot' | 'scale-1';
  /** Override logs directory (default: logs/). Primarily for testing. */
  logsDir?: string;
}

export interface MMMarketState {
  conditionId: string;
  name: string;
  yesTokenId: string;
  noTokenId: string;
  tickSize: TickSize;
  feeCategory: FeeCategory;

  // Book state
  bestBid: number;
  bestAsk: number;
  /** Size at best bid level (shares). Used for microprice. (03 SS3.1) */
  bestBidSize: number;
  /** Size at best ask level (shares). Used for microprice. (03 SS3.1) */
  bestAskSize: number;
  /** Simple mid = (bestBid + bestAsk) / 2. Used for marking/PnL, NOT quote placement. */
  mid: number;
  /** Depth-weighted microprice. Used for quote placement. (03 SS3.1) */
  microprice: number;
  lastBookUpdate: number;
  /** Last full orderbook snapshot (for queue-position + fronting). */
  lastBook: OrderbookSnapshot | null;

  // Circuit breaker (03 SS3.7)
  /** Rolling mid-price history for breaker detection: {ts, mid}[] */
  midHistory: Array<{ ts: number; mid: number }>;
  /** If set, no quotes until this timestamp (Date.now() > breakerCooldownUntil). */
  breakerCooldownUntil: number;

  // Inventory (signed: + = long YES shares, - = short)
  inventory: number;

  // Our resting orders
  restingBidOrderId: string | null;
  restingBidPrice: number;
  restingBidSize: number;
  restingAskOrderId: string | null;
  restingAskPrice: number;
  restingAskSize: number;

  // PnL
  realizedSpreadPnL: number;
  modeledRebateIncome: number;
  inventoryMtM: number;
  /** Volume-weighted average entry price. Tracks cost basis for kill switch. */
  costBasis: number;

  // Fill-to-mark
  fillToMarkSamples: FillToMarkSample[];
  rollingDriftBps: number;

  // Market metadata for expiry-based logic (03 SS2)
  hoursToResolution: number;
  /** Event cluster ID: markets resolving on the same catalyst share a cluster (03 §4). */
  eventClusterId: string;

  // Phase C: Drift schedule (03 SS2, SS6 Item 8)
  /** Per-hour drift data: key=hourBucket(0-23), value={count, sumDriftBps}. */
  hourlyDrift: Map<number, { count: number; sumDriftBps: number }>;

  // Phase C: EdgeScore (03 SS2, SS6 Item 9)
  /** Composite edge score: E[spreadCapture bps/fill] + rebate bps/fill + meanDriftBps. */
  edgeScore: number;
  /** Total fills for this market (used for minimum sample gate). */
  totalFills: number;
  /** Mean spread capture in bps across all fills. */
  meanSpreadCaptureBps: number;
  /** Sum of spread capture bps for running average. */
  sumSpreadCaptureBps: number;

  // Phase C: Queue-position tracking (03 SS3.6, SS6 Item 11)
  /** Estimated queue position for resting bid: shares ahead of us. */
  queuePosBid: number;
  /** Estimated queue position for resting ask: shares ahead of us. */
  queuePosAsk: number;
  /** Total level size at the time we posted the bid. */
  sizeAheadAtPostBid: number;
  /** Total level size at the time we posted the ask. */
  sizeAheadAtPostAsk: number;
  /** Price level where our bid was posted (for queue tracking). */
  queueTrackBidPrice: number;
  /** Price level where our ask was posted (for queue tracking). */
  queueTrackAskPrice: number;

  // Phase C: Rebate reconciliation (03 SS3.5, SS6 Item 10)
  /** Actual rebate income received (set from external settlement data). */
  actualRebateIncome: number;

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

  // Record system (03 SS8) — append-only JSONL logging
  private logger: MmLogger;
  private configHash: string = '';
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  // Market rotation — replace inactive markets
  private rotationTimer: ReturnType<typeof setInterval> | null = null;
  private isRotating = false;

  private stats = {
    quotesPosted: 0,
    fills: 0,
    dailyFills: 0,  // Reset at each daily snapshot (W6 fix)
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
      // Market selection
      categories: config.categories ?? ['geopolitics', 'finance', 'politics', 'sports'],
      excludeCategories: config.excludeCategories ?? ['crypto'],
      minVolume24h: config.minVolume24h ?? 5000,
      minDepthShares: config.minDepthShares ?? 50,
      priceBand: config.priceBand ?? [0.20, 0.80],
      minHoursToResolution: config.minHoursToResolution ?? 12,
      // Quoting (03 SS3.1-3.5, SS5)
      baseHalfSpreadTicks: config.baseHalfSpreadTicks ?? 2,
      minSpreadTicks: config.minSpreadTicks ?? 1,
      minSpreadTicksByCategory: config.minSpreadTicksByCategory ?? {
        // Rebate-aware floors (03 SS3.5): higher rebate => tighter floor allowed.
        // Geopolitics: fee-free, no rebate => widest floor (spread-only income).
        geopolitics: 3,
        // Finance: 25% rebate (same as other non-crypto categories).
        finance: 2,
        // Politics/Sports/Tech/Economics/Culture/Weather/Mentions: 25% rebate.
        politics: 2,
        sports: 2,
        tech: 2,
        economics: 2,
        culture: 2,
        weather: 2,
        mentions: 2,
        // Crypto: 20% rebate but excluded by selection filter. Floor if reached.
        crypto: 3,
        other: 2,
      },
      skewWidth: config.skewWidth ?? 0.02,
      baseSize: config.baseSize ?? config.orderSize ?? 10,  // baseSize wins over orderSize (03 SS3.3)
      orderSize: config.orderSize ?? config.baseSize ?? 10,  // kept for backward compat
      // Inventory + risk (03 SS4)
      maxInventoryShares: config.maxInventoryShares ?? 50,
      maxGrossExposureUsd: config.maxGrossExposureUsd ?? 100,
      maxClusterExposureUsd: config.maxClusterExposureUsd ?? 200,
      // Requoting + breaker (03 SS3.7, SS4, SS5)
      requoteThresholdTicks: config.requoteThresholdTicks ?? 1,
      breakerTicks: config.breakerTicks ?? 5,       // mid jump ticks to trigger breaker (03 SS3.7)
      breakerWindowMs: config.breakerWindowMs ?? 2000,  // rolling window for breaker (03 SS3.7)
      cooldownMs: config.cooldownMs ?? 30000,        // sit-out period after breaker fires (03 SS3.7)
      staleFeedMs: config.staleFeedMs ?? 10000,      // pull quotes if no book update for this long (03 SS4)
      // Risk
      killSwitchLossPct: config.killSwitchLossPct ?? 0.10,
      // Spread terms (Phase D, defaults only)
      volWindowMs: config.volWindowMs ?? 60000,
      jumpTermTicks: config.jumpTermTicks ?? 3,
      // Fill-to-mark
      fillToMarkDelaysMs: config.fillToMarkDelaysMs ?? [5000, 15000, 30000],
      // Phase C: Drift schedule (03 SS2, SS6 Item 8)
      minFillsPerBucket: config.minFillsPerBucket ?? 30,        // minimum sample count per hour-bucket
      toxicDriftThresholdBps: config.toxicDriftThresholdBps ?? 0, // drift below this = toxic hour
      // Phase C: EdgeScore (03 SS2, SS6 Item 9)
      minFillsForEdgeScore: config.minFillsForEdgeScore ?? 100,  // per 03 SS7.3: minimum 100 fills
      // Phase C: Queue-position (03 SS3.6, SS6 Item 11)
      queueCancelThreshold: config.queueCancelThreshold ?? 0.80, // cancel when >80% of level consumed
      // Phase C: Rebate reconciliation (03 SS3.5, SS6 Item 10)
      rebateDivergenceThreshold: config.rebateDivergenceThreshold ?? 0.20, // 20% per 03 SS7.2
      dynamicSpreadFloors: config.dynamicSpreadFloors ?? true,
      // Operational
      dryRun: config.dryRun ?? true,
      maxMarkets: config.maxMarkets ?? 3,
      inactiveRotationMs: config.inactiveRotationMs ?? 2 * 60 * 60 * 1000,  // 2 hours
      rotationCheckIntervalMs: config.rotationCheckIntervalMs ?? 30 * 60 * 1000,  // 30 minutes
      // Record system (03 SS8.1)
      regime: config.regime ?? '2026-dynamic-v1',
      stage: config.stage ?? 'dry-run',
      logsDir: config.logsDir ?? '',
    };

    // Initialize logger (03 SS8.1, SS6 Phase A item 3)
    const loggerOpts = this.config.logsDir ? { logsDir: this.config.logsDir } : {};
    this.logger = new MmLogger(loggerOpts);
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

    // Explicit live-trading safety gate (audit B4).
    // Live trading requires LIVE_TRADING_CONFIRMED=true in environment,
    // independent of the dryRun config flag. A config boolean alone is not
    // an explicit enough gate for real capital.
    if (!this.config.dryRun) {
      const confirmed = process.env.LIVE_TRADING_CONFIRMED === 'true';
      if (!confirmed) {
        throw new Error(
          'SAFETY GATE: Live trading requires LIVE_TRADING_CONFIRMED=true in environment. ' +
          'Set this env var explicitly to confirm you intend to trade with real capital.'
        );
      }
    }

    // 0. Initialize record system (03 SS8.1, SS6 Phase A)
    this.logger.ensureDirectories();
    this.configHash = this.logger.saveConfigIfChanged(this.config as unknown as Record<string, unknown>);
    this.scheduleDailySnapshot();

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

    // 5. Start stale-feed guard (03 SS4) — "Must exist before any real capital."
    this.startStaleFeedGuard();

    // 6. Re-post quotes after WS reconnection (book snapshot will come, but
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

    // 7. Start market rotation timer (replace inactive markets)
    if (this.config.inactiveRotationMs > 0) {
      this.rotationTimer = setInterval(
        () => this.rotateInactiveMarkets(),
        this.config.rotationCheckIntervalMs,
      );
      this.log(`Market rotation enabled: replace after ${Math.round(this.config.inactiveRotationMs / 60000)}min inactive, check every ${Math.round(this.config.rotationCheckIntervalMs / 60000)}min`);
    }

    // 8. Log incident-level entry when armed for live trading (implementation rule 5)
    if (!this.config.dryRun) {
      this.logger.logIncident({
        ts: Date.now(),
        market: null,
        trigger: 'live_trading_armed',
        midBefore: null,
        midAfter60s: null,
        quotesActive: true,
        action: `LIVE MODE ARMED — ${this.markets.size} markets, gross cap $${this.config.maxGrossExposureUsd}`,
      });
    }

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

    // Stop stale-feed guard
    this.stopStaleFeedGuard();

    // Stop market rotation timer
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }

    // Clear fill-to-mark timers
    for (const timers of this.fillTimers.values()) {
      timers.forEach(t => clearTimeout(t));
    }
    this.fillTimers.clear();
    this.lastFillTime.clear();

    // Clear daily snapshot timer
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }

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
      order: 'volume24hr',
      ascending: false,
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
      hoursToResolution: number;
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

        // Time-to-resolution (computed early — needed for price band tightening)
        const endDate = gm.endDate instanceof Date ? gm.endDate : new Date(gm.endDate);
        const hoursToEnd = (endDate.getTime() - Date.now()) / (1000 * 60 * 60);
        if (hoursToEnd < this.config.minHoursToResolution) { filterStats.tooCloseToEnd++; continue; }

        // Price band — auto-tighten near expiry (03 SS2: inside 24h → [0.30, 0.70])
        const yesPrice = gm.outcomePrices?.[0] ?? 0;
        const effectivePriceBand = MarketMakingService.effectivePriceBand(
          this.config.priceBand, hoursToEnd,
        );
        if (yesPrice < effectivePriceBand[0] || yesPrice > effectivePriceBand[1]) { filterStats.priceBand++; continue; }

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
          hoursToResolution: hoursToEnd,
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

  // ============================================================================
  // Market Rotation — replace inactive markets
  // ============================================================================

  private async rotateInactiveMarkets(): Promise<void> {
    if (!this.isRunning || this.isRotating) return;
    this.isRotating = true;

    try {
      const now = Date.now();
      const inactiveThreshold = this.config.inactiveRotationMs;
      const activeConditionIds = new Set(this.markets.keys());

      // Find markets that should be rotated out:
      // 1. No fills for > inactiveThreshold (regardless of total fill count)
      // 2. Blacklisted/blocked markets (circuit breaker permanently tripped)
      // 3. Price moved out of band (e.g. resolved markets near 0 or 1)
      const inactiveMarkets: MMMarketState[] = [];
      for (const market of this.markets.values()) {
        const lastFill = this.lastFillTime.get(market.conditionId) ?? this.stats.startTime;
        const timeSinceLastFill = now - lastFill;

        // Blacklisted markets are dead weight — always rotate
        if (market.isBlacklisted) {
          inactiveMarkets.push(market);
          continue;
        }

        // Price moved out of band (resolved or near-resolved)
        const [lo, hi] = this.config.priceBand;
        if (market.mid > 0 && (market.mid < lo || market.mid > hi)) {
          inactiveMarkets.push(market);
          continue;
        }

        // No recent fills
        if (timeSinceLastFill > inactiveThreshold) {
          inactiveMarkets.push(market);
        }
      }

      if (inactiveMarkets.length === 0) {
        return;
      }

      const reasons = inactiveMarkets.map(m => {
        if (m.isBlacklisted) return `${m.name} (blocked)`;
        const [lo, hi] = this.config.priceBand;
        if (m.mid > 0 && (m.mid < lo || m.mid > hi)) return `${m.name} (out of band: ${m.mid})`;
        return `${m.name} (no fills for >${Math.round(inactiveThreshold / 60000)}min)`;
      });
      this.log(`ROTATION: ${inactiveMarkets.length} market(s) eligible for replacement: ${reasons.join(', ')}`);

      // Run fresh selection scan
      const freshCandidates = await this.selectMarkets();
      // Filter out markets we already have (active ones that aren't being rotated)
      const inactiveIds = new Set(inactiveMarkets.map(m => m.conditionId));
      const replacements = freshCandidates.filter(
        m => !activeConditionIds.has(m.conditionId) || inactiveIds.has(m.conditionId),
      );

      // Only keep genuinely new markets
      const newMarkets = replacements.filter(m => !activeConditionIds.has(m.conditionId));

      if (newMarkets.length === 0) {
        this.log('ROTATION: No new replacement markets found — keeping current markets');
        return;
      }

      // Remove inactive markets (up to the number of replacements available)
      const toRemove = inactiveMarkets.slice(0, newMarkets.length);
      for (const market of toRemove) {
        // Cancel any resting orders
        await this.cancelMarketOrders(market);
        market.quotingActive = false;

        // Unsubscribe from orderbook
        const sub = this.marketSubscriptions.get(market.conditionId);
        if (sub) {
          sub.unsubscribe();
          this.marketSubscriptions.delete(market.conditionId);
        }

        // Remove from tracking
        this.markets.delete(market.conditionId);
        this.lastFillTime.delete(market.conditionId);
        this.log(`ROTATION: Removed inactive market: ${market.name}`);
      }

      // Add new markets
      const toAdd = newMarkets.slice(0, toRemove.length);
      for (const market of toAdd) {
        this.markets.set(market.conditionId, market);

        // Subscribe to orderbook
        const tokenIds = [market.yesTokenId, market.noTokenId];
        const sub = this.realtimeService.subscribeMarkets(tokenIds, {
          onOrderbook: (book: OrderbookSnapshot) => this.handleOrderbookUpdate(book),
        });
        this.marketSubscriptions.set(market.conditionId, sub);
        market.quotingActive = true;
        this.log(`ROTATION: Added new market: ${market.name} [${market.feeCategory}]`);
      }

      this.stats.marketsQuoted = this.markets.size;
      this.emit('marketRotated', { removed: toRemove.length, added: toAdd.length });
    } catch (err) {
      this.log(`ROTATION: Error during market rotation: ${err}`);
    } finally {
      this.isRotating = false;
    }
  }

  private createMarketState(candidate: {
    market: GammaMarket;
    category: FeeCategory;
    yesTokenId: string;
    noTokenId: string;
    tickSize: TickSize;
    bestBid: number;
    bestAsk: number;
    hoursToResolution: number;
    eventClusterId?: string;
  }): MMMarketState {
    const name = candidate.market.question.slice(0, 60) +
      (candidate.market.question.length > 60 ? '...' : '');
    const mid = (candidate.bestBid + candidate.bestAsk) / 2;
    return {
      conditionId: candidate.market.conditionId,
      name,
      yesTokenId: candidate.yesTokenId,
      noTokenId: candidate.noTokenId,
      tickSize: candidate.tickSize,
      feeCategory: candidate.category,
      bestBid: candidate.bestBid,
      bestAsk: candidate.bestAsk,
      bestBidSize: 0,
      bestAskSize: 0,
      mid,
      microprice: mid,  // initialized to mid; updated when book depth arrives (03 SS3.1)
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
      hoursToResolution: candidate.hoursToResolution,
      eventClusterId: candidate.eventClusterId || candidate.market.conditionId,
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
      quotingActive: false,
    };
  }

  // ============================================================================
  // Quoting
  // ============================================================================

  /**
   * Compute quote prices and sizes.
   *
   * Phase B upgrades (03 SS3.1–3.5):
   * - Microprice centering (SS3.1)
   * - Convex inventory skew (SS3.2)
   * - Asymmetric size (SS3.3)
   * - Per-category rebate-aware spread floor (SS3.5)
   * - maxGrossExposureUsd enforcement in order path (SS4)
   */
  computeQuotes(market: MMMarketState): QuoteResult | null {
    if (market.bestBid <= 0 || market.bestAsk <= 0 || market.bestBid >= market.bestAsk) {
      return null;
    }

    const tickSizeValue = parseFloat(market.tickSize);
    const qMax = this.config.maxInventoryShares;

    // Normalized inventory: -1 to +1 (03 SS3.2)
    const inv = Math.max(-1, Math.min(1, market.inventory / qMax));

    // --- Convex inventory skew (03 SS3.2) ---
    // skew = inv * |inv| * skewWidth  (gentle near flat, aggressive near cap)
    const skew = inv * Math.abs(inv) * this.config.skewWidth;

    // --- Microprice centering (03 SS3.1) ---
    // Use microprice for quote placement, NOT mid.
    const reservation = market.microprice - skew;

    // Half spread in price terms
    const halfSpread = this.config.baseHalfSpreadTicks * tickSizeValue;

    // Raw quote prices
    let bidPrice = roundPrice(reservation - halfSpread, market.tickSize, 'floor');
    let askPrice = roundPrice(reservation + halfSpread, market.tickSize, 'ceil');

    // --- Per-category minimum spread floor (03 SS3.5, Phase C Item 10) ---
    // Use dynamic break-even floor when enabled, otherwise static config floor.
    const categoryFloor = this.computeDynamicMinSpreadTicks(market);
    const effectiveMinSpread = Math.max(categoryFloor, this.config.minSpreadTicks);

    const actualSpreadTicks = Math.round((askPrice - bidPrice) / tickSizeValue);
    if (actualSpreadTicks < effectiveMinSpread) {
      const ticksToAdd = effectiveMinSpread - actualSpreadTicks;
      const halfTicks = Math.ceil(ticksToAdd / 2);
      bidPrice = roundPrice(bidPrice - halfTicks * tickSizeValue, market.tickSize, 'floor');
      askPrice = roundPrice(askPrice + (ticksToAdd - halfTicks) * tickSizeValue, market.tickSize, 'ceil');
    }

    // --- Phase C: Front-vs-join (03 SS3.6, Item 11) ---
    // Prefer fronting a new tick over joining the back of a crowd, when spread permits.
    // Only run when we have a real multi-level book snapshot (from handleOrderbookUpdate).
    if (market.lastBook) {
      const frontBid = this.computeFrontingPrice(market, 'BUY', bidPrice, market.lastBook);
      if (frontBid !== null && frontBid < askPrice) {
        bidPrice = frontBid;
      }
      const frontAsk = this.computeFrontingPrice(market, 'SELL', askPrice, market.lastBook);
      if (frontAsk !== null && frontAsk > bidPrice) {
        askPrice = frontAsk;
      }
    }

    // Sanity: bid must be < ask (crossed-after-rounding rejection)
    if (bidPrice >= askPrice) return null;

    // One-sided caps (03 SS4): skip the side that would increase inventory past max
    const skipBid = market.inventory >= qMax;
    const skipAsk = market.inventory <= -qMax;

    // --- Asymmetric size (03 SS3.3) + edgeScore scaling (Phase C Item 9) ---
    // bidSize = baseSize * max(0, 1 - inv)   (long => smaller bid)
    // askSize = baseSize * min(2, 1 + inv)   (long => bigger ask)
    // Scale by edgeScore multiplier: allocate more capital to higher-scoring markets.
    const edgeMultiplier = this.getEdgeScoreSizeMultiplier(market);
    const base = this.config.baseSize * edgeMultiplier;
    let bidSize = Math.round(base * Math.max(0, 1 - inv));
    let askSize = Math.round(base * Math.min(2, 1 + inv));

    // Enforce minimum order constraints
    bidSize = Math.max(bidSize, MIN_ORDER_SIZE_SHARES);
    askSize = Math.max(askSize, MIN_ORDER_SIZE_SHARES);

    if (bidPrice * bidSize < MIN_ORDER_VALUE_USDC) {
      bidSize = Math.ceil(MIN_ORDER_VALUE_USDC / bidPrice);
    }
    if (askPrice * askSize < MIN_ORDER_VALUE_USDC) {
      askSize = Math.ceil(MIN_ORDER_VALUE_USDC / askPrice);
    }

    // --- maxGrossExposureUsd enforcement (03 SS4) ---
    // Before posting any order, check if it would breach gross exposure.
    // Enforced in code path, not config-only.
    const currentGross = this.computeGrossExposureUsd();
    const maxGross = this.config.maxGrossExposureUsd;

    // --- Per-event-cluster exposure cap (03 SS4) ---
    // Markets resolving on the same catalyst count as one for correlated risk.
    const clusterExposure = this.computeClusterExposureUsd(market.eventClusterId);
    const maxCluster = this.config.maxClusterExposureUsd;
    const clusterBreachBid = clusterExposure + (bidPrice * bidSize) > maxCluster;
    const clusterBreachAsk = clusterExposure + (askPrice * askSize) > maxCluster;

    return {
      bidPrice,
      askPrice,
      bidSize,
      askSize,
      skipBid: skipBid || (!skipBid && (currentGross + (bidPrice * bidSize) > maxGross || clusterBreachBid)),
      skipAsk: skipAsk || (!skipAsk && (currentGross + (askPrice * askSize) > maxGross || clusterBreachAsk)),
    };
  }

  /**
   * Get minimum spread in ticks for a category. Falls back to global minSpreadTicks.
   * Per 03 SS3.5: rebate-aware per-category floors.
   */
  getMinSpreadTicks(category: FeeCategory | string): number {
    const perCat = this.config.minSpreadTicksByCategory[category];
    if (perCat !== undefined) return perCat;
    return this.config.minSpreadTicks;
  }

  /**
   * Compute total gross exposure across all markets in USD.
   * Per 03 SS4: "Portfolio maxGrossExposureUsd -> no new markets when hit."
   */
  computeGrossExposureUsd(): number {
    let gross = 0;
    for (const m of this.markets.values()) {
      gross += Math.abs(m.inventory) * m.mid;
    }
    return gross;
  }

  /**
   * Compute exposure for a specific event cluster (03 §4).
   * Markets resolving on the same catalyst share a cluster — they count as one position
   * for correlated-event risk purposes.
   */
  computeClusterExposureUsd(clusterId: string): number {
    let exposure = 0;
    for (const m of this.markets.values()) {
      if (m.eventClusterId === clusterId) {
        exposure += Math.abs(m.inventory) * m.mid;
      }
    }
    return exposure;
  }

  /**
   * Price band auto-tightening near expiry (03 SS2).
   * Inside 24h to resolution: tighten from [0.20, 0.80] to [0.30, 0.70].
   */
  static effectivePriceBand(baseBand: [number, number], hoursToResolution: number): [number, number] {
    if (hoursToResolution <= 24) {
      // Tighten: bring each side inward by 0.10
      return [
        Math.max(baseBand[0], 0.30),
        Math.min(baseBand[1], 0.70),
      ];
    }
    return baseBand;
  }

  // ============================================================================
  // Safety Gates (03 SS3.7, SS4) — Must exist before any live order path
  // ============================================================================

  /**
   * News circuit breaker (03 SS3.7).
   * Track mid price history within a rolling window.
   * If mid jumps >= breakerTicks within breakerWindowMs -> cancelAll + enter cooldown.
   *
   * @returns true if breaker just fired (caller should abort quoting)
   */
  checkCircuitBreaker(market: MMMarketState): boolean {
    if (market.midHistory.length < 2) return false;

    const tickSizeValue = parseFloat(market.tickSize);
    const breakerThreshold = this.config.breakerTicks * tickSizeValue;

    // Check: did mid move >= breakerTicks within the window?
    const oldestMid = market.midHistory[0].mid;
    const newestMid = market.midHistory[market.midHistory.length - 1].mid;
    const midJump = Math.abs(newestMid - oldestMid);

    if (midJump >= breakerThreshold) {
      // FIRE the breaker
      const now = Date.now();
      market.breakerCooldownUntil = now + this.config.cooldownMs;
      market.quotingActive = false;

      this.log(`CIRCUIT BREAKER: ${market.name} mid jumped ${(midJump / tickSizeValue).toFixed(1)} ticks in ${this.config.breakerWindowMs}ms — cooldown until ${new Date(market.breakerCooldownUntil).toISOString()}`);

      // Cancel all resting orders immediately
      this.cancelMarketOrders(market);

      // Log incident to incidents.jsonl (03 SS8.1)
      this.logger.logIncident({
        ts: now,
        market: market.name,
        trigger: 'circuit_breaker',
        midBefore: oldestMid,
        midAfter60s: null,  // backfilled later
        quotesActive: true,
        action: `cancelAll + cooldown ${this.config.cooldownMs}ms`,
      });

      // Schedule backfill of midAfter60s
      setTimeout(() => {
        this.logger.logIncident({
          ts: now,
          market: market.name,
          trigger: 'circuit_breaker_60s_followup',
          midBefore: oldestMid,
          midAfter60s: market.mid,
          quotesActive: market.quotingActive,
          action: 'followup_sample',
        });
      }, 60000);

      // Clear mid history so it does not re-fire immediately on next update
      market.midHistory = [];

      this.emit('circuitBreaker', { market: market.name, midJump, cooldownMs: this.config.cooldownMs });
      return true;
    }

    return false;
  }

  /**
   * Is this market currently in circuit-breaker cooldown?
   * If cooldown expired, reset it and allow quoting to resume.
   */
  isInBreakerCooldown(market: MMMarketState): boolean {
    if (market.breakerCooldownUntil <= 0) return false;
    const now = Date.now();
    if (now >= market.breakerCooldownUntil) {
      // Cooldown expired — resume
      market.breakerCooldownUntil = 0;
      this.log(`Cooldown expired for ${market.name} — resuming quoting`);
      return false;
    }
    return true;  // still in cooldown
  }

  /**
   * Stale-feed guard (03 SS4).
   * If orderbook feed is silent > staleFeedMs, pull all quotes for that market.
   * Called periodically (via staleFeedTimer) to detect silent feeds.
   */
  private staleFeedTimer: ReturnType<typeof setInterval> | null = null;

  private startStaleFeedGuard(): void {
    // Check every staleFeedMs/2 for responsiveness
    const checkInterval = Math.max(1000, Math.floor(this.config.staleFeedMs / 2));
    this.staleFeedTimer = setInterval(() => {
      if (!this.isRunning) return;
      const now = Date.now();
      for (const market of this.markets.values()) {
        if (market.isBlacklisted) continue;
        if (!market.quotingActive && market.breakerCooldownUntil > 0) continue; // in breaker cooldown
        const elapsed = now - market.lastBookUpdate;
        if (elapsed > this.config.staleFeedMs && market.quotingActive) {
          this.log(`STALE FEED: ${market.name} — no book update for ${elapsed}ms, pulling quotes`);
          market.quotingActive = false;
          this.cancelMarketOrders(market);

          // Log incident (03 SS8.1)
          this.logger.logIncident({
            ts: now,
            market: market.name,
            trigger: 'stale_feed',
            midBefore: market.mid,
            midAfter60s: null,
            quotesActive: true,
            action: `pull_quotes — silent ${elapsed}ms > ${this.config.staleFeedMs}ms`,
          });

          this.emit('staleFeed', { market: market.name, elapsedMs: elapsed });
        }
      }
    }, checkInterval);
  }

  private stopStaleFeedGuard(): void {
    if (this.staleFeedTimer) {
      clearInterval(this.staleFeedTimer);
      this.staleFeedTimer = null;
    }
  }

  // ============================================================================
  // Orderbook Updates & Requoting
  // ============================================================================

  private handleOrderbookUpdate(book: OrderbookSnapshot): void {
    // Find which market this book belongs to
    const market = this.findMarketByTokenId(book.assetId || book.tokenId);
    if (!market || market.isBlacklisted) return;

    const prevBestBid = market.bestBid;
    const prevBestAsk = market.bestAsk;
    const prevMid = market.mid;

    // Update cached book state (updates mid, microprice, midHistory)
    this.updateBookState(market, book);

    // --- Circuit breaker check (03 SS3.7) ---
    // Must run BEFORE any quoting logic. "Must exist before any real capital."
    if (this.checkCircuitBreaker(market)) {
      return;  // breaker fired — no quoting this update
    }

    // If in cooldown, skip all quoting
    if (this.isInBreakerCooldown(market)) {
      return;
    }

    // --- Phase C: Toxic window check (03 SS2, SS6 Item 8) ---
    // Pause quoting during hours with adverse drift data.
    if (this.isInToxicWindow(market)) {
      if (market.quotingActive) {
        this.log(`TOXIC WINDOW: ${market.name} paused for hour ${new Date().getUTCHours()} UTC`);
        market.quotingActive = false;
        this.cancelMarketOrders(market);
      }
      return;
    }

    // --- Phase C: Queue-position tracking (03 SS3.6, SS6 Item 11) ---
    this.updateQueuePositions(market, book);

    // If quoting was paused (stale feed, etc.) and fresh data just arrived, resume
    if (!market.quotingActive && !market.isBlacklisted) {
      market.quotingActive = true;
      this.log(`Resumed quoting for ${market.name} — fresh data arrived`);
    }

    if (!market.quotingActive) return;

    // Dry-run: check for simulated fills before requoting
    // Pass prevMid so spread PnL is computed against pre-move mid, not post-move mid
    if (this.config.dryRun) {
      this.checkSimulatedFills(market, prevMid);
    }

    // Trigger 0: No resting orders yet -> post initial quotes
    const hasNoQuotes = market.restingBidPrice === 0 && market.restingAskPrice === 0;
    if (hasNoQuotes && market.bestBid > 0 && market.bestAsk > 0) {
      this.requote(market, 'initial quote');
      return;
    }

    // Check requote triggers (03 SS3.7: event-driven, never a timer)
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

    // Trigger 4 (Phase C Item 11): Queue erosion — cancel and requote when deep in queue
    if (!reason && this.shouldCancelForQueueErosion(market, 'BUY')) {
      reason = 'bid queue erosion (>80% consumed)';
    }
    if (!reason && this.shouldCancelForQueueErosion(market, 'SELL')) {
      reason = 'ask queue erosion (>80% consumed)';
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

    // Cache the full book snapshot for queue-position + fronting (Phase C Item 11)
    market.lastBook = book;

    if (book.bids && book.bids.length > 0) {
      market.bestBid = book.bids[0].price;
      market.bestBidSize = book.bids[0].size;  // (03 SS3.1) — needed for microprice
    }
    if (book.asks && book.asks.length > 0) {
      market.bestAsk = book.asks[0].price;
      market.bestAskSize = book.asks[0].size;  // (03 SS3.1) — needed for microprice
    }
    if (market.bestBid > 0 && market.bestAsk > 0) {
      market.mid = (market.bestBid + market.bestAsk) / 2;

      // Microprice centering (03 SS3.1):
      // microprice = (bestBid * askSize + bestAsk * bidSize) / (bidSize + askSize)
      const totalSize = market.bestBidSize + market.bestAskSize;
      if (totalSize > 0) {
        market.microprice =
          (market.bestBid * market.bestAskSize + market.bestAsk * market.bestBidSize) / totalSize;
      } else {
        market.microprice = market.mid;  // fallback when no depth data
      }
    }
    market.lastBookUpdate = Date.now();

    // Track mid history for circuit breaker (03 SS3.7)
    const now = market.lastBookUpdate;
    market.midHistory.push({ ts: now, mid: market.mid });
    // Prune entries older than breakerWindowMs
    const windowStart = now - this.config.breakerWindowMs;
    while (market.midHistory.length > 0 && market.midHistory[0].ts < windowStart) {
      market.midHistory.shift();
    }

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
    market.restingBidPrice = 0;
    market.restingBidSize = 0;
    market.restingAskOrderId = null;
    market.restingAskPrice = 0;
    market.restingAskSize = 0;
  }

  private async postQuotes(market: MMMarketState, quotes: QuoteResult): Promise<void> {
    // Safety gate: refuse to post if circuit breaker is active (03 SS3.7)
    if (this.isInBreakerCooldown(market)) return;

    // Use the cached full book for queue-position recording; fall back to synthetic
    const book: OrderbookSnapshot = market.lastBook || {
      assetId: market.yesTokenId,
      tokenId: market.yesTokenId,
      bids: market.bestBid > 0 ? [{ price: market.bestBid, size: market.bestBidSize }] : [],
      asks: market.bestAsk > 0 ? [{ price: market.bestAsk, size: market.bestAskSize }] : [],
    };

    if (this.config.dryRun) {
      // Simulated: just update state
      if (!quotes.skipBid) {
        market.restingBidPrice = quotes.bidPrice;
        market.restingBidSize = quotes.bidSize;
        this.recordQueuePosition(market, 'BUY', quotes.bidPrice, book);
      }
      if (!quotes.skipAsk) {
        market.restingAskPrice = quotes.askPrice;
        market.restingAskSize = quotes.askSize;
        this.recordQueuePosition(market, 'SELL', quotes.askPrice, book);
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
          market.restingBidSize = quotes.bidSize;
          this.recordQueuePosition(market, 'BUY', quotes.bidPrice, book);
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
          market.restingAskSize = quotes.askSize;
          this.recordQueuePosition(market, 'SELL', quotes.askPrice, book);
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

    // In dry-run: simulate fill when book TRADES THROUGH our resting price (02 §3).
    // Strict inequality (<, >) — touch does NOT fill. This avoids overstating fill rate.
    // Use prevMid (before book update) for spread PnL calculation
    // Use resting sizes (set by asymmetric sizing) rather than a fixed config value
    let filled = false;
    if (market.restingBidPrice > 0 && market.bestAsk < market.restingBidPrice) {
      const fillSize = market.restingBidSize > 0 ? market.restingBidSize : this.config.baseSize;
      this.recordFill(market, 'BUY', market.restingBidPrice, fillSize, prevMid);
      market.restingBidPrice = 0;
      market.restingBidSize = 0;
      market.restingBidOrderId = null;
      filled = true;
    }
    if (!filled && market.restingAskPrice > 0 && market.bestBid > market.restingAskPrice) {
      const fillSize = market.restingAskSize > 0 ? market.restingAskSize : this.config.baseSize;
      this.recordFill(market, 'SELL', market.restingAskPrice, fillSize, prevMid);
      market.restingAskPrice = 0;
      market.restingAskSize = 0;
      market.restingAskOrderId = null;
      filled = true;
    }
    if (filled) {
      this.lastFillTime.set(market.conditionId, now);
    }
  }

  private recordFill(market: MMMarketState, side: 'BUY' | 'SELL', price: number, size: number, midOverride?: number): void {
    const prevInventory = market.inventory;

    // Update inventory and cost basis (VWAP entry price for kill switch)
    if (side === 'BUY') {
      if (market.inventory >= 0) {
        // Adding to long: VWAP
        const totalCost = market.costBasis * market.inventory + price * size;
        market.inventory += size;
        market.costBasis = market.inventory > 0 ? totalCost / market.inventory : 0;
      } else {
        // Covering short
        market.inventory += size;
        if (market.inventory <= 0) {
          // Still short — costBasis unchanged
        } else {
          // Flipped to long — new cost basis is this fill price
          market.costBasis = price;
        }
      }
    } else {
      if (market.inventory <= 0) {
        // Adding to short: VWAP (track as positive price for comparison)
        const totalCost = market.costBasis * Math.abs(market.inventory) + price * size;
        market.inventory -= size;
        market.costBasis = market.inventory < 0 ? totalCost / Math.abs(market.inventory) : 0;
      } else {
        // Reducing long
        market.inventory -= size;
        if (market.inventory >= 0) {
          // Still long — costBasis unchanged
        } else {
          // Flipped to short — new cost basis is this fill price
          market.costBasis = price;
        }
      }
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

    // Phase C: Track spread capture bps for edgeScore (Item 9)
    const spreadCaptureBps = midForSpread > 0 ? (spreadCaptured / midForSpread) * 10000 : 0;
    market.totalFills++;
    market.sumSpreadCaptureBps += spreadCaptureBps;
    market.meanSpreadCaptureBps = market.sumSpreadCaptureBps / market.totalFills;

    this.stats.fills++;
    this.stats.dailyFills++;
    const fillTs = Date.now();

    // Phase C: Queue position at post (Item 11, 03 SS8.1)
    const queuePosAtPost = this.getQueuePosAtPost(market, side);

    this.emit('fill', {
      market: market.name,
      side,
      price,
      size,
      inventoryAfter: market.inventory,
      spreadPnL: spreadCaptured * size,
      rebateIncome: fillRebateIncome,
      hourBucket: MmLogger.hourBucket(fillTs),
    });

    // Log fill to JSONL (03 SS8.1, SS6 Phase A item 3: "fill-to-mark logging from day one")
    const fillRecord: FillRecord = {
      ts: fillTs,
      market: market.name,
      conditionId: market.conditionId,
      side,
      fillPrice: price,
      fillSizeShares: size,
      inventoryAfter: market.inventory,
      queuePosAtPost,  // Phase C: populated by queue-position tracking (03 SS8.1)
      hourBucket: MmLogger.hourBucket(fillTs),
      mid5s: null,            // backfilled by sampler (03 SS8.2)
      mid15s: null,
      mid30s: null,
      driftBps15s: null,
      configHash: this.configHash,
    };
    this.logger.logFill(fillRecord);

    // Start fill-to-mark sampling (backfills mid5s/mid15s/mid30s into the JSONL record)
    this.startFillToMarkSampling(market, side, price, fillTs);

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

  private startFillToMarkSampling(market: MMMarketState, side: 'BUY' | 'SELL', fillPrice: number, fillTs?: number): void {
    const ts = fillTs ?? Date.now();
    const sample: FillToMarkSample = {
      fillTime: ts,
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

    // Map delay index to backfill field name for JSONL backfill (03 SS8.2)
    const delayToField: Record<number, 'mid5s' | 'mid15s' | 'mid30s'> = {};
    const delays = this.config.fillToMarkDelaysMs;
    if (delays.length >= 1) delayToField[0] = 'mid5s';
    if (delays.length >= 2) delayToField[1] = 'mid15s';
    if (delays.length >= 3) delayToField[2] = 'mid30s';

    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 0; i < sample.driftDelaysMs.length; i++) {
      const timer = setTimeout(() => {
        const currentMid = market.mid;
        const sign = sample.fillSide === 'BUY' ? 1 : -1;
        sample.driftBps[i] = ((currentMid - sample.fillPrice) / sample.fillPrice) * 10000 * sign;

        // Backfill the JSONL fill record with the mid sample (03 SS8.2)
        const fieldName = delayToField[i];
        if (fieldName) {
          this.logger.backfillFillMids(
            market.conditionId,
            ts,
            { [fieldName]: currentMid > 0 ? currentMid : null },
          );
        }

        if (sample.driftBps.every(d => d !== null)) {
          sample.completed = true;
          this.updateRollingDrift(market);
          this.emit('fillToMark', sample);
        }
      }, sample.driftDelaysMs[i]);
      timers.push(timer);
    }

    const key = `${market.conditionId}-${ts}`;
    this.fillTimers.set(key, timers);
  }

  private updateRollingDrift(market: MMMarketState): void {
    const completed = market.fillToMarkSamples.filter(s => s.completed);
    if (completed.length === 0) return;

    // Use last 20 completed samples, take mean of +15s drift (the god metric, 03 §7.2).
    // Index 1 in the standard [5000, 15000, 30000] delays array.
    const recent = completed.slice(-20);
    const driftIndex = Math.min(1, this.config.fillToMarkDelaysMs.length - 1);
    const drifts = recent
      .map(s => s.driftBps[driftIndex])
      .filter((d): d is number => d !== null);

    if (drifts.length === 0) return;
    market.rollingDriftBps = drifts.reduce((a, b) => a + b, 0) / drifts.length;

    // Phase C Item 8: Record the most recent completed sample's drift into hourly bucket
    const lastCompleted = completed[completed.length - 1];
    const lastDrift = lastCompleted.driftBps[driftIndex];
    if (lastDrift !== null) {
      const hourBucket = new Date(lastCompleted.fillTime).getUTCHours();
      this.recordHourlyDrift(market, hourBucket, lastDrift);
    }

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
    // Unrealized loss: difference between entry (costBasis) and current mid,
    // sign-correct for both long and short positions.
    // Long (inventory > 0): loss when mid < costBasis → (costBasis - mid) * inventory
    // Short (inventory < 0): loss when mid > costBasis → (mid - costBasis) * |inventory|
    const unrealizedLoss = market.inventory > 0
      ? (market.costBasis - market.mid) * market.inventory
      : (market.mid - market.costBasis) * Math.abs(market.inventory);

    if (unrealizedLoss > 0 && exposureUsd > 0 && unrealizedLoss > exposureUsd * this.config.killSwitchLossPct) {
      this.log(`KILL SWITCH: ${market.name} unrealized loss $${unrealizedLoss.toFixed(2)} > ${(this.config.killSwitchLossPct * 100).toFixed(0)}% of exposure $${exposureUsd.toFixed(2)}`);
      market.quotingActive = false;
      market.isBlacklisted = true;
      market.blacklistReason = 'kill switch: unrealized loss';
      this.cancelMarketOrders(market);

      // Flatten inventory (03 §4: "cancel all, flatten, blacklist for session")
      this.flattenPosition(market, unrealizedLoss, exposureUsd);

      this.emit('marketBlacklisted', { market: market.name, reason: market.blacklistReason });
    }
  }

  /**
   * Flatten a position after kill switch fires. Sends a taker order to close
   * the inventory, or simulates the flatten in dry-run mode. Logs the incident
   * with flatten details. (03 §4)
   */
  private flattenPosition(market: MMMarketState, unrealizedLoss: number, exposureUsd: number): void {
    const side = market.inventory > 0 ? 'SELL' : 'BUY';
    const size = Math.abs(market.inventory);
    // For flatten, use the worse side of the book (we're taking liquidity)
    const flattenPrice = side === 'SELL' ? market.bestBid : market.bestAsk;

    if (!this.config.dryRun && this.tradingService && flattenPrice > 0) {
      // Live mode: send FOK taker order to flatten
      this.tradingService.createMarketOrder({
        tokenId: market.yesTokenId,
        side: side === 'BUY' ? 'BUY' : 'SELL',
        amount: size,
        orderType: 'FOK',
      }).then(() => {
        this.log(`FLATTEN: ${market.name} ${side} ${size} shares @ ~${flattenPrice} (FOK sent)`);
      }).catch((err) => {
        this.log(`FLATTEN FAILED: ${market.name} — ${(err as Error).message}. Inventory still open.`);
      });
    } else {
      // Dry-run: simulate flatten at current book price with taker fee
      const flattenFee = calculateTakerFee(size, flattenPrice, market.feeCategory);
      this.log(`FLATTEN (simulated): ${market.name} ${side} ${size} shares @ ${flattenPrice}, taker fee $${flattenFee.toFixed(4)}`);
      // Record the simulated flatten as a fill so PnL reflects the exit
      if (flattenPrice > 0) {
        this.recordFill(market, side as 'BUY' | 'SELL', flattenPrice, size);
      }
    }

    this.logger.logIncident({
      ts: Date.now(),
      market: market.name,
      trigger: 'kill_switch',
      midBefore: market.costBasis,
      midAfter60s: null,
      quotesActive: false,
      action: `kill+flatten — loss $${unrealizedLoss.toFixed(2)} (${(unrealizedLoss / exposureUsd * 100).toFixed(1)}%) > ${(this.config.killSwitchLossPct * 100).toFixed(0)}% cap, ${side} ${size}@${flattenPrice}`,
    });
  }

  // ============================================================================
  // Phase C: Rebate-Aware Dynamic Spread Floors (03 SS3.5, SS6 Item 10)
  // ============================================================================

  /**
   * Compute the dynamic break-even spread floor for a market, accounting for
   * maker rebate income. Higher-rebate categories can afford tighter spreads.
   *
   * Per 03 SS3.5: "Compute minSpreadTicks per category from the live fee formula
   * + rebate share and quote down to it only where the rebate supports it."
   *
   * Returns the larger of: dynamic break-even floor, configured per-category floor.
   */
  computeDynamicMinSpreadTicks(market: MMMarketState): number {
    const configFloor = this.getMinSpreadTicks(market.feeCategory);

    if (!this.config.dynamicSpreadFloors) return configFloor;

    const dynamicFloor = computeBreakEvenSpreadTicks(
      market.feeCategory,
      market.mid,
      market.tickSize,
    );

    // The configured floor is the hard minimum; dynamic floor adds cost-awareness
    return Math.max(configFloor, dynamicFloor);
  }

  /**
   * Check rebate reconciliation: flag divergence > threshold between modeled
   * and actual rebate income. Per 03 SS7.2: "Realized vs. modeled rebates
   * within 20% (worse = re-check fee model or market mix)."
   *
   * @returns Object with divergence info, or null if no actual data yet.
   */
  checkRebateReconciliation(market: MMMarketState): {
    modeled: number;
    actual: number;
    divergencePct: number;
    flagged: boolean;
  } | null {
    if (market.actualRebateIncome <= 0) return null; // no actual data yet

    const divergence = Math.abs(market.modeledRebateIncome - market.actualRebateIncome);
    const divergencePct = market.modeledRebateIncome > 0
      ? divergence / market.modeledRebateIncome
      : (market.actualRebateIncome > 0 ? 1.0 : 0);

    const flagged = divergencePct > this.config.rebateDivergenceThreshold;

    if (flagged) {
      this.log(`REBATE DIVERGENCE: ${market.name} modeled=$${market.modeledRebateIncome.toFixed(4)} actual=$${market.actualRebateIncome.toFixed(4)} divergence=${(divergencePct * 100).toFixed(1)}% > ${(this.config.rebateDivergenceThreshold * 100).toFixed(0)}%`);

      this.logger.logIncident({
        ts: Date.now(),
        market: market.name,
        trigger: 'rebate_divergence',
        midBefore: null,
        midAfter60s: null,
        quotesActive: market.quotingActive,
        action: `modeled=$${market.modeledRebateIncome.toFixed(4)} actual=$${market.actualRebateIncome.toFixed(4)} divergence=${(divergencePct * 100).toFixed(1)}%`,
      });
    }

    return {
      modeled: market.modeledRebateIncome,
      actual: market.actualRebateIncome,
      divergencePct,
      flagged,
    };
  }

  // ============================================================================
  // Phase C: Per-Market Per-Hour Drift Schedule (03 SS2, SS6 Item 8)
  // ============================================================================

  /**
   * Per-hour drift bucket structure for a single market.
   * Stores running count and sum for computing mean drift per UTC hour.
   *
   * Per 03 SS2: "Segment fill-to-mark drift by hour-of-day (UTC buckets)...
   * Once data exists, quote each market only in its non-toxic windows."
   */

  /**
   * Record a completed drift sample into the per-hour bucket.
   * Called when fill-to-mark sampling completes (+15s drift available).
   */
  recordHourlyDrift(market: MMMarketState, hourBucket: number, driftBps: number): void {
    const bucket = market.hourlyDrift.get(hourBucket) ?? { count: 0, sumDriftBps: 0 };
    bucket.count++;
    bucket.sumDriftBps += driftBps;
    market.hourlyDrift.set(hourBucket, bucket);
  }

  /**
   * Check if the current UTC hour is a toxic window for this market.
   *
   * Per 03 SS2: "A market can be benign at 03:00 UTC and toxic during US market
   * hours. Once data exists, quote each market only in its non-toxic windows."
   *
   * Gated behind minFillsPerBucket: requires sufficient data before acting.
   *
   * @param market - Market state
   * @param hour - UTC hour (0-23), defaults to current hour
   * @returns true if the hour is toxic (drift < threshold with sufficient data)
   */
  isInToxicWindow(market: MMMarketState, hour?: number): boolean {
    const h = hour ?? new Date().getUTCHours();
    const bucket = market.hourlyDrift.get(h);

    // Not enough data: not toxic (03 SS6 Item 8: gate behind minimum sample count)
    if (!bucket || bucket.count < this.config.minFillsPerBucket) return false;

    const meanDrift = bucket.sumDriftBps / bucket.count;
    return meanDrift < this.config.toxicDriftThresholdBps;
  }

  /**
   * Get drift statistics for all hour-buckets of a market.
   * Used for observability (dashboard, logging, daily ranking).
   */
  getHourlyDriftStats(market: MMMarketState): Array<{
    hour: number;
    count: number;
    meanDriftBps: number;
    isToxic: boolean;
  }> {
    const stats: Array<{ hour: number; count: number; meanDriftBps: number; isToxic: boolean }> = [];
    for (let h = 0; h < 24; h++) {
      const bucket = market.hourlyDrift.get(h);
      if (bucket && bucket.count > 0) {
        const mean = bucket.sumDriftBps / bucket.count;
        stats.push({
          hour: h,
          count: bucket.count,
          meanDriftBps: mean,
          isToxic: this.isInToxicWindow(market, h),
        });
      }
    }
    return stats;
  }

  // ============================================================================
  // Phase C: EdgeScore Continuous Capital Allocator (03 SS2, SS6 Item 9)
  // ============================================================================

  /**
   * Compute the edgeScore for a market.
   *
   * Per 03 SS2: "edgeScore(market) = E[spreadCapture bps/fill] + rebate bps/fill
   * + meanDriftBps. Allocate quote size proportional to edgeScore, re-ranked daily."
   *
   * Gated behind minFillsForEdgeScore: returns 0 if insufficient data.
   */
  computeEdgeScore(market: MMMarketState): number {
    if (market.totalFills < this.config.minFillsForEdgeScore) return 0;

    // Component 1: mean spread capture in bps
    const spreadCaptureBps = market.meanSpreadCaptureBps;

    // Component 2: rebate bps per fill
    const rebateBps = computeRebateBpsPerFill(market.feeCategory, market.mid);

    // Component 3: mean drift bps (the god metric)
    const driftBps = market.rollingDriftBps;

    return spreadCaptureBps + rebateBps + driftBps;
  }

  /**
   * Recompute edgeScores for all markets and store on state.
   * Per 03 SS2: "re-ranked daily." Called at daily snapshot time.
   */
  recomputeEdgeScores(): void {
    for (const market of this.markets.values()) {
      market.edgeScore = this.computeEdgeScore(market);
    }
    this.log(`EdgeScores recomputed: ${Array.from(this.markets.values()).map(m => `${m.name.slice(0, 30)}=${m.edgeScore.toFixed(1)}`).join(', ')}`);
  }

  /**
   * Compute the size multiplier for a market based on its edgeScore relative
   * to the maximum edgeScore across all active markets.
   *
   * Per 03 SS2: "Allocate quote size proportional to edgeScore."
   * Returns 1.0 if edgeScore is not yet active (insufficient data).
   * Returns a value in [0.1, 1.0] when active — never fully zero (blacklist handles that).
   */
  getEdgeScoreSizeMultiplier(market: MMMarketState): number {
    // If this market lacks enough fills, don't scale (use full baseSize)
    if (market.totalFills < this.config.minFillsForEdgeScore) return 1.0;

    // A market with proven negative edge gets minimum sizing (03 SS2: "capital drains
    // out of decaying markets continuously, weeks before the blacklist would trip")
    if (market.edgeScore <= 0) return 0.1;

    // Find max edgeScore among markets with enough fills
    let maxScore = 0;
    for (const m of this.markets.values()) {
      if (m.totalFills >= this.config.minFillsForEdgeScore && m.edgeScore > maxScore) {
        maxScore = m.edgeScore;
      }
    }

    // If all scores are zero or negative, floor everyone (shouldn't reach here due to
    // early return above, but defensive)
    if (maxScore <= 0) return 0.1;

    // Proportional scaling with floor of 0.1 (blacklist is the hard zero)
    const ratio = market.edgeScore / maxScore;
    return Math.max(0.1, Math.min(1.0, ratio));
  }

  // ============================================================================
  // Phase C: Queue-Position Tracking (03 SS3.6, SS6 Item 11)
  // ============================================================================

  /**
   * Record queue position when we post an order at a given price level.
   *
   * Per 03 SS3.6: "Track estimated queue position: sizeAheadAtPost −
   * tradedVolumeSince."
   *
   * @param market - Market state
   * @param side - 'BUY' or 'SELL'
   * @param price - Price level we posted at
   * @param book - Current orderbook snapshot to measure queue depth
   */
  recordQueuePosition(
    market: MMMarketState,
    side: 'BUY' | 'SELL',
    price: number,
    book: OrderbookSnapshot,
  ): void {
    if (side === 'BUY') {
      // For bid: count size at this price level ahead of us
      const sizeAhead = this.computeSizeAheadAtLevel(book.bids || [], price);
      market.sizeAheadAtPostBid = sizeAhead;
      market.queuePosBid = sizeAhead;
      market.queueTrackBidPrice = price;
    } else {
      const sizeAhead = this.computeSizeAheadAtLevel(book.asks || [], price);
      market.sizeAheadAtPostAsk = sizeAhead;
      market.queuePosAsk = sizeAhead;
      market.queueTrackAskPrice = price;
    }
  }

  /**
   * Compute total size at a given price level from a book side.
   */
  private computeSizeAheadAtLevel(
    levels: Array<{ price: number; size: number }>,
    targetPrice: number,
  ): number {
    let total = 0;
    for (const level of levels) {
      if (Math.abs(level.price - targetPrice) < 1e-8) {
        total += level.size;
      }
    }
    return total;
  }

  /**
   * Update queue position estimates based on observed book changes.
   * Call on each orderbook update to decrement queue estimates.
   *
   * Per 03 SS3.6: "sizeAheadAtPost - tradedVolumeSince"
   * If the level size decreased, that volume likely traded ahead of us.
   */
  updateQueuePositions(market: MMMarketState, book: OrderbookSnapshot): void {
    // Bid side queue tracking
    if (market.queueTrackBidPrice > 0 && market.restingBidPrice > 0) {
      const currentSizeAtLevel = this.computeSizeAheadAtLevel(
        book.bids || [],
        market.queueTrackBidPrice,
      );
      // If level size decreased, approximate that as volume traded ahead of us
      if (currentSizeAtLevel < market.queuePosBid) {
        market.queuePosBid = Math.max(0, currentSizeAtLevel);
      }
    }

    // Ask side queue tracking
    if (market.queueTrackAskPrice > 0 && market.restingAskPrice > 0) {
      const currentSizeAtLevel = this.computeSizeAheadAtLevel(
        book.asks || [],
        market.queueTrackAskPrice,
      );
      if (currentSizeAtLevel < market.queuePosAsk) {
        market.queuePosAsk = Math.max(0, currentSizeAtLevel);
      }
    }
  }

  /**
   * Check if we should cancel due to deep-in-queue position (eroding level).
   *
   * Per 03 SS3.6: "Deep in queue at an eroding level -> cancel.
   * The only fill left there is the toxic sweep."
   *
   * @returns true if we should cancel and requote (level is eroding away)
   */
  shouldCancelForQueueErosion(market: MMMarketState, side: 'BUY' | 'SELL'): boolean {
    const threshold = this.config.queueCancelThreshold;

    if (side === 'BUY') {
      if (market.sizeAheadAtPostBid <= 0) return false;
      // How much of the original level has been consumed?
      const consumed = 1 - (market.queuePosBid / market.sizeAheadAtPostBid);
      return consumed >= threshold;
    } else {
      if (market.sizeAheadAtPostAsk <= 0) return false;
      const consumed = 1 - (market.queuePosAsk / market.sizeAheadAtPostAsk);
      return consumed >= threshold;
    }
  }

  /**
   * Front-vs-join decision for quote placement.
   *
   * Per 03 SS3.6: "Prefer fronting a new tick (one tick inside, front of empty
   * queue) over joining the back of a crowd, when spread permits."
   *
   * @returns The preferred price if fronting is better, or null to keep current price.
   */
  computeFrontingPrice(
    market: MMMarketState,
    side: 'BUY' | 'SELL',
    currentPrice: number,
    book: OrderbookSnapshot,
  ): number | null {
    const tickSize = parseFloat(market.tickSize);

    if (side === 'BUY') {
      // Only consider fronting if our quote would join an existing crowded level
      const sizeAtCurrent = this.computeSizeAheadAtLevel(book.bids || [], currentPrice);
      if (sizeAtCurrent <= this.config.baseSize * 2) return null;  // not crowded enough

      // Check if a tick better (higher bid) has little/no queue
      const betterPrice = currentPrice + tickSize;
      // Don't front if it would cross the spread
      if (betterPrice >= market.bestAsk) return null;
      const sizeAtBetter = this.computeSizeAheadAtLevel(book.bids || [], betterPrice);
      // Front if the better tick is empty/thin
      if (sizeAtBetter < sizeAtCurrent * 0.2) {
        return roundPrice(betterPrice, market.tickSize, 'floor');
      }
    } else {
      // Only consider fronting if our quote would join an existing crowded level
      const sizeAtCurrent = this.computeSizeAheadAtLevel(book.asks || [], currentPrice);
      if (sizeAtCurrent <= this.config.baseSize * 2) return null;  // not crowded enough

      // Check if a tick better (lower ask) has little/no queue
      const betterPrice = currentPrice - tickSize;
      if (betterPrice <= market.bestBid) return null;
      const sizeAtBetter = this.computeSizeAheadAtLevel(book.asks || [], betterPrice);
      // Front if the better tick is empty/thin
      if (sizeAtBetter < sizeAtCurrent * 0.2) {
        return roundPrice(betterPrice, market.tickSize, 'ceil');
      }
    }

    return null;
  }

  /**
   * Get the current queue position estimate for a fill record.
   * Per 03 SS8.1: "queuePosAtPost: null during Phases A and B; populated
   * when Phase C queue-position tracking comes online."
   * Returns null when tracking hasn't been initialized (no post recorded).
   */
  getQueuePosAtPost(market: MMMarketState, side: 'BUY' | 'SELL'): number | null {
    if (side === 'BUY') {
      return market.queueTrackBidPrice > 0 ? market.sizeAheadAtPostBid : null;
    }
    return market.queueTrackAskPrice > 0 ? market.sizeAheadAtPostAsk : null;
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

  // ============================================================================
  // Daily Snapshot (03 SS8.1)
  // ============================================================================

  /**
   * Schedule a daily snapshot at UTC midnight.
   * Per 03 SS8.1: "Snapshots — Daily (end of UTC day)"
   */
  private scheduleDailySnapshot(): void {
    const now = new Date();
    const nextMidnightUtc = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0, 0, 0, 0,
    ));
    const msUntilMidnight = nextMidnightUtc.getTime() - now.getTime();

    this.snapshotTimer = setTimeout(() => {
      if (this.isRunning) {
        this.writeDailySnapshot();
        // Re-schedule for next day
        this.scheduleDailySnapshot();
      }
    }, msUntilMidnight);
  }

  /**
   * Write the end-of-day snapshot to logs/snapshots.jsonl.
   * Accessible for testing and manual triggering.
   */
  writeDailySnapshot(): void {
    const markets = Array.from(this.markets.values());
    const activeMarkets = markets.filter(m => m.quotingActive);

    // Collect all completed drift samples for mean calculation
    const allDrifts: number[] = [];
    let worstDrift: number | null = null;

    for (const market of markets) {
      const completed = market.fillToMarkSamples.filter(s => s.completed);
      // Use the +15s drift (index 1 in default [5000, 15000, 30000])
      const driftIndex = Math.min(1, this.config.fillToMarkDelaysMs.length - 1);
      for (const s of completed) {
        const d = s.driftBps[driftIndex];
        if (d !== null) {
          allDrifts.push(d);
          if (worstDrift === null || d < worstDrift) {
            worstDrift = d;
          }
        }
      }
    }

    const meanDrift = allDrifts.length > 0
      ? allDrifts.reduce((a, b) => a + b, 0) / allDrifts.length
      : null;

    // Net PnL and gross exposure
    let netPnlUsd = 0;
    let grossExposureUsd = 0;
    let rebateAccruedUsd = 0;
    for (const market of markets) {
      netPnlUsd += market.realizedSpreadPnL + market.modeledRebateIncome + market.inventoryMtM;
      grossExposureUsd += Math.abs(market.inventory) * market.mid;
      rebateAccruedUsd += market.modeledRebateIncome;
    }

    // Date is yesterday (we're writing at UTC midnight for the day that just ended)
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const dateStr = yesterday.toISOString().slice(0, 10);

    this.logger.logSnapshot({
      date: dateStr,
      configHash: this.configHash,
      regime: this.config.regime,
      stage: this.config.stage,
      marketsQuoted: activeMarkets.length,
      totalFills: this.stats.dailyFills,
      meanDrift15sBps: meanDrift,
      netPnlUsd,
      grossExposureUsd,
      worstMarketDrift: worstDrift,
      rebateAccruedUsd,
    });

    this.stats.dailyFills = 0;  // Reset for next day

    // Phase C Item 9: recompute edgeScores daily (per 03 SS2: "re-ranked daily")
    this.recomputeEdgeScores();

    this.log(`Daily snapshot written: ${dateStr}`);
  }

  // --------------------------------------------------------------------------
  // Public accessor for the logger (Phase B will use logIncident)
  // --------------------------------------------------------------------------

  getLogger(): MmLogger {
    return this.logger;
  }
}
