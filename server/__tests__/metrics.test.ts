import { MetricsStore } from '../src/core/metrics';
import type { IngestCounts } from '../src/core/metrics';

function makeCounts(overrides: Partial<IngestCounts> = {}): IngestCounts {
  return {
    received: 0,
    inserted: 0,
    duplicates: 0,
    dropped: 0,
    deviceMismatch: 0,
    ...overrides,
  };
}

describe('MetricsStore', () => {
  let store: MetricsStore;

  beforeEach(() => {
    store = new MetricsStore();
  });

  // ── snapshot baseline ─────────────────────────────────────────────────────

  it('starts with all counters at zero', () => {
    const snap = store.snapshot();
    expect(snap.ingest.received).toBe(0);
    expect(snap.ingest.inserted).toBe(0);
    expect(snap.ingest.duplicates).toBe(0);
    expect(snap.ingest.dropped).toBe(0);
    expect(snap.ingest.deviceMismatch).toBe(0);
    expect(snap.rejectedEnvelopes).toBe(0);
    expect(snap.errors4xx).toBe(0);
    expect(snap.errors5xx).toBe(0);
    expect(snap.requestCount).toBe(0);
  });

  it('uptimeMs is non-negative', () => {
    const snap = store.snapshot();
    expect(snap.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  // ── recordIngest ──────────────────────────────────────────────────────────

  it('accumulates ingest counts across multiple calls', () => {
    store.recordIngest(makeCounts({ received: 10, inserted: 8, duplicates: 1, dropped: 1 }));
    store.recordIngest(makeCounts({ received: 5, inserted: 3, duplicates: 2, dropped: 0 }));

    const snap = store.snapshot();
    expect(snap.ingest.received).toBe(15);
    expect(snap.ingest.inserted).toBe(11);
    expect(snap.ingest.duplicates).toBe(3);
    expect(snap.ingest.dropped).toBe(1);
  });

  it('increments requestCount on each recordIngest call', () => {
    store.recordIngest(makeCounts({ received: 1, inserted: 1 }));
    store.recordIngest(makeCounts({ received: 2, inserted: 2 }));

    expect(store.snapshot().requestCount).toBe(2);
  });

  it('accumulates deviceMismatch counter', () => {
    store.recordIngest(makeCounts({ received: 3, inserted: 3, deviceMismatch: 2 }));
    store.recordIngest(makeCounts({ received: 1, inserted: 1, deviceMismatch: 1 }));

    expect(store.snapshot().ingest.deviceMismatch).toBe(3);
  });

  // ── recordRejectedEnvelope ────────────────────────────────────────────────

  it('increments rejectedEnvelopes and requestCount on recordRejectedEnvelope', () => {
    store.recordRejectedEnvelope();
    store.recordRejectedEnvelope();

    const snap = store.snapshot();
    expect(snap.rejectedEnvelopes).toBe(2);
    expect(snap.requestCount).toBe(2);
  });

  // ── recordError4xx / recordError5xx ───────────────────────────────────────

  it('increments errors4xx counter', () => {
    store.recordError4xx();
    store.recordError4xx();
    store.recordError4xx();

    expect(store.snapshot().errors4xx).toBe(3);
  });

  it('increments errors5xx counter', () => {
    store.recordError5xx();

    expect(store.snapshot().errors5xx).toBe(1);
  });

  it('tracks 4xx and 5xx independently', () => {
    store.recordError4xx();
    store.recordError5xx();
    store.recordError4xx();

    const snap = store.snapshot();
    expect(snap.errors4xx).toBe(2);
    expect(snap.errors5xx).toBe(1);
  });

  // ── snapshot immutability ─────────────────────────────────────────────────

  it('snapshot returns a copy — mutating the result does not affect subsequent snapshots', () => {
    store.recordIngest(makeCounts({ received: 5, inserted: 5 }));

    const snap1 = store.snapshot();
    snap1.ingest.received = 999; // mutate the returned copy

    const snap2 = store.snapshot();
    expect(snap2.ingest.received).toBe(5);
  });

  // ── reset ─────────────────────────────────────────────────────────────────

  it('reset clears all counters back to zero', () => {
    store.recordIngest(makeCounts({ received: 10, inserted: 8, duplicates: 2 }));
    store.recordRejectedEnvelope();
    store.recordError4xx();
    store.recordError5xx();

    store.reset();

    const snap = store.snapshot();
    expect(snap.ingest.received).toBe(0);
    expect(snap.ingest.inserted).toBe(0);
    expect(snap.ingest.duplicates).toBe(0);
    expect(snap.ingest.dropped).toBe(0);
    expect(snap.ingest.deviceMismatch).toBe(0);
    expect(snap.rejectedEnvelopes).toBe(0);
    expect(snap.errors4xx).toBe(0);
    expect(snap.errors5xx).toBe(0);
    expect(snap.requestCount).toBe(0);
  });

  it('continues to accumulate correctly after reset', () => {
    store.recordIngest(makeCounts({ received: 5, inserted: 5 }));
    store.reset();
    store.recordIngest(makeCounts({ received: 3, inserted: 3 }));

    const snap = store.snapshot();
    expect(snap.ingest.received).toBe(3);
    expect(snap.ingest.inserted).toBe(3);
    expect(snap.requestCount).toBe(1);
  });
});
