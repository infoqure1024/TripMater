import RNFS from 'react-native-fs';
import { LocationSample } from '../core/uploadTypes';

// ---------------------------------------------------------------------------
// Storage abstraction — swappable for SQLite without touching queue logic
// ---------------------------------------------------------------------------

export interface QueueStorage {
  load(): Promise<LocationSample[]>;
  save(items: LocationSample[]): Promise<void>;
}

export class FsQueueStorage implements QueueStorage {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath =
      filePath ?? `${RNFS.DocumentDirectoryPath}/upload_queue.json`;
  }

  async load(): Promise<LocationSample[]> {
    try {
      const exists = await RNFS.exists(this.filePath);
      if (!exists) {
        return [];
      }
      const raw = await RNFS.readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as LocationSample[];
    } catch {
      return [];
    }
  }

  async save(items: LocationSample[]): Promise<void> {
    await RNFS.writeFile(this.filePath, JSON.stringify(items), 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Queue logic — independent of the storage backend
// ---------------------------------------------------------------------------

export interface UploadQueueOptions {
  /** Hard cap on queue length; oldest items are pruned once this is exceeded. */
  maxSize?: number;
}

// 10k samples at ~1 fix/sec ≈ ~3 hours of continuous driving, or many days of
// intermittent use. A single sample serializes to well under 1KB, so this
// keeps the on-disk JSON queue file in the low single-digit MB range even if
// the head of the queue is stuck (Issue #49: poison-pill batch) or the device
// is offline for an extended period.
export const DEFAULT_MAX_QUEUE_SIZE = 10_000;

export class UploadQueue {
  private items: LocationSample[] = [];
  // Single shared promise prevents concurrent callers from each issuing a
  // storage.load() and overwriting each other's in-flight mutations.
  private initPromise: Promise<void> | null = null;
  private maxSize: number;
  // In-memory only (not persisted) — diagnostic counter for how many items
  // have been evicted via deadLetter() since this instance was created.
  private deadLetterCount = 0;

  constructor(
    private readonly storage: QueueStorage,
    options: UploadQueueOptions = {},
  ) {
    this.maxSize = options.maxSize ?? DEFAULT_MAX_QUEUE_SIZE;
  }

  /** Adjust the max queue size at runtime (e.g. when persisted config loads). */
  setMaxSize(maxSize: number): void {
    this.maxSize = maxSize;
  }

  private ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.storage
        .load()
        .then(items => {
          this.items = items;
        })
        .catch(e => {
          // Allow retry on next call rather than permanently bricking the queue.
          this.initPromise = null;
          throw e;
        });
    }
    return this.initPromise;
  }

  async enqueue(sample: LocationSample): Promise<void> {
    await this.ensureInit();
    this.items.push(sample);
    try {
      await this.storage.save(this.items);
    } catch (e) {
      this.items.pop();
      throw e;
    }
    // Enforce the hard cap so a stuck head-of-line batch (Issue #49) or a
    // prolonged offline period can't grow the on-disk queue without bound.
    // Best-effort: the new sample is already safely persisted above, so a
    // failure to persist the prune isn't fatal to this enqueue — it will be
    // retried on the next enqueue call.
    if (this.items.length > this.maxSize) {
      try {
        await this.prune(this.maxSize);
      } catch {
        /* see comment above — retried next time */
      }
    }
  }

  async peekBatch(limit: number): Promise<LocationSample[]> {
    await this.ensureInit();
    return this.items.slice(0, limit);
  }

  async ack(ids: string[]): Promise<void> {
    await this.ensureInit();
    const idSet = new Set(ids);
    const prev = this.items;
    this.items = this.items.filter(s => !idSet.has(s.id));
    try {
      await this.storage.save(this.items);
    } catch (e) {
      this.items = prev;
      throw e;
    }
  }

  async count(): Promise<number> {
    await this.ensureInit();
    return this.items.length;
  }

  /**
   * Evicts items by ID without treating them as delivered — used by
   * BatchUploader (Issue #49) when a batch at the head of the queue has
   * failed too many times in a row and must be removed so later data isn't
   * blocked forever. Persistence-wise this is identical to ack(); the only
   * difference is intent, tracked via deadLetterCount() for diagnostics.
   */
  async deadLetter(ids: string[]): Promise<void> {
    await this.ack(ids);
    this.deadLetterCount += ids.length;
  }

  /** Total items evicted via deadLetter() since this instance was created.
   *  In-memory only (not persisted) — for diagnostics/telemetry. */
  getDeadLetterCount(): number {
    return this.deadLetterCount;
  }

  /** Removes the oldest items until the queue is at most `maxSize` entries.
   *  Returns the number of items pruned. */
  async prune(maxSize: number): Promise<number> {
    await this.ensureInit();
    const excess = this.items.length - maxSize;
    if (excess <= 0) {
      return 0;
    }
    const prev = this.items;
    this.items = this.items.slice(excess);
    try {
      await this.storage.save(this.items);
    } catch (e) {
      this.items = prev;
      throw e;
    }
    return excess;
  }
}

export function createDefaultUploadQueue(
  options?: UploadQueueOptions,
): UploadQueue {
  return new UploadQueue(new FsQueueStorage(), options);
}
