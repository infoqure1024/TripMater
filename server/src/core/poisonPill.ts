interface IdEntry {
  count: number;
  firstSeenAt: number;
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
 * Both maps are pruned periodically (call `prune()` on a cron/interval).
 */
export class PoisonPillDetector {
  private readonly windowMs: number;
  private readonly idThreshold: number;
  private readonly errorThreshold: number;

  // Map from sample id → observation entry within the current window.
  private readonly idMap = new Map<string, IdEntry>();

  // Map from device key → count of consecutive 4xx errors.
  private readonly errorMap = new Map<string, number>();

  constructor(windowMs = 60_000, idThreshold = 3, errorThreshold = 5) {
    this.windowMs = windowMs;
    this.idThreshold = idThreshold;
    this.errorThreshold = errorThreshold;
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
    const current = this.errorMap.get(deviceKey) ?? 0;
    const next = current + 1;
    this.errorMap.set(deviceKey, next);
    return next;
  }

  /**
   * Reset the consecutive 4xx count for a device after a successful ingest.
   */
  recordSuccess(deviceKey: string): void {
    this.errorMap.delete(deviceKey);
  }

  /**
   * Prune ID entries whose time window has expired.
   * Call periodically (e.g. every 5 minutes) to bound memory usage.
   */
  prune(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [id, entry] of this.idMap) {
      if (entry.firstSeenAt < cutoff) {
        this.idMap.delete(id);
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
