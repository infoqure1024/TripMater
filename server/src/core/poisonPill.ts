interface IdEntry {
  count: number;
  firstSeenAt: number;
}

interface ErrorEntry {
  count: number;
  lastSeenAt: number;
}

/**
 * PoisonPillDetector tracks two categories of problematic client behaviour:
 *
 * 1. Stuck-retry batches: the same sample `id` appears in N+ requests within
 *    a sliding time window. This indicates a client that is stuck retrying the
 *    same batch — typically because the sample itself is malformed downstream
 *    (poison pill). Log WARN and alert ops so the device can be investigated.
 *
 * 2. Consecutive 4xx errors per device: authentication failures or poison
 *    envelope patterns that never change. Consecutive-count is reset to 0 on
 *    any successful ingest.
 *
 * Memory bounds:
 *   - idMap: capped at maxIdMapSize entries. When the cap is hit, prune() is
 *     called inline; if still full, new IDs are skipped to prevent OOM.
 *     Worst-case: maxIdMapSize × ~200 bytes ≈ 20 MB at the default 100,000 cap.
 *   - errorMap: pruned in prune() alongside idMap using the same windowMs TTL.
 *
 * Both maps are pruned periodically (call `prune()` on a cron/interval).
 */
export class PoisonPillDetector {
  private readonly windowMs: number;
  private readonly idThreshold: number;
  private readonly errorThreshold: number;
  private readonly maxIdMapSize: number;

  // Map from sample id → observation entry within the current window.
  private readonly idMap = new Map<string, IdEntry>();

  // Map from device key → consecutive 4xx error entry.
  private readonly errorMap = new Map<string, ErrorEntry>();

  constructor(windowMs = 60_000, idThreshold = 3, errorThreshold = 5, maxIdMapSize = 100_000) {
    this.windowMs = windowMs;
    this.idThreshold = idThreshold;
    this.errorThreshold = errorThreshold;
    this.maxIdMapSize = maxIdMapSize;
  }

  /**
   * Record a batch of sample IDs from a single request.
   * Returns the subset of IDs that have exceeded the repetition threshold
   * within the time window (i.e. the poison-pill candidates).
   */
  observeIds(ids: string[]): string[] {
    const now = Date.now();
    const poisoned: string[] = [];

    for (const id of ids) {
      const entry = this.idMap.get(id);
      if (!entry) {
        // Enforce hard size cap before inserting a new entry.
        if (this.idMap.size >= this.maxIdMapSize) {
          this.prune();
          // If map is still full after pruning (all entries are recent), skip this ID
          // to prevent unbounded memory growth.
          if (this.idMap.size >= this.maxIdMapSize) {
            continue;
          }
        }
        this.idMap.set(id, { count: 1, firstSeenAt: now });
      } else if (now - entry.firstSeenAt > this.windowMs) {
        // Window has elapsed — reset the entry rather than pruning here.
        this.idMap.set(id, { count: 1, firstSeenAt: now });
      } else {
        entry.count++;
        if (entry.count >= this.idThreshold) {
          poisoned.push(id);
        }
      }
    }

    return poisoned;
  }

  /**
   * Record a 4xx error for a device key (e.g. deviceId or IP).
   * Returns the updated consecutive count so the caller can decide
   * whether to log WARN.
   */
  record4xx(deviceKey: string): number {
    const now = Date.now();
    const entry = this.errorMap.get(deviceKey);
    const next = (entry?.count ?? 0) + 1;
    this.errorMap.set(deviceKey, { count: next, lastSeenAt: now });
    return next;
  }

  /**
   * Reset the consecutive 4xx count for a device after a successful ingest.
   */
  recordSuccess(deviceKey: string): void {
    this.errorMap.delete(deviceKey);
  }

  /**
   * Prune expired entries from both maps to bound memory usage.
   * Call periodically (e.g. every 5 minutes).
   */
  prune(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [id, entry] of this.idMap) {
      if (entry.firstSeenAt < cutoff) {
        this.idMap.delete(id);
      }
    }
    // Prune stale error entries: devices that have not sent a 4xx within windowMs
    // are unlikely to be actively stuck and can be evicted.
    for (const [key, entry] of this.errorMap) {
      if (entry.lastSeenAt < cutoff) {
        this.errorMap.delete(key);
      }
    }
  }

  /** Returns the configured error threshold for external callers (e.g. log WARN). */
  get configuredErrorThreshold(): number {
    return this.errorThreshold;
  }

  /** Reset all internal state. For use in tests only. */
  reset(): void {
    this.idMap.clear();
    this.errorMap.clear();
  }
}
