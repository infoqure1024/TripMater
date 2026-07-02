/**
 * Tests for FixLogger's ring-buffer memory bound (Issue #47).
 * Pure logic — no React Native dependencies.
 */
import { FixLogger, DEFAULT_MAX_LOG_ENTRIES } from '../src/core/fixLogger';
import { Fix, AddResult } from '../src/core/tripMeter';

function makeFix(i: number): Fix {
  return {
    latitude: 35 + i * 0.0001,
    longitude: 139 + i * 0.0001,
    accuracy: 5,
    speed: 10,
    timestamp: 1_000_000 + i * 1000, // ~1s cadence, matching real fix interval
  };
}

function makeResult(
  i: number,
  reason: AddResult['reason'] = 'counted_position',
): AddResult {
  return {
    reason,
    distanceAdded: 10,
    total: i * 10,
    filteredSpeedMps: 10,
  };
}

describe('FixLogger', () => {
  describe('basic recording (unbounded within capacity)', () => {
    it('accumulates entries and reports count/totalCount', () => {
      const logger = new FixLogger(100);
      for (let i = 0; i < 5; i++) {
        logger.record(makeFix(i), makeResult(i));
      }
      expect(logger.count).toBe(5);
      expect(logger.totalCount).toBe(5);
      expect(logger.getEntries()).toHaveLength(5);
      expect(logger.isAtCapacity).toBe(false);
    });

    it('defaults to DEFAULT_MAX_LOG_ENTRIES when no maxEntries given', () => {
      const logger = new FixLogger();
      expect(logger.capacity).toBe(DEFAULT_MAX_LOG_ENTRIES);
    });

    it('throws for a non-positive maxEntries', () => {
      expect(() => new FixLogger(0)).toThrow();
      expect(() => new FixLogger(-1)).toThrow();
    });
  });

  describe('ring buffer behavior at capacity', () => {
    it('discards the oldest entries once maxEntries is exceeded', () => {
      const logger = new FixLogger(3);
      for (let i = 0; i < 5; i++) {
        logger.record(makeFix(i), makeResult(i));
      }
      // Only the 3 most recent entries (i=2,3,4) should remain.
      expect(logger.count).toBe(3);
      const entries = logger.getEntries();
      expect(entries.map(e => e.total)).toEqual([20, 30, 40]);
    });

    it('never lets count exceed capacity, however many records are made', () => {
      const logger = new FixLogger(3);
      for (let i = 0; i < 50; i++) {
        logger.record(makeFix(i), makeResult(i));
        expect(logger.count).toBeLessThanOrEqual(3);
      }
      expect(logger.count).toBe(3);
    });

    it('tracks totalCount (cumulative) independently of the held count', () => {
      const logger = new FixLogger(3);
      for (let i = 0; i < 10; i++) {
        logger.record(makeFix(i), makeResult(i));
      }
      expect(logger.count).toBe(3);
      expect(logger.totalCount).toBe(10);
    });

    it('reports isAtCapacity only once the buffer is full', () => {
      const logger = new FixLogger(3);
      logger.record(makeFix(0), makeResult(0));
      expect(logger.isAtCapacity).toBe(false);
      logger.record(makeFix(1), makeResult(1));
      expect(logger.isAtCapacity).toBe(false);
      logger.record(makeFix(2), makeResult(2));
      expect(logger.isAtCapacity).toBe(true);
      logger.record(makeFix(3), makeResult(3));
      expect(logger.isAtCapacity).toBe(true);
    });
  });

  describe('toCsv respects the held range only', () => {
    it('emits exactly as many data rows as currently held entries', () => {
      const logger = new FixLogger(3);
      for (let i = 0; i < 10; i++) {
        logger.record(makeFix(i), makeResult(i));
      }
      const csv = logger.toCsv();
      const lines = csv.trim().split('\n');
      const header = lines[0];
      const rows = lines.slice(1);
      expect(header.startsWith('index,')).toBe(true);
      expect(rows).toHaveLength(3);
      // Row content reflects the surviving (most recent) entries only
      // (i=7,8,9 survive when capacity=3 and 10 records were made).
      expect(rows[0]).toContain('70.0'); // total for i=7
      expect(rows[2]).toContain('90.0'); // total for i=9
    });
  });

  describe('clear()', () => {
    it('resets count, totalCount, and capacity state', () => {
      const logger = new FixLogger(3);
      for (let i = 0; i < 10; i++) {
        logger.record(makeFix(i), makeResult(i));
      }
      expect(logger.isAtCapacity).toBe(true);
      logger.clear();
      expect(logger.count).toBe(0);
      expect(logger.totalCount).toBe(0);
      expect(logger.isAtCapacity).toBe(false);
      expect(logger.getEntries()).toHaveLength(0);

      // cadence resets too: first record after clear() should have cadenceS 0
      logger.record(makeFix(0), makeResult(0));
      expect(logger.getEntries()[0].cadenceS).toBe(0);
    });
  });
});
