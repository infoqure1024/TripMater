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
  private initialized = false;

  constructor(private readonly storage: QueueStorage) {}

  private async ensureInit(): Promise<void> {
    if (this.initialized) { return; }
    this.items = await this.storage.load();
    this.initialized = true;
  }

  async enqueue(sample: LocationSample): Promise<void> {
    await this.ensureInit();
    this.items.push(sample);
    await this.storage.save(this.items);
  }

  async peekBatch(limit: number): Promise<LocationSample[]> {
    await this.ensureInit();
    return this.items.slice(0, limit);
  }

  async ack(ids: string[]): Promise<void> {
    await this.ensureInit();
    const idSet = new Set(ids);
    this.items = this.items.filter(s => !idSet.has(s.id));
    await this.storage.save(this.items);
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
    this.items = this.items.slice(excess);
    await this.storage.save(this.items);
    return excess;
  }
}

export function createDefaultUploadQueue(): UploadQueue {
  return new UploadQueue(new FsQueueStorage());
}
