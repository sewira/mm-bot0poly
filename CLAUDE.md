# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Polymarket Trading Bot (v3.1) — a TypeScript SDK + multi-strategy trading bot for Polymarket prediction markets, with a real-time React dashboard. The SDK package is `@catalyst-team/poly-sdk`.

The bot runs four strategies (smart money copy trading, arbitrage, dip arbitrage, market making) plus a market-making service built on Avellaneda-Stoikov inventory-skewed quoting. All strategies share a unified risk management layer with multi-timeframe loss limits and dynamic position sizing.

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

No linter or formatter is configured.

## Architecture

### SDK Layer (`src/`)

**Entry point**: `src/index.ts` — exports everything. `PolymarketSDK` is the main facade class.

**Initialization pattern** (bot-with-dashboard.ts uses this):
```typescript
const sdk = new PolymarketSDK({ privateKey: '0x...' });
await sdk.initialize();
// ws-live-data connected separately only when non-MM strategies enabled:
// sdk.connect(); await sdk.waitForConnection(10000);
```
Legacy: `await PolymarketSDK.create(config)` still works (calls initialize + connect internally).

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
- `market-making-service.ts` — Inventory-skewed quoting (microprice centering, convex skew, circuit breaker)
- `wallet-service.ts` — Trader profiling and analysis
- `binance-service.ts` — K-line technical analysis
- `onchain-service.ts` — Unified on-chain ops (CTF + Authorization + Swaps)
- `swap-service.ts` — DEX swaps (MATIC/USDC/USDC.e)
- `authorization-service.ts` — ERC20/ERC1155 approvals

**Utilities** (`src/utils/`): `fee-utils.ts` is critical — implements Polymarket's taker fee formula (`shares × feeRate × price × (1 − price)`) with per-category rates and rebate logic. `price-utils.ts` has pricing helpers.

**Core infra** (`src/core/`): `rate-limiter.ts`, `cache.ts`, `unified-cache.ts`, `errors.ts` (custom `PolymarketError` with `ErrorCode` enum, `withRetry` utility), `types.ts`.

### Bot Layer (root)

- `bot-with-dashboard.ts` — Main entry: orchestrates all strategies + risk management + dashboard server
- `bot-config.ts` — Configuration loaded from `.env` (standalone bot without dashboard)

Both files embed their own `CONFIG` object inline rather than sharing a config module.

### Dashboard (`dashboard/`)

React + Vite + Tailwind frontend. Communicates with bot via WebSocket. Components in `dashboard/src/components/`. Must be built (`npm run build` in `dashboard/`) before running the bot. Dashboard types are in `src/dashboard/types.ts` (bot-side) and `dashboard/src/types.ts` (frontend-side).

### Scripts (`scripts/`)

Operational utility scripts organized by subsystem: `api-verification/`, `approvals/`, `arb/`, `arb-tests/`, `benchmark/`, `deposit/`, `dip-arb/`, `smart-money/`, `rescue/`, `wallet/`. Run individually with `npx tsx scripts/<path>`.

### Strategy Documentation (`docs/`)

The market-making strategy is governed by a doc hierarchy:
- `docs/00_MASTER_PLAN.md` — Overall roadmap and stage gates
- `docs/01_MARKET_MAKING_SPEC.md` — Original MM specification
- `docs/02_VALIDATION_AND_TESTING.md` — Backtest and dry-run requirements
- `docs/03_MM_STRATEGY_V2.md` — **Current active strategy** (supersedes quoting logic in 01). Covers microprice centering, convex inventory skew, fill-to-mark drift, circuit breaker, and quoting schedule.

### Key Types

- `BotState` — Central state object passed to dashboard via WebSocket (PnL, balances, positions, strategy states, risk limits)
- `PolySDKOptions` / `PolymarketSDKConfig` — SDK constructor config
- `UnifiedMarket`, `ProcessedOrderbook` — Core market data types in `src/core/types.ts`
- `FeeCategory` — 11 Polymarket market categories with different fee/rebate rates (defined in `src/utils/fee-utils.ts`)

## MM Agent Team

Five specialized Claude Code subagents manage the market-making lifecycle (defined in `.claude/agents/`). They follow a separation-of-powers model: the builder never grades its own work, the grader never proposes strategy fixes.

| Agent | Role |
|---|---|
| **mm-strategist** | Evaluates/proposes strategy changes; verdicts: ADOPT / TEST FIRST / REJECT |
| **mm-builder** | Implements per build-plan phases A→D; safety code before features |
| **mm-grader** | Computes report card from logs; binary PASS/FAIL on stage gates |
| **mm-reviewer** | Runs daily/weekly/monthly review rituals; keeps decision journal |
| **mm-librarian** | Propagates changes across docs/skill/agents after any update |

Additionally, **polymarket-quant** is a read-only code auditor for profitability flaws (missing fees, look-ahead bias, etc.).

The `polymarket-strategy` skill (`.claude/skills/polymarket-strategy/SKILL.md`) contains the domain knowledge — fee model, edge classification, validation requirements, and go-live/kill gates. mm-librarian is the only agent that edits it.

**Change loop**: idea → mm-strategist (verdict) → edit docs → mm-librarian (propagate) → mm-builder (implement) → mm-grader (measure) → mm-reviewer (grade prediction)

All agent parameters live in the docs and skill file, not in agent prompts. Change the doc once and every agent picks up the new behavior.

## Configuration

All config via `.env` (see `.env.example`). Key variables:
- `POLYMARKET_PRIVATE_KEY` — Wallet private key
- `CAPITAL_USD` — Risk budget
- `DRY_RUN` — Simulation mode toggle
- `LIVE_TRADING_CONFIRMED` — Safety gate for live execution
- `ARBITRAGE_ENABLED`, `DIPARB_ENABLED`, `SMARTMONEY_ENABLED`, `MM_ENABLED` — Strategy toggles
- Risk limits: `DAILY_MAX_LOSS_PCT`, `MONTHLY_MAX_LOSS_PCT`, `MAX_DRAWDOWN_PCT`, `TOTAL_MAX_LOSS_PCT`

## TypeScript

- Strict mode, target ES2022, ESNext modules, bundler resolution
- Uses `ethers` v5 (not v6)
- `.js` extensions in imports (ESM)
- Tests use vitest with `globals: true`
