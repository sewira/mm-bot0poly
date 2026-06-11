/**
 * Market Making Logger — append-only JSONL logs
 *
 * Implements the four-log record system from 03_MM_STRATEGY_V2.md SS8:
 *   1. Fills      (logs/fills.jsonl)
 *   2. Snapshots  (logs/snapshots.jsonl)
 *   3. Incidents  (logs/incidents.jsonl)
 *   4. Journal    (logs/journal.jsonl)
 *
 * Plus the configHash utility (SS8.1):
 *   - SHA-256 of MarketMakingConfig with keys sorted deterministically
 *   - Truncated to first 12 hex characters
 *   - Full config saved to logs/configs/{hash}.json on every hash change
 *
 * Integrity rules (SS8.2):
 *   - No UPDATE path. History is corrected by appending a new entry with a
 *     `corrects` field, never by editing.
 *   - mid5s/mid15s/mid30s backfilled by a scheduled sampler, not inline.
 *   - Every snapshot row carries configHash, regime, stage.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';

// ============================================================================
// Types — Fill record (03 SS8.1)
// ============================================================================

export interface FillRecord {
  /** Unix timestamp (ms) of the fill */
  ts: number;
  /** Human-readable market name */
  market: string;
  /** Polymarket conditionId */
  conditionId: string;
  /** BUY or SELL */
  side: 'BUY' | 'SELL';
  /** Price at which the fill executed */
  fillPrice: number;
  /** Number of shares filled */
  fillSizeShares: number;
  /** Signed inventory after this fill */
  inventoryAfter: number;
  /** Estimated queue position at the time the order was posted. null until Phase C. (03 SS8.1) */
  queuePosAtPost: number | null;
  /** UTC hour (0-23) at fill time. Present from day one for Phase C per-hour drift segmentation. (03 SS8.1) */
  hourBucket: number;
  /** Mid price sampled at +5s after fill. Backfilled by sampler, null if unavailable. */
  mid5s: number | null;
  /** Mid price sampled at +15s after fill. Backfilled by sampler, null if unavailable. */
  mid15s: number | null;
  /** Mid price sampled at +30s after fill. Backfilled by sampler, null if unavailable. */
  mid30s: number | null;
  /** Drift in bps at +15s. Computed from mid15s when available. */
  driftBps15s: number | null;
  /** First 12 hex chars of SHA-256 of the active MarketMakingConfig. (03 SS8.1) */
  configHash: string;
}

// ============================================================================
// Types — Snapshot record (03 SS8.1)
// ============================================================================

export interface SnapshotRecord {
  /** ISO date string (YYYY-MM-DD) */
  date: string;
  /** Config hash at snapshot time */
  configHash: string;
  /** Versioned regime string, e.g. "2026-dynamic-v1". (03 SS8.1) */
  regime: string;
  /** One of "backtest" | "dry-run" | "pilot" | "scale-1". (03 SS8.1) */
  stage: 'backtest' | 'dry-run' | 'pilot' | 'scale-1';
  /** Number of markets actively quoted */
  marketsQuoted: number;
  /** Total fills across all markets this day */
  totalFills: number;
  /** Mean fill-to-mark drift at +15s across all markets (bps) */
  meanDrift15sBps: number | null;
  /** Net PnL in USD (spread + rebate + MtM) */
  netPnlUsd: number;
  /** Total gross exposure in USD */
  grossExposureUsd: number;
  /** Worst per-market drift (bps) */
  worstMarketDrift: number | null;
  /** Modeled rebate accrued this day (USD) */
  rebateAccruedUsd: number;
}

// ============================================================================
// Types — Incident record (03 SS8.1)
// ============================================================================

export interface IncidentRecord {
  /** Unix timestamp (ms) of the incident */
  ts: number;
  /** Market name (or null for portfolio-level incidents) */
  market: string | null;
  /** What triggered the incident (e.g. "circuit_breaker", "kill_switch", "stale_feed") */
  trigger: string;
  /** Mid price before the incident */
  midBefore: number | null;
  /** Mid price 60s after the incident. Backfilled by sampler. */
  midAfter60s: number | null;
  /** Whether quotes were active at the time */
  quotesActive: boolean;
  /** Action taken (e.g. "cancelAll", "blacklist", "cooldown") */
  action: string;
}

// ============================================================================
// Types — Journal record (03 SS8.1)
// ============================================================================

export interface JournalRecord {
  /** Unix timestamp (ms) of the decision */
  ts: number;
  /** Decision type. Includes NO-CHANGE as first-class. (03 SS8.1) */
  type: 'PARAMETER_CHANGE' | 'MARKET_ADD' | 'MARKET_REMOVE' | 'REGIME_CHANGE' | 'STAGE_CHANGE' | 'NO-CHANGE' | 'OTHER';
  /** Free-text description of the decision */
  decision: string;
  /** What effect is expected from this decision */
  expectedEffect: string;
  /** ISO date string by which this decision should be reviewed */
  reviewDate: string;
  /** Config hash before this decision */
  previousConfigHash: string | null;
  /** Config hash after this decision */
  newConfigHash: string | null;
}

// ============================================================================
// Config hash utility (03 SS8.1)
// ============================================================================

/**
 * Compute a deterministic hash of a config object.
 *
 * Per 03 SS8.1: SHA-256 of the MarketMakingConfig object with keys sorted
 * deterministically, truncated to first 12 hex characters.
 */
export function computeConfigHash(config: Record<string, unknown>): string {
  const sorted = sortKeysDeep(config);
  const json = JSON.stringify(sorted);
  const hash = createHash('sha256').update(json).digest('hex');
  return hash.slice(0, 12);
}

/**
 * Recursively sort object keys for deterministic serialization.
 */
function sortKeysDeep(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

// ============================================================================
// MmLogger class
// ============================================================================

export interface MmLoggerOptions {
  /** Base directory for all log files. Defaults to `logs/` in project root. */
  logsDir?: string;
  /** If true, suppress console output from the logger itself. */
  silent?: boolean;
}

export class MmLogger {
  private readonly logsDir: string;
  private readonly configsDir: string;
  private readonly fillsPath: string;
  private readonly snapshotsPath: string;
  private readonly incidentsPath: string;
  private readonly journalPath: string;
  private readonly silent: boolean;

  /** Track the last configHash we saved so we only write on change. */
  private lastSavedConfigHash: string | null = null;

  /** In-memory index of fill records awaiting mid-sample backfill, keyed by `{conditionId}-{ts}`. */
  private pendingFillBackfills: Map<string, { lineIndex: number; record: FillRecord; sampledKeys: Set<string> }> = new Map();

  /** Running count of lines in fills.jsonl (for backfill line tracking). */
  private fillLineCount = 0;

  constructor(options: MmLoggerOptions = {}) {
    this.logsDir = options.logsDir ?? join(process.cwd(), 'logs');
    this.configsDir = join(this.logsDir, 'configs');
    this.fillsPath = join(this.logsDir, 'fills.jsonl');
    this.snapshotsPath = join(this.logsDir, 'snapshots.jsonl');
    this.incidentsPath = join(this.logsDir, 'incidents.jsonl');
    this.journalPath = join(this.logsDir, 'journal.jsonl');
    this.silent = options.silent ?? false;
  }

  /**
   * Create logs/ and logs/configs/ directories if they don't exist.
   * Called on service startup. (03 SS8.1, SS6 Phase A)
   */
  ensureDirectories(): void {
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true });
    }
    if (!existsSync(this.configsDir)) {
      mkdirSync(this.configsDir, { recursive: true });
    }
    // Count existing fill lines for backfill tracking
    if (existsSync(this.fillsPath)) {
      try {
        const content = readFileSync(this.fillsPath, 'utf-8');
        this.fillLineCount = content.split('\n').filter(l => l.trim().length > 0).length;
      } catch {
        this.fillLineCount = 0;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Config persistence (03 SS8.1, SS8.2)
  // --------------------------------------------------------------------------

  /**
   * Save the full config to logs/configs/{hash}.json if the hash is new.
   * Per 03 SS8.2: "Full config saved to logs/configs/{configHash}.json on every hash change."
   *
   * @returns The 12-char hex configHash.
   */
  saveConfigIfChanged(config: Record<string, unknown>): string {
    const hash = computeConfigHash(config);
    if (hash !== this.lastSavedConfigHash) {
      const configPath = join(this.configsDir, `${hash}.json`);
      if (!existsSync(configPath)) {
        writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      }
      this.lastSavedConfigHash = hash;
      this.logInternal(`Config hash: ${hash}`);
    }
    return hash;
  }

  // --------------------------------------------------------------------------
  // Fill log (03 SS8.1)
  // --------------------------------------------------------------------------

  /**
   * Append a fill record to logs/fills.jsonl.
   *
   * The mid5s/mid15s/mid30s/driftBps15s fields are initially null and
   * backfilled by the sampler via `backfillFillMids()`. (03 SS8.2)
   */
  logFill(record: FillRecord): void {
    this.appendJsonl(this.fillsPath, record);
    const lineIndex = this.fillLineCount;
    this.fillLineCount++;

    // Track for backfill
    const key = `${record.conditionId}-${record.ts}`;
    this.pendingFillBackfills.set(key, { lineIndex, record, sampledKeys: new Set() });
  }

  /**
   * Backfill mid samples for a previously logged fill.
   *
   * Per 03 SS8.2: "mid5s, mid15s, mid30s in fills are backfilled by a
   * scheduled sampler (not inline with the fill handler, to avoid blocking
   * the order path)."
   *
   * Since JSONL is append-only (no UPDATE), we append a correction entry
   * with the `corrects` field pointing to the original ts. (03 SS8.2)
   */
  backfillFillMids(
    conditionId: string,
    fillTs: number,
    updates: { mid5s?: number | null; mid15s?: number | null; mid30s?: number | null },
  ): void {
    const key = `${conditionId}-${fillTs}`;
    const pending = this.pendingFillBackfills.get(key);
    if (!pending) return;

    // Update the in-memory record, tracking which samples have been explicitly set
    if (updates.mid5s !== undefined) { pending.record.mid5s = updates.mid5s; pending.sampledKeys.add('mid5s'); }
    if (updates.mid15s !== undefined) { pending.record.mid15s = updates.mid15s; pending.sampledKeys.add('mid15s'); }
    if (updates.mid30s !== undefined) { pending.record.mid30s = updates.mid30s; pending.sampledKeys.add('mid30s'); }

    // Compute driftBps15s when mid15s becomes available
    if (pending.record.mid15s !== null) {
      const sign = pending.record.side === 'BUY' ? 1 : -1;
      pending.record.driftBps15s =
        ((pending.record.mid15s - pending.record.fillPrice) / pending.record.fillPrice) * 10000 * sign;
    }

    // Check if all three sample keys have been explicitly provided
    const allSampled =
      pending.sampledKeys.has('mid5s') &&
      pending.sampledKeys.has('mid15s') &&
      pending.sampledKeys.has('mid30s');

    if (allSampled) {
      // Append a correction record (no UPDATE path — SS8.2)
      const correction = {
        ...pending.record,
        corrects: fillTs,
      };
      this.appendJsonl(this.fillsPath, correction);
      this.fillLineCount++;
      this.pendingFillBackfills.delete(key);
    }
  }

  // --------------------------------------------------------------------------
  // Snapshot log (03 SS8.1)
  // --------------------------------------------------------------------------

  /**
   * Append a daily snapshot record.
   * Per 03 SS8.1: "Every snapshot row carries configHash, regime, stage."
   */
  logSnapshot(record: SnapshotRecord): void {
    this.appendJsonl(this.snapshotsPath, record);
  }

  // --------------------------------------------------------------------------
  // Incident log (03 SS8.1)
  // --------------------------------------------------------------------------

  /**
   * Append an incident record.
   * Used by circuit breaker, kill switch, stale-feed guard (Phase B will
   * call this, but the logger must exist now — per Phase A requirement).
   */
  logIncident(record: IncidentRecord): void {
    this.appendJsonl(this.incidentsPath, record);
    this.logInternal(`INCIDENT: ${record.trigger} on ${record.market ?? 'portfolio'} — ${record.action}`);
  }

  // --------------------------------------------------------------------------
  // Journal log (03 SS8.1)
  // --------------------------------------------------------------------------

  /**
   * Append a decision journal entry.
   * Per 03 SS8.1: `type` includes NO-CHANGE as a first-class entry.
   */
  logJournal(record: JournalRecord): void {
    this.appendJsonl(this.journalPath, record);
  }

  // --------------------------------------------------------------------------
  // Utility: hourBucket (03 SS8.1)
  // --------------------------------------------------------------------------

  /**
   * Compute the UTC hour bucket (0-23) for a given timestamp.
   * Per 03 SS8.1: "hourBucket: UTC hour (0-23) at fill time. Must be
   * present from day one for Phase C per-hour drift segmentation."
   */
  static hourBucket(ts: number): number {
    return new Date(ts).getUTCHours();
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private appendJsonl(filePath: string, record: Record<string, unknown>): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const line = JSON.stringify(record) + '\n';
    appendFileSync(filePath, line, 'utf-8');
  }

  private logInternal(msg: string): void {
    if (!this.silent) {
      console.log(`[MM-Logger] ${msg}`);
    }
  }

  // --------------------------------------------------------------------------
  // Accessors (for testing / reading back)
  // --------------------------------------------------------------------------

  get paths() {
    return {
      fills: this.fillsPath,
      snapshots: this.snapshotsPath,
      incidents: this.incidentsPath,
      journal: this.journalPath,
      configs: this.configsDir,
    };
  }

  /** Read all records from a JSONL file. Utility for tests and grading. */
  static readJsonl<T>(filePath: string): T[] {
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as T);
  }
}
