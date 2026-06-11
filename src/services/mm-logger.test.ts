import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  MmLogger,
  computeConfigHash,
  type FillRecord,
  type SnapshotRecord,
  type IncidentRecord,
  type JournalRecord,
} from './mm-logger.js';

// ============================================================================
// Test helpers
// ============================================================================

const TEST_LOGS_DIR = join(process.cwd(), 'test-logs-mm-logger');

function createTestLogger(): MmLogger {
  return new MmLogger({ logsDir: TEST_LOGS_DIR, silent: true });
}

function sampleFillRecord(overrides: Partial<FillRecord> = {}): FillRecord {
  return {
    ts: 1718000000000,
    market: 'Test Market',
    conditionId: 'cond-abc',
    side: 'BUY',
    fillPrice: 0.50,
    fillSizeShares: 10,
    inventoryAfter: 10,
    queuePosAtPost: null,        // null for Phase A (03 SS8.1)
    hourBucket: 14,
    mid5s: null,
    mid15s: null,
    mid30s: null,
    driftBps15s: null,
    configHash: 'abcdef012345',
    ...overrides,
  };
}

function sampleSnapshotRecord(overrides: Partial<SnapshotRecord> = {}): SnapshotRecord {
  return {
    date: '2026-06-10',
    configHash: 'abcdef012345',
    regime: '2026-dynamic-v1',
    stage: 'dry-run',
    marketsQuoted: 3,
    totalFills: 42,
    meanDrift15sBps: 1.5,
    netPnlUsd: 12.34,
    grossExposureUsd: 85.0,
    worstMarketDrift: -2.1,
    rebateAccruedUsd: 3.50,
    ...overrides,
  };
}

function sampleIncidentRecord(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    ts: 1718000000000,
    market: 'Test Market',
    trigger: 'circuit_breaker',
    midBefore: 0.50,
    midAfter60s: null,
    quotesActive: true,
    action: 'cancelAll',
    ...overrides,
  };
}

function sampleJournalRecord(overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    ts: 1718000000000,
    type: 'NO-CHANGE',
    decision: 'Weekly review: drift still green, no parameter changes.',
    expectedEffect: 'Continued stable operation.',
    reviewDate: '2026-06-17',
    previousConfigHash: 'abcdef012345',
    newConfigHash: 'abcdef012345',
    ...overrides,
  };
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
  // Clean up test directory before each test
  if (existsSync(TEST_LOGS_DIR)) {
    rmSync(TEST_LOGS_DIR, { recursive: true });
  }
});

afterEach(() => {
  if (existsSync(TEST_LOGS_DIR)) {
    rmSync(TEST_LOGS_DIR, { recursive: true });
  }
});

// ============================================================================
// Tests
// ============================================================================

describe('MmLogger', () => {
  describe('ensureDirectories', () => {
    it('creates logs/ and logs/configs/ if they do not exist', () => {
      const logger = createTestLogger();
      expect(existsSync(TEST_LOGS_DIR)).toBe(false);

      logger.ensureDirectories();

      expect(existsSync(TEST_LOGS_DIR)).toBe(true);
      expect(existsSync(join(TEST_LOGS_DIR, 'configs'))).toBe(true);
    });

    it('is idempotent — does not fail if directories already exist', () => {
      const logger = createTestLogger();
      logger.ensureDirectories();
      expect(() => logger.ensureDirectories()).not.toThrow();
    });
  });

  describe('JSONL append (fills)', () => {
    it('writes a fill record as a single JSON line and reads it back', () => {
      const logger = createTestLogger();
      logger.ensureDirectories();

      const record = sampleFillRecord();
      logger.logFill(record);

      const records = MmLogger.readJsonl<FillRecord>(logger.paths.fills);
      expect(records).toHaveLength(1);
      expect(records[0].ts).toBe(record.ts);
      expect(records[0].market).toBe('Test Market');
      expect(records[0].conditionId).toBe('cond-abc');
      expect(records[0].side).toBe('BUY');
      expect(records[0].fillPrice).toBe(0.50);
      expect(records[0].fillSizeShares).toBe(10);
      expect(records[0].inventoryAfter).toBe(10);
      expect(records[0].queuePosAtPost).toBeNull();
      expect(records[0].hourBucket).toBe(14);
      expect(records[0].mid5s).toBeNull();
      expect(records[0].mid15s).toBeNull();
      expect(records[0].mid30s).toBeNull();
      expect(records[0].driftBps15s).toBeNull();
      expect(records[0].configHash).toBe('abcdef012345');
    });

    it('appends multiple records — each on its own line', () => {
      const logger = createTestLogger();
      logger.ensureDirectories();

      logger.logFill(sampleFillRecord({ ts: 1 }));
      logger.logFill(sampleFillRecord({ ts: 2 }));
      logger.logFill(sampleFillRecord({ ts: 3 }));

      const records = MmLogger.readJsonl<FillRecord>(logger.paths.fills);
      expect(records).toHaveLength(3);
      expect(records[0].ts).toBe(1);
      expect(records[1].ts).toBe(2);
      expect(records[2].ts).toBe(3);
    });

    it('fill record has all required fields per 03 SS8.1', () => {
      const logger = createTestLogger();
      logger.ensureDirectories();

      const record = sampleFillRecord();
      logger.logFill(record);

      const records = MmLogger.readJsonl<FillRecord>(logger.paths.fills);
      const r = records[0];

      // All fields from 03 SS8.1:
      // {ts, market, conditionId, side, fillPrice, fillSizeShares, inventoryAfter,
      //  queuePosAtPost, hourBucket, mid5s, mid15s, mid30s, driftBps15s, configHash}
      const requiredFields = [
        'ts', 'market', 'conditionId', 'side', 'fillPrice', 'fillSizeShares',
        'inventoryAfter', 'queuePosAtPost', 'hourBucket', 'mid5s', 'mid15s',
        'mid30s', 'driftBps15s', 'configHash',
      ];
      for (const field of requiredFields) {
        expect(r).toHaveProperty(field);
      }
    });
  });

  describe('JSONL append (snapshots)', () => {
    it('writes and reads back a snapshot record', () => {
      const logger = createTestLogger();
      logger.ensureDirectories();

      const record = sampleSnapshotRecord();
      logger.logSnapshot(record);

      const records = MmLogger.readJsonl<SnapshotRecord>(logger.paths.snapshots);
      expect(records).toHaveLength(1);
      expect(records[0].date).toBe('2026-06-10');
      expect(records[0].configHash).toBe('abcdef012345');
      expect(records[0].regime).toBe('2026-dynamic-v1');
      expect(records[0].stage).toBe('dry-run');
    });

    it('snapshot record has all required fields per 03 SS8.1', () => {
      const logger = createTestLogger();
      logger.ensureDirectories();

      logger.logSnapshot(sampleSnapshotRecord());

      const records = MmLogger.readJsonl<SnapshotRecord>(logger.paths.snapshots);
      const r = records[0];

      // {date, configHash, regime, stage, marketsQuoted, totalFills, meanDrift15sBps,
      //  netPnlUsd, grossExposureUsd, worstMarketDrift, rebateAccruedUsd}
      const requiredFields = [
        'date', 'configHash', 'regime', 'stage', 'marketsQuoted', 'totalFills',
        'meanDrift15sBps', 'netPnlUsd', 'grossExposureUsd', 'worstMarketDrift',
        'rebateAccruedUsd',
      ];
      for (const field of requiredFields) {
        expect(r).toHaveProperty(field);
      }
    });

    it('snapshot always carries configHash, regime, stage (03 SS8.1)', () => {
      const logger = createTestLogger();
      logger.ensureDirectories();

      logger.logSnapshot(sampleSnapshotRecord());

      const records = MmLogger.readJsonl<SnapshotRecord>(logger.paths.snapshots);
      expect(records[0].configHash).toBeTruthy();
      expect(records[0].regime).toBeTruthy();
      expect(records[0].stage).toBeTruthy();
    });
  });

  describe('JSONL append (incidents)', () => {
    it('writes and reads back an incident record', () => {
      const logger = createTestLogger();
      logger.ensureDirectories();

      const record = sampleIncidentRecord();
      logger.logIncident(record);

      const records = MmLogger.readJsonl<IncidentRecord>(logger.paths.incidents);
      expect(records).toHaveLength(1);
      expect(records[0].trigger).toBe('circuit_breaker');
      expect(records[0].action).toBe('cancelAll');
    });

    it('incident record has all required fields per 03 SS8.1', () => {
      const logger = createTestLogger();
      logger.ensureDirectories();

      logger.logIncident(sampleIncidentRecord());

      const records = MmLogger.readJsonl<IncidentRecord>(logger.paths.incidents);
      const r = records[0];

      // {ts, market, trigger, midBefore, midAfter60s, quotesActive, action}
      const requiredFields = [
        'ts', 'market', 'trigger', 'midBefore', 'midAfter60s', 'quotesActive', 'action',
      ];
      for (const field of requiredFields) {
        expect(r).toHaveProperty(field);
      }
    });
  });

  describe('JSONL append (journal)', () => {
    it('writes and reads back a journal record', () => {
      const logger = createTestLogger();
      logger.ensureDirectories();

      const record = sampleJournalRecord();
      logger.logJournal(record);

      const records = MmLogger.readJsonl<JournalRecord>(logger.paths.journal);
      expect(records).toHaveLength(1);
      expect(records[0].type).toBe('NO-CHANGE');
      expect(records[0].decision).toContain('Weekly review');
    });

    it('journal supports NO-CHANGE as first-class type (03 SS8.1)', () => {
      const logger = createTestLogger();
      logger.ensureDirectories();

      logger.logJournal(sampleJournalRecord({ type: 'NO-CHANGE' }));

      const records = MmLogger.readJsonl<JournalRecord>(logger.paths.journal);
      expect(records[0].type).toBe('NO-CHANGE');
    });

    it('journal record has all required fields per 03 SS8.1', () => {
      const logger = createTestLogger();
      logger.ensureDirectories();

      logger.logJournal(sampleJournalRecord());

      const records = MmLogger.readJsonl<JournalRecord>(logger.paths.journal);
      const r = records[0];

      // {ts, type, decision, expectedEffect, reviewDate, previousConfigHash, newConfigHash}
      const requiredFields = [
        'ts', 'type', 'decision', 'expectedEffect', 'reviewDate',
        'previousConfigHash', 'newConfigHash',
      ];
      for (const field of requiredFields) {
        expect(r).toHaveProperty(field);
      }
    });
  });

  describe('backfillFillMids', () => {
    it('appends a correction record with mid samples and drift (03 SS8.2)', () => {
      const logger = createTestLogger();
      logger.ensureDirectories();

      const fill = sampleFillRecord({ ts: 100, fillPrice: 0.50, side: 'BUY' });
      logger.logFill(fill);

      // Simulate the sampler calling back
      logger.backfillFillMids('cond-abc', 100, { mid5s: 0.51 });
      logger.backfillFillMids('cond-abc', 100, { mid15s: 0.52 });
      logger.backfillFillMids('cond-abc', 100, { mid30s: 0.53 });

      const records = MmLogger.readJsonl<FillRecord & { corrects?: number }>(logger.paths.fills);
      // Original + correction
      expect(records).toHaveLength(2);
      const correction = records[1];
      expect(correction.corrects).toBe(100);
      expect(correction.mid5s).toBe(0.51);
      expect(correction.mid15s).toBe(0.52);
      expect(correction.mid30s).toBe(0.53);
      // driftBps15s = (0.52 - 0.50) / 0.50 * 10000 * 1 = 400
      expect(correction.driftBps15s).toBeCloseTo(400, 0);
    });

    it('computes negative driftBps15s for adverse sell fill', () => {
      const logger = createTestLogger();
      logger.ensureDirectories();

      const fill = sampleFillRecord({ ts: 200, fillPrice: 0.50, side: 'SELL' });
      logger.logFill(fill);

      logger.backfillFillMids('cond-abc', 200, { mid5s: 0.51, mid15s: 0.52, mid30s: 0.53 });

      const records = MmLogger.readJsonl<FillRecord & { corrects?: number }>(logger.paths.fills);
      const correction = records[1];
      // SELL: drift = (0.52 - 0.50) / 0.50 * 10000 * -1 = -400 (adverse)
      expect(correction.driftBps15s).toBeCloseTo(-400, 0);
    });

    it('handles null mid samples gracefully (market went offline) (03 SS8.2)', () => {
      const logger = createTestLogger();
      logger.ensureDirectories();

      const fill = sampleFillRecord({ ts: 300 });
      logger.logFill(fill);

      // All three are explicitly null
      logger.backfillFillMids('cond-abc', 300, { mid5s: null, mid15s: null, mid30s: null });

      const records = MmLogger.readJsonl<FillRecord & { corrects?: number }>(logger.paths.fills);
      expect(records).toHaveLength(2);
      const correction = records[1];
      expect(correction.mid5s).toBeNull();
      expect(correction.mid15s).toBeNull();
      expect(correction.mid30s).toBeNull();
      expect(correction.driftBps15s).toBeNull();
    });
  });
});

describe('computeConfigHash', () => {
  it('produces a 12-character hex string', () => {
    const config = { a: 1, b: 'two', c: [3] };
    const hash = computeConfigHash(config);
    expect(hash).toHaveLength(12);
    expect(/^[0-9a-f]{12}$/.test(hash)).toBe(true);
  });

  it('is deterministic — same config produces same hash', () => {
    const config = { baseHalfSpreadTicks: 2, maxInventoryShares: 50 };
    const hash1 = computeConfigHash(config);
    const hash2 = computeConfigHash(config);
    expect(hash1).toBe(hash2);
  });

  it('is key-order independent (sorted internally)', () => {
    const configA = { z: 1, a: 2 };
    const configB = { a: 2, z: 1 };
    expect(computeConfigHash(configA)).toBe(computeConfigHash(configB));
  });

  it('produces different hashes for different configs', () => {
    const configA = { baseHalfSpreadTicks: 2 };
    const configB = { baseHalfSpreadTicks: 3 };
    expect(computeConfigHash(configA)).not.toBe(computeConfigHash(configB));
  });

  it('handles nested objects deterministically', () => {
    const configA = { outer: { z: 1, a: 2 }, x: [1, 2] };
    const configB = { x: [1, 2], outer: { a: 2, z: 1 } };
    expect(computeConfigHash(configA)).toBe(computeConfigHash(configB));
  });
});

describe('MmLogger.hourBucket', () => {
  it('returns UTC hour 0-23', () => {
    // 2026-06-10T14:30:00Z → hour 14
    const ts = new Date('2026-06-10T14:30:00Z').getTime();
    expect(MmLogger.hourBucket(ts)).toBe(14);
  });

  it('returns 0 for midnight UTC', () => {
    const ts = new Date('2026-06-10T00:15:00Z').getTime();
    expect(MmLogger.hourBucket(ts)).toBe(0);
  });

  it('returns 23 for 11pm UTC', () => {
    const ts = new Date('2026-06-10T23:59:59Z').getTime();
    expect(MmLogger.hourBucket(ts)).toBe(23);
  });
});

describe('saveConfigIfChanged', () => {
  it('saves config file on first call', () => {
    const logger = createTestLogger();
    logger.ensureDirectories();

    const config = { baseHalfSpreadTicks: 2, maxInventoryShares: 50 };
    const hash = logger.saveConfigIfChanged(config);

    const configPath = join(TEST_LOGS_DIR, 'configs', `${hash}.json`);
    expect(existsSync(configPath)).toBe(true);

    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(saved.baseHalfSpreadTicks).toBe(2);
    expect(saved.maxInventoryShares).toBe(50);
  });

  it('does not rewrite config file on repeated calls with same config', () => {
    const logger = createTestLogger();
    logger.ensureDirectories();

    const config = { a: 1 };
    const hash1 = logger.saveConfigIfChanged(config);
    const hash2 = logger.saveConfigIfChanged(config);
    expect(hash1).toBe(hash2);
  });

  it('saves a new config file when config changes', () => {
    const logger = createTestLogger();
    logger.ensureDirectories();

    const hash1 = logger.saveConfigIfChanged({ a: 1 });
    const hash2 = logger.saveConfigIfChanged({ a: 2 });
    expect(hash1).not.toBe(hash2);

    expect(existsSync(join(TEST_LOGS_DIR, 'configs', `${hash1}.json`))).toBe(true);
    expect(existsSync(join(TEST_LOGS_DIR, 'configs', `${hash2}.json`))).toBe(true);
  });
});

describe('readJsonl', () => {
  it('returns empty array for non-existent file', () => {
    const records = MmLogger.readJsonl('/nonexistent/path/fills.jsonl');
    expect(records).toEqual([]);
  });
});
