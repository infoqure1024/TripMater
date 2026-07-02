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

import {
  DEFAULT_MAX_QUEUE_SIZE,
  QueueStorage,
  UploadQueue,
} from '../src/storage/uploadQueue';
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
  snapshot(): LocationSample[] {
    return [...this.data];
  }
}

function makeSample(
  id: string,
  overrides: Partial<LocationSample> = {},
): LocationSample {
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
    for (let i = 0; i < 5; i++) {
      await q.enqueue(makeSample(`s${i}`));
    }
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
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      await q.enqueue(makeSample(id));
    }
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
    for (const id of ['a', 'b', 'c']) {
      await q.enqueue(makeSample(id));
    }
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
// maxSize auto-prune on enqueue (Issue #49)
// ---------------------------------------------------------------------------
describe('maxSize auto-prune on enqueue', () => {
  test('enqueue prunes the oldest item once maxSize is exceeded', async () => {
    const storage = new InMemoryStorage();
    const q = new UploadQueue(storage, { maxSize: 3 });
    for (const id of ['a', 'b', 'c']) {
      await q.enqueue(makeSample(id));
    }
    await q.enqueue(makeSample('d')); // now 4 > maxSize=3 -> prunes oldest ('a')
    const ids = (await q.peekBatch(10)).map(s => s.id);
    expect(ids).toEqual(['b', 'c', 'd']);
    expect(await q.count()).toBe(3);
  });

  test('enqueue does not prune while at or under maxSize', async () => {
    const storage = new InMemoryStorage();
    const q = new UploadQueue(storage, { maxSize: 3 });
    for (const id of ['a', 'b', 'c']) {
      await q.enqueue(makeSample(id));
    }
    expect(await q.count()).toBe(3);
  });

  test('setMaxSize adjusts the cap applied on subsequent enqueues', async () => {
    const storage = new InMemoryStorage();
    const q = new UploadQueue(storage, { maxSize: 10 });
    await q.enqueue(makeSample('a'));
    await q.enqueue(makeSample('b'));
    q.setMaxSize(1);
    await q.enqueue(makeSample('c')); // now over the new cap of 1 -> prunes down to ['c']
    const ids = (await q.peekBatch(10)).map(s => s.id);
    expect(ids).toEqual(['c']);
  });

  test('default maxSize is DEFAULT_MAX_QUEUE_SIZE when no option is given', async () => {
    const storage = new InMemoryStorage();
    const q = new UploadQueue(storage);
    for (let i = 0; i < 5; i++) {
      await q.enqueue(makeSample(`s${i}`));
    }
    expect(await q.count()).toBe(5); // far below default cap — nothing pruned
    expect(DEFAULT_MAX_QUEUE_SIZE).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// deadLetter (Issue #49)
// ---------------------------------------------------------------------------
describe('deadLetter', () => {
  test('deadLetter removes the given IDs, same as ack', async () => {
    const [q] = makeQueue();
    await q.enqueue(makeSample('a'));
    await q.enqueue(makeSample('b'));
    await q.deadLetter(['a']);
    const ids = (await q.peekBatch(10)).map(s => s.id);
    expect(ids).toEqual(['b']);
    expect(await q.count()).toBe(1);
  });

  test('deadLetter increments the diagnostic counter by the number of items evicted', async () => {
    const [q] = makeQueue();
    await q.enqueue(makeSample('a'));
    await q.enqueue(makeSample('b'));
    expect(q.getDeadLetterCount()).toBe(0);
    await q.deadLetter(['a']);
    expect(q.getDeadLetterCount()).toBe(1);
    await q.deadLetter(['b']);
    expect(q.getDeadLetterCount()).toBe(2);
  });

  test('deadLetter does not increment the counter when the underlying save fails', async () => {
    const storage: QueueStorage = {
      async load() {
        return [];
      },
      async save() {
        throw new Error('disk full');
      },
    };
    const q = new UploadQueue(storage);
    await expect(q.deadLetter(['a'])).rejects.toThrow('disk full');
    expect(q.getDeadLetterCount()).toBe(0);
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
      if (this.shouldFail) {
        throw new Error('disk full');
      }
      return super.save(items);
    }
  }

  test('enqueue rolls back in-memory state when save fails', async () => {
    const storage = new FailingStorage();
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

  test('prune rolls back in-memory state when save fails', async () => {
    const storage = new FailingStorage();
    const q = new UploadQueue(storage);
    for (const id of ['a', 'b', 'c']) {
      await q.enqueue(makeSample(id));
    }
    storage.shouldFail = true;
    await expect(q.prune(1)).rejects.toThrow('disk full');
    expect(await q.count()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Init failure resilience
// ---------------------------------------------------------------------------
describe('init failure resilience', () => {
  test('queue retries load after a transient storage.load() failure', async () => {
    let callCount = 0;
    const flakyStorage: QueueStorage = {
      async load() {
        callCount++;
        if (callCount === 1) {
          throw new Error('transient read error');
        }
        return [];
      },
      async save() {},
    };
    const q = new UploadQueue(flakyStorage);
    await expect(q.count()).rejects.toThrow('transient read error');
    // Second call should retry the load and succeed
    expect(await q.count()).toBe(0);
    expect(callCount).toBe(2);
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
