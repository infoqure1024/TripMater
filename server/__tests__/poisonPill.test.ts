import { PoisonPillDetector } from '../src/core/poisonPill';

describe('PoisonPillDetector', () => {
  let detector: PoisonPillDetector;

  beforeEach(() => {
    // Defaults: windowMs=60_000, idThreshold=3, errorThreshold=5
    detector = new PoisonPillDetector();
  });

  afterEach(() => {
    detector.reset();
  });

  // ── observeIds: below threshold ───────────────────────────────────────────

  it('returns empty array when an ID appears fewer times than the threshold', () => {
    const id = '00000000-0000-0000-0000-000000000001';
    expect(detector.observeIds([id])).toEqual([]); // count=1
    expect(detector.observeIds([id])).toEqual([]); // count=2
    // threshold=3, so count<3 → not poisoned yet
  });

  it('returns the ID once it reaches the threshold', () => {
    const id = '00000000-0000-0000-0000-000000000001';
    detector.observeIds([id]); // count=1
    detector.observeIds([id]); // count=2
    const result = detector.observeIds([id]); // count=3 → threshold hit
    expect(result).toContain(id);
  });

  it('keeps returning the ID on every call after threshold is exceeded', () => {
    const id = '00000000-0000-0000-0000-000000000001';
    detector.observeIds([id]);
    detector.observeIds([id]);
    detector.observeIds([id]); // threshold hit

    const result = detector.observeIds([id]); // count=4 → still poisoned
    expect(result).toContain(id);
  });

  it('returns only the IDs that exceeded the threshold in a mixed batch', () => {
    const poisonId = '00000000-0000-0000-0000-000000000001';
    const normalId = '00000000-0000-0000-0000-000000000002';

    // Pump poisonId past threshold, normalId only once
    detector.observeIds([poisonId]);
    detector.observeIds([poisonId]);
    const result = detector.observeIds([poisonId, normalId]);

    expect(result).toContain(poisonId);
    expect(result).not.toContain(normalId);
  });

  it('returns empty array when observeIds is called with empty array', () => {
    expect(detector.observeIds([])).toEqual([]);
  });

  it('treats different IDs independently', () => {
    const id1 = '00000000-0000-0000-0000-000000000001';
    const id2 = '00000000-0000-0000-0000-000000000002';

    detector.observeIds([id1]);
    detector.observeIds([id1]);
    detector.observeIds([id2]); // id2 count=1 only

    const result = detector.observeIds([id1, id2]); // id1 count=3 → hit; id2 count=2 → no
    expect(result).toContain(id1);
    expect(result).not.toContain(id2);
  });

  // ── observeIds: custom threshold ─────────────────────────────────────────

  it('respects a custom idThreshold', () => {
    const d = new PoisonPillDetector(60_000, 2); // threshold=2
    const id = 'aaaaaaaa-0000-0000-0000-000000000001';

    expect(d.observeIds([id])).toEqual([]); // count=1 < 2
    expect(d.observeIds([id])).toContain(id); // count=2 = threshold
  });

  // ── prune: stale ID entries ───────────────────────────────────────────────

  it('resets ID count after the window elapses', () => {
    jest.useFakeTimers();
    try {
      const d = new PoisonPillDetector(1000, 3);
      const id = 'bbbbbbbb-0000-0000-0000-000000000001';

      d.observeIds([id]); // count=1 in window
      d.observeIds([id]); // count=2 in window

      jest.advanceTimersByTime(1001); // advance past the 1000ms window

      // observeIds after window expiry resets the entry → count=1 (not poisoned)
      const result = d.observeIds([id]);
      expect(result).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('prune() removes entries older than the window', () => {
    jest.useFakeTimers();
    try {
      const d = new PoisonPillDetector(1000, 3);
      const id = 'cccccccc-0000-0000-0000-000000000001';

      d.observeIds([id]); // populate the map

      jest.advanceTimersByTime(1001); // advance past the 1000ms window

      d.prune(); // should remove the entry
      // Subsequent observeIds starts fresh: count=1 → not poisoned
      const result = d.observeIds([id]);
      expect(result).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  // ── observeIds: same-batch duplicate IDs ─────────────────────────────────

  it('counts duplicate IDs within the same batch as separate observations', () => {
    // observeIds(['id-a', 'id-a']) with threshold=2:
    // first 'id-a' → count=1; second 'id-a' → count=2 >= threshold → poisoned.
    // Duplicates within one request are NOT collapsed — they represent repeated
    // attempts to ingest the same sample in a single call.
    const d = new PoisonPillDetector(60_000, 2);
    const id = 'eeeeeeee-0000-0000-0000-000000000001';

    const result = d.observeIds([id, id]);
    expect(result).toContain(id);
  });

  // ── record4xx / recordSuccess ─────────────────────────────────────────────

  it('returns 1 on first 4xx for a device', () => {
    expect(detector.record4xx('device-1')).toBe(1);
  });

  it('increments consecutively', () => {
    detector.record4xx('device-1');
    detector.record4xx('device-1');
    expect(detector.record4xx('device-1')).toBe(3);
  });

  it('tracks different devices independently', () => {
    detector.record4xx('device-1');
    detector.record4xx('device-1');
    detector.record4xx('device-2');

    expect(detector.record4xx('device-1')).toBe(3);
    expect(detector.record4xx('device-2')).toBe(2);
  });

  it('resets consecutive count to 0 after recordSuccess', () => {
    detector.record4xx('device-1');
    detector.record4xx('device-1');
    detector.recordSuccess('device-1');

    // After success the counter is gone; next 4xx starts from 1.
    expect(detector.record4xx('device-1')).toBe(1);
  });

  it('recordSuccess on an unknown device is a no-op', () => {
    expect(() => detector.recordSuccess('unknown-device')).not.toThrow();
    // Subsequent 4xx starts from 1 as expected.
    expect(detector.record4xx('unknown-device')).toBe(1);
  });

  // ── configuredErrorThreshold ──────────────────────────────────────────────

  it('exposes the configured error threshold', () => {
    const d = new PoisonPillDetector(60_000, 3, 7);
    expect(d.configuredErrorThreshold).toBe(7);
  });

  it('default error threshold is 5', () => {
    expect(detector.configuredErrorThreshold).toBe(5);
  });

  // ── reset ─────────────────────────────────────────────────────────────────

  it('reset clears both the ID map and error map', () => {
    const id = 'dddddddd-0000-0000-0000-000000000001';
    detector.observeIds([id]);
    detector.observeIds([id]);
    detector.record4xx('device-1');
    detector.record4xx('device-1');

    detector.reset();

    // ID map is cleared: starts at count=1 again (not poisoned even after threshold-1 calls)
    expect(detector.observeIds([id])).toEqual([]);

    // Error map is cleared: next 4xx starts from 1
    expect(detector.record4xx('device-1')).toBe(1);
  });
});
