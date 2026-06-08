# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Polymarket Trading Bot (v3.1) — a TypeScript SDK + multi-strategy trading bot for Polymarket prediction markets, with a real-time React dashboard. The SDK package is `@catalyst-team/poly-sdk`.

## Commands

```bash
# Install
npm install
cd dashboard && npm install && npm run build && cd ..

# Build SDK
npm run build          # tsc → dist/

# Run bot
npx tsx bot-with-dashboard.ts    # Main bot with dashboard on port 3001

# Tests
npm run test                     # Unit tests (vitest, src/**/*.test.ts)
npm run test:watch               # Watch mode
npm run test:integration         # Integration tests (60s timeout, hits real APIs)

# Run a single test file
npx vitest run src/utils/price-utils.test.ts

# Examples (13 available, see package.json for full list)
npm run example:basic
npm run example:live-arb
```

## Architecture

### SDK Layer (`src/`)

**Entry point**: `src/index.ts` — exports everything. `PolymarketSDK` is the main facade class.

**Initialization pattern**:
```typescript
const sdk = await PolymarketSDK.create({ privateKey: '0x...' });
// or: new PolymarketSDK(config) → await sdk.start()
```

**API Clients** (`src/clients/`): Low-level HTTP/GraphQL wrappers.
- `data-api.ts` — Polymarket Data API (positions, activity, trades, leaderboard)
- `gamma-api.ts` — Gamma API (markets, events, search)
- `ctf-client.ts` — Conditional Token Framework (split/merge/redeem on-chain)
- `bridge-client.ts` — Cross-chain deposits
- `subgraph.ts` — Goldsky subgraph queries

**Services** (`src/services/`): Business logic, each service is event-driven (EventEmitter pattern).
- `trading-service.ts` — Order execution (FOK, FAK, GTC, GTD), CLOB client wrapper
- `market-service.ts` — Market data aggregation, merges Gamma + CLOB data
- `realtime-service-v2.ts` — WebSocket manager for orderbooks, activities, prices
- `arbitrage-service.ts` — Real-time arbitrage detection (YES+NO < $1 opportunities)
- `dip-arb-service.ts` — Dip arbitrage on 15-min crypto markets; types in `dip-arb-types.ts`
- `smart-money-service.ts` — Copy trading from leaderboard wallets
- `wallet-service.ts` — Trader profiling and analysis
- `binance-service.ts` — K-line technical analysis
- `onchain-service.ts` — Unified on-chain ops (CTF + Authorization + Swaps)
- `swap-service.ts` — DEX swaps (MATIC/USDC/USDC.e)
- `authorization-service.ts` — ERC20/ERC1155 approvals

**Core infra** (`src/core/`): `rate-limiter.ts`, `cache.ts`, `unified-cache.ts`, `errors.ts` (custom `PolymarketError` with `ErrorCode` enum, `withRetry` utility), `types.ts`.

### Bot Layer (root)

- `bot-with-dashboard.ts` — Main entry: orchestrates all 4 strategies + risk management + dashboard server
- `bot-config.ts` — Configuration loaded from `.env`

### Dashboard (`dashboard/`)

React + Vite + Tailwind frontend. Communicates with bot via WebSocket. Components in `dashboard/src/components/`. Must be built (`npm run build` in `dashboard/`) before running the bot.

### Key Types

- `BotState` — Central state object passed to dashboard via WebSocket (PnL, balances, positions, strategy states, risk limits)
- `PolySDKOptions` / `PolymarketSDKConfig` — SDK constructor config
- `UnifiedMarket`, `ProcessedOrderbook` — Core market data types in `src/core/types.ts`

## Configuration

All config via `.env` (see `.env.example`). Key variables:
- `POLYMARKET_PRIVATE_KEY` — Wallet private key
- `CAPITAL_USD` — Risk budget
- `DRY_RUN` — Simulation mode toggle
- `ARBITRAGE_ENABLED`, `DIPARB_ENABLED`, `SMARTMONEY_ENABLED` — Strategy toggles
- Risk limits: `DAILY_MAX_LOSS_PCT`, `MONTHLY_MAX_LOSS_PCT`, `MAX_DRAWDOWN_PCT`, `TOTAL_MAX_LOSS_PCT`

## TypeScript

- Strict mode, target ES2022, ESNext modules, bundler resolution
- Uses `ethers` v5 (not v6)
- `.js` extensions in imports (ESM)
- Tests use vitest with `globals: true`
