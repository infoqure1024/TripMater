/**
 * Tests for UploadQueue logic using an in-memory QueueStorage stub.
 * No React Native or FS dependencies — pure logic verification.
 */

// FsQueueStorage uses react-native-fs; mock it so the module can be loaded
// in Jest without native binaries. Tests use InMemoryStorage exclusively.
jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/mock/documents',
  exists: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
}));

import { QueueStorage, UploadQueue } from '../src/storage/uploadQueue';
import { LocationSample } from '../src/core/uploadTypes';

// ---------------------------------------------------------------------------
// In-memory storage stub — simulates persistence without touching the FS
// ---------------------------------------------------------------------------
class InMemoryStorage implements QueueStorage {
  private data: LocationSample[] = [];

  async load(): Promise<LocationSample[]> {
    return [...this.data];
  }

  async save(items: LocationSample[]): Promise<void> {
    this.data = [...items];
  }

  /** Expose persisted data for cross-instance tests */
  snapshot(): LocationSample[] { return [...this.data]; }
}

function makeSample(id: string, overrides: Partial<LocationSample> = {}): LocationSample {
  return {
    id,
    deviceId: 'device-1',
    timestamp: Date.now(),
    lat: 35.0,
    lng: 139.0,
    speedMps: 0,
    accuracyM: 10,
    ...overrides,
  };
}

function makeQueue(storage?: QueueStorage): [UploadQueue, InMemoryStorage] {
  const s = (storage as InMemoryStorage) ?? new InMemoryStorage();
  return [new UploadQueue(s), s];
}

// ---------------------------------------------------------------------------
// enqueue / peekBatch
// ---------------------------------------------------------------------------
describe('enqueue + peekBatch', () => {
  test('single enqueue is returned by peekBatch', async () => {
    const [q] = makeQueue();
    await q.enqueue(makeSample('a'));
    const batch = await q.peekBatch(10);
    expect(batch).toHaveLength(1);
    expect(batch[0].id).toBe('a');
  });

  test('peekBatch returns items in insertion order (oldest first)', async () => {
    const [q] = makeQueue();
    await q.enqueue(makeSample('a'));
    await q.enqueue(makeSample('b'));
    await q.enqueue(makeSample('c'));
    const batch = await q.peekBatch(10);
    expect(batch.map(s => s.id)).toEqual(['a', 'b', 'c']);
  });

  test('peekBatch respects limit and does not exceed it', async () => {
    const [q] = makeQueue();
    for (let i = 0; i < 5; i++) { await q.enqueue(makeSample(`s${i}`)); }
    const batch = await q.peekBatch(3);
    expect(batch).toHaveLength(3);
    expect(batch.map(s => s.id)).toEqual(['s0', 's1', 's2']);
  });

  test('peekBatch returns all items when limit > queue size', async () => {
    const [q] = makeQueue();
    await q.enqueue(makeSample('x'));
    await q.enqueue(makeSample('y'));
    const batch = await q.peekBatch(100);
    expect(batch).toHaveLength(2);
  });

  test('peekBatch on empty queue returns empty array', async () => {
    const [q] = makeQueue();
    expect(await q.peekBatch(10)).toEqual([]);
  });

  test('peekBatch does not remove items from the queue', async () => {
    const [q] = makeQueue();
    await q.enqueue(makeSample('a'));
    await q.peekBatch(10);
    expect(await q.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ack
// ---------------------------------------------------------------------------
describe('ack', () => {
  test('ack removes exactly the acknowledged IDs', async () => {
    const [q] = makeQueue();
    await q.enqueue(makeSample('a'));
    await q.enqueue(makeSample('b'));
    await q.enqueue(makeSample('c'));
    await q.ack(['a', 'c']);
    const remaining = await q.peekBatch(10);
    expect(remaining.map(s => s.id)).toEqual(['b']);
  });

  test('ack with unknown IDs is a no-op for existing items', async () => {
    const [q] = makeQueue();
    await q.enqueue(makeSample('a'));
    await q.ack(['nonexistent']);
    expect(await q.count()).toBe(1);
  });

  test('ack with empty array changes nothing', async () => {
    const [q] = makeQueue();
    await q.enqueue(makeSample('a'));
    await q.ack([]);
    expect(await q.count()).toBe(1);
  });

  test('ack all items leaves queue empty', async () => {
    const [q] = makeQueue();
    await q.enqueue(makeSample('a'));
    await q.enqueue(makeSample('b'));
    await q.ack(['a', 'b']);
    expect(await q.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// count
// ---------------------------------------------------------------------------
describe('count', () => {
  test('count on empty queue is 0', async () => {
    const [q] = makeQueue();
    expect(await q.count()).toBe(0);
  });

  test('count reflects enqueue operations', async () => {
    const [q] = makeQueue();
    await q.enqueue(makeSample('a'));
    await q.enqueue(makeSample('b'));
    expect(await q.count()).toBe(2);
  });

  test('count decrements after ack', async () => {
    const [q] = makeQueue();
    await q.enqueue(makeSample('a'));
    await q.enqueue(makeSample('b'));
    await q.ack(['a']);
    expect(await q.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------
describe('prune', () => {
  test('prune removes oldest items to reach maxSize', async () => {
    const [q] = makeQueue();
    for (const id of ['a', 'b', 'c', 'd', 'e']) { await q.enqueue(makeSample(id)); }
    const pruned = await q.prune(3);
    expect(pruned).toBe(2);
    const remaining = await q.peekBatch(10);
    expect(remaining.map(s => s.id)).toEqual(['c', 'd', 'e']);
  });

  test('prune returns 0 when count <= maxSize', async () => {
    const [q] = makeQueue();
    await q.enqueue(makeSample('a'));
    await q.enqueue(makeSample('b'));
    const pruned = await q.prune(5);
    expect(pruned).toBe(0);
    expect(await q.count()).toBe(2);
  });

  test('prune with maxSize equal to count removes nothing', async () => {
    const [q] = makeQueue();
    await q.enqueue(makeSample('a'));
    await q.enqueue(makeSample('b'));
    const pruned = await q.prune(2);
    expect(pruned).toBe(0);
    expect(await q.count()).toBe(2);
  });

  test('prune with maxSize=0 removes all items', async () => {
    const [q] = makeQueue();
    for (const id of ['a', 'b', 'c']) { await q.enqueue(makeSample(id)); }
    const pruned = await q.prune(0);
    expect(pruned).toBe(3);
    expect(await q.count()).toBe(0);
  });

  test('prune on empty queue is a no-op returning 0', async () => {
    const [q] = makeQueue();
    expect(await q.prune(5)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrent init safety
// ---------------------------------------------------------------------------
describe('concurrent init safety', () => {
  test('two concurrent enqueues before init both persist their items', async () => {
    const storage = new InMemoryStorage();
    const q = new UploadQueue(storage);
    // Fire both without awaiting either — concurrent init race condition
    await Promise.all([q.enqueue(makeSample('a')), q.enqueue(makeSample('b'))]);
    expect(await q.count()).toBe(2);
    const ids = (await q.peekBatch(10)).map(s => s.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// Save failure rollback
// ---------------------------------------------------------------------------
describe('save failure rollback', () => {
  class FailingStorage extends InMemoryStorage {
    shouldFail = false;
    async save(items: LocationSample[]): Promise<void> {
      if (this.shouldFail) { throw new Error('disk full'); }
      return super.save(items);
    }
  }

  test('enqueue rolls back in-memory state when save fails', async () => {
    const storage = new FailingStorage();
    const q = new UploadQueue(new InMemoryStorage()); // use clean queue
    const q2 = new UploadQueue(storage);
    await q2.enqueue(makeSample('a')); // succeeds
    storage.shouldFail = true;
    await expect(q2.enqueue(makeSample('b'))).rejects.toThrow('disk full');
    expect(await q2.count()).toBe(1); // 'b' rolled back
    const ids = (await q2.peekBatch(10)).map(s => s.id);
    expect(ids).toEqual(['a']);
  });

  test('ack rolls back in-memory state when save fails', async () => {
    const storage = new FailingStorage();
    const q = new UploadQueue(storage);
    await q.enqueue(makeSample('a'));
    await q.enqueue(makeSample('b'));
    storage.shouldFail = true;
    await expect(q.ack(['a'])).rejects.toThrow('disk full');
    // 'a' must still be in memory after rollback
    expect(await q.count()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Persistence (cross-instance survival)
// ---------------------------------------------------------------------------
describe('persistence', () => {
  test('enqueued items survive across UploadQueue instances sharing the same storage', async () => {
    const storage = new InMemoryStorage();
    const q1 = new UploadQueue(storage);
    await q1.enqueue(makeSample('a'));
    await q1.enqueue(makeSample('b'));

    // New instance reads from the same backing storage
    const q2 = new UploadQueue(storage);
    expect(await q2.count()).toBe(2);
    const batch = await q2.peekBatch(10);
    expect(batch.map(s => s.id)).toEqual(['a', 'b']);
  });

  test('ack is persisted so a new instance does not see acknowledged items', async () => {
    const storage = new InMemoryStorage();
    const q1 = new UploadQueue(storage);
    await q1.enqueue(makeSample('a'));
    await q1.enqueue(makeSample('b'));
    await q1.ack(['a']);

    const q2 = new UploadQueue(storage);
    const batch = await q2.peekBatch(10);
    expect(batch.map(s => s.id)).toEqual(['b']);
  });
});
