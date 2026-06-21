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
    this.filePath = filePath ?? `${RNFS.DocumentDirectoryPath}/upload_queue.json`;
  }

  async load(): Promise<LocationSample[]> {
    try {
      const exists = await RNFS.exists(this.filePath);
      if (!exists) { return []; }
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

export class UploadQueue {
  private items: LocationSample[] = [];
  // Single shared promise prevents concurrent callers from each issuing a
  // storage.load() and overwriting each other's in-flight mutations.
  private initPromise: Promise<void> | null = null;

  constructor(private readonly storage: QueueStorage) {}

  private ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.storage.load()
        .then(items => { this.items = items; })
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

  /** Removes the oldest items until the queue is at most `maxSize` entries.
   *  Returns the number of items pruned. */
  async prune(maxSize: number): Promise<number> {
    await this.ensureInit();
    const excess = this.items.length - maxSize;
    if (excess <= 0) { return 0; }
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

export function createDefaultUploadQueue(): UploadQueue {
  return new UploadQueue(new FsQueueStorage());
}
