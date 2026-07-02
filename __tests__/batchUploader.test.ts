/**
 * Tests for BatchUploader logic.
 * Queue and UploadClient are mocked — no FS or network dependencies.
 */

jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/mock/documents',
  exists: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
}));

import {
  BatchUploader,
  UploadConfig,
  UploadEvent,
} from '../src/core/batchUploader';
import { UploadQueue, QueueStorage } from '../src/storage/uploadQueue';
import {
  LocationSample,
  UploadClient,
  UploadResult,
} from '../src/core/uploadTypes';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class InMemoryStorage implements QueueStorage {
  private data: LocationSample[] = [];
  async load() {
    return [...this.data];
  }
  async save(items: LocationSample[]) {
    this.data = [...items];
  }
}

function makeSample(id: string): LocationSample {
  return {
    id,
    deviceId: 'device-1',
    timestamp: Date.now(),
    lat: 35.0,
    lng: 139.0,
    speedMps: 0,
    accuracyM: 10,
  };
}

function makeClient(result: UploadResult): jest.Mocked<UploadClient> {
  return { upload: jest.fn().mockResolvedValue(result) };
}

const OK: UploadResult = { ok: true, status: 200, retryable: false };
const SERVER_ERROR: UploadResult = { ok: false, status: 500, retryable: true };
const AUTH_ERROR: UploadResult = { ok: false, status: 401, retryable: false };

function makeUploader(
  storage: QueueStorage,
  client: UploadClient,
  config: Partial<UploadConfig> = {},
): [BatchUploader, UploadQueue] {
  const queue = new UploadQueue(storage);
  const uploader = new BatchUploader(queue, client, config);
  return [uploader, queue];
}

// ---------------------------------------------------------------------------
// Count-trigger
// ---------------------------------------------------------------------------
describe('count trigger', () => {
  test('onEnqueue triggers flush when pending count reaches batchSize', async () => {
    const storage = new InMemoryStorage();
    const client = makeClient(OK);
    const [uploader, queue] = makeUploader(storage, client, { batchSize: 3 });
    await queue.enqueue(makeSample('a'));
    await queue.enqueue(makeSample('b'));
    await queue.enqueue(makeSample('c'));
    await uploader.onEnqueue(); // count is now 3 = batchSize
    expect(client.upload).toHaveBeenCalledTimes(1);
    expect(await queue.count()).toBe(0);
  });

  test('onEnqueue does not flush when count is below batchSize', async () => {
    const storage = new InMemoryStorage();
    const client = makeClient(OK);
    const [uploader, queue] = makeUploader(storage, client, { batchSize: 5 });
    await queue.enqueue(makeSample('a'));
    await uploader.onEnqueue(); // count=1 < 5
    expect(client.upload).not.toHaveBeenCalled();
  });

  test('flushNow always triggers upload regardless of count', async () => {
    const storage = new InMemoryStorage();
    const client = makeClient(OK);
    const [uploader, queue] = makeUploader(storage, client, { batchSize: 100 });
    await queue.enqueue(makeSample('a'));
    await uploader.flushNow();
    expect(client.upload).toHaveBeenCalledTimes(1);
    expect(await queue.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Timer trigger
// ---------------------------------------------------------------------------
describe('timer trigger', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
  });

  test('flush fires after flushIntervalMs via start()', async () => {
    const storage = new InMemoryStorage();
    const client = makeClient(OK);
    const [uploader, queue] = makeUploader(storage, client, {
      flushIntervalMs: 5000,
    });
    await queue.enqueue(makeSample('a'));
    uploader.start();
    await jest.advanceTimersByTimeAsync(5000);
    expect(client.upload).toHaveBeenCalledTimes(1);
    uploader.stop();
  });

  test('stop() cancels the timer so no further flushes occur', async () => {
    const storage = new InMemoryStorage();
    const client = makeClient(OK);
    const [uploader, queue] = makeUploader(storage, client, {
      flushIntervalMs: 5000,
    });
    await queue.enqueue(makeSample('a'));
    uploader.start();
    uploader.stop();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(client.upload).not.toHaveBeenCalled();
  });

  test('start() is idempotent — calling twice does not double-fire', async () => {
    const storage = new InMemoryStorage();
    const client = makeClient(OK);
    const [uploader, queue] = makeUploader(storage, client, {
      flushIntervalMs: 5000,
    });
    await queue.enqueue(makeSample('a'));
    uploader.start();
    uploader.start(); // second call must be no-op
    await jest.advanceTimersByTimeAsync(5000);
    expect(client.upload).toHaveBeenCalledTimes(1);
    uploader.stop();
  });
});

// ---------------------------------------------------------------------------
// Success path: ack and multi-batch continuation
// ---------------------------------------------------------------------------
describe('success path', () => {
  test('successful upload removes acked items from the queue', async () => {
    const storage = new InMemoryStorage();
    const client = makeClient(OK);
    const [uploader, queue] = makeUploader(storage, client, { batchSize: 10 });
    await queue.enqueue(makeSample('a'));
    await queue.enqueue(makeSample('b'));
    await uploader.flushNow();
    expect(await queue.count()).toBe(0);
  });

  test('flush loops until queue is empty when items span multiple batches', async () => {
    const storage = new InMemoryStorage();
    const client = makeClient(OK);
    const [uploader, queue] = makeUploader(storage, client, { batchSize: 2 });
    for (const id of ['a', 'b', 'c', 'd']) {
      await queue.enqueue(makeSample(id));
    }
    await uploader.flushNow();
    expect(client.upload).toHaveBeenCalledTimes(2);
    expect(await queue.count()).toBe(0);
  });

  test('partial batch (count < batchSize) is sent and loop stops', async () => {
    const storage = new InMemoryStorage();
    const client = makeClient(OK);
    const [uploader, queue] = makeUploader(storage, client, { batchSize: 10 });
    await queue.enqueue(makeSample('a'));
    await queue.enqueue(makeSample('b'));
    await uploader.flushNow();
    expect(client.upload).toHaveBeenCalledTimes(1);
  });

  test('listener receives success event with correct count', async () => {
    const storage = new InMemoryStorage();
    const client = makeClient(OK);
    const [uploader, queue] = makeUploader(storage, client, { batchSize: 10 });
    const events: UploadEvent[] = [];
    uploader.setListener(e => events.push(e));
    await queue.enqueue(makeSample('a'));
    await queue.enqueue(makeSample('b'));
    await uploader.flushNow();
    expect(events).toEqual([{ type: 'success', count: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// Failure path: items remain in queue
// ---------------------------------------------------------------------------
describe('failure path', () => {
  test('failed upload leaves items in the queue', async () => {
    const storage = new InMemoryStorage();
    const client = makeClient(SERVER_ERROR);
    const [uploader, queue] = makeUploader(storage, client, { batchSize: 10 });
    await queue.enqueue(makeSample('a'));
    await uploader.flushNow();
    expect(await queue.count()).toBe(1);
  });

  test('listener receives failure event with the UploadResult on non-ok response', async () => {
    const storage = new InMemoryStorage();
    const client = makeClient(AUTH_ERROR);
    const [uploader, queue] = makeUploader(storage, client);
    const events: UploadEvent[] = [];
    uploader.setListener(e => events.push(e));
    await queue.enqueue(makeSample('a'));
    await uploader.flushNow();
    expect(events).toEqual([{ type: 'failure', result: AUTH_ERROR }]);
  });

  test('listener receives error event when client.upload() throws', async () => {
    const storage = new InMemoryStorage();
    const client = {
      upload: jest.fn().mockRejectedValue(new Error('network down')),
    };
    const [uploader, queue] = makeUploader(storage, client);
    const events: UploadEvent[] = [];
    uploader.setListener(e => events.push(e));
    await queue.enqueue(makeSample('a'));
    await uploader.flushNow();
    expect(events[0].type).toBe('error');
    expect(await queue.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Dead-letter / poison-pill batch eviction (Issue #49)
// ---------------------------------------------------------------------------
describe('dead-letter after repeated consecutive failures', () => {
  test('head batch is evicted after maxConsecutiveFailures in a row, unblocking later data in the same flush', async () => {
    const storage = new InMemoryStorage();
    const upload = jest.fn(async (batch: LocationSample[]) =>
      batch.some(s => s.id === 'a') ? SERVER_ERROR : OK,
    );
    const client: UploadClient = { upload };
    const [uploader, queue] = makeUploader(storage, client, {
      batchSize: 1,
      maxConsecutiveFailures: 3,
    });
    const events: UploadEvent[] = [];
    uploader.setListener(e => events.push(e));

    await queue.enqueue(makeSample('a'));
    await queue.enqueue(makeSample('b'));

    await uploader.flushNow(); // attempt 1 on 'a': fails
    await uploader.flushNow(); // attempt 2 on 'a': fails
    await uploader.flushNow(); // attempt 3 on 'a': fails -> dead-lettered, then 'b' is sent in the same call

    expect(events.filter(e => e.type === 'failure')).toHaveLength(2);
    expect(events.filter(e => e.type === 'dead_letter')).toHaveLength(1);
    expect(events.filter(e => e.type === 'success')).toHaveLength(1);
    expect(await queue.count()).toBe(0);
    expect(queue.getDeadLetterCount()).toBe(1);
  });

  test('failures below the threshold leave the batch in the queue (not evicted)', async () => {
    const storage = new InMemoryStorage();
    const client = makeClient(SERVER_ERROR);
    const [uploader, queue] = makeUploader(storage, client, {
      batchSize: 10,
      maxConsecutiveFailures: 5,
    });
    await queue.enqueue(makeSample('a'));
    for (let i = 0; i < 4; i++) {
      await uploader.flushNow();
    }
    expect(await queue.count()).toBe(1);
    expect(queue.getDeadLetterCount()).toBe(0);
  });

  test('non-retryable (4xx/auth) failures count toward eviction the same as retryable ones', async () => {
    const storage = new InMemoryStorage();
    const client = makeClient(AUTH_ERROR); // 401, non-retryable
    const [uploader, queue] = makeUploader(storage, client, {
      batchSize: 10,
      maxConsecutiveFailures: 2,
    });
    const events: UploadEvent[] = [];
    uploader.setListener(e => events.push(e));
    await queue.enqueue(makeSample('a'));
    await uploader.flushNow(); // fail 1
    await uploader.flushNow(); // fail 2 -> evicted
    expect(events.filter(e => e.type === 'dead_letter')).toHaveLength(1);
    expect(await queue.count()).toBe(0);
  });

  test('consecutive-failure counter resets after success, so a later batch needs its own full streak', async () => {
    const storage = new InMemoryStorage();
    const results: Record<string, UploadResult> = {};
    const upload = jest.fn(
      async (batch: LocationSample[]) => results[batch[0].id] ?? OK,
    );
    const client: UploadClient = { upload };
    const [uploader, queue] = makeUploader(storage, client, {
      batchSize: 1,
      maxConsecutiveFailures: 3,
    });

    await queue.enqueue(makeSample('a'));
    results.a = SERVER_ERROR;
    await uploader.flushNow(); // fail 1
    await uploader.flushNow(); // fail 2
    results.a = OK;
    await uploader.flushNow(); // recovers -> acked, counter reset
    expect(await queue.count()).toBe(0);

    await queue.enqueue(makeSample('b'));
    results.b = SERVER_ERROR;
    await uploader.flushNow(); // fail 1 for 'b'
    await uploader.flushNow(); // fail 2 for 'b' (would be fail 4 if counter hadn't reset)
    expect(await queue.count()).toBe(1); // still present, not yet evicted
    expect(queue.getDeadLetterCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Inflight guard — double-fire prevention
// ---------------------------------------------------------------------------
describe('inflight guard', () => {
  test('concurrent flushNow calls do not send the same batch twice', async () => {
    const storage = new InMemoryStorage();
    let resolveUpload!: () => void;
    const blocked = new Promise<UploadResult>(resolve => {
      resolveUpload = () => resolve(OK);
    });
    const client = {
      upload: jest.fn().mockReturnValueOnce(blocked).mockResolvedValue(OK),
    };
    const [uploader, queue] = makeUploader(storage, client, { batchSize: 10 });
    await queue.enqueue(makeSample('a'));

    const first = uploader.flushNow(); // starts, blocked on upload
    const second = uploader.flushNow(); // should be no-op because inflight=true
    resolveUpload();
    await Promise.all([first, second]);

    expect(client.upload).toHaveBeenCalledTimes(1);
    expect(await queue.count()).toBe(0);
  });

  test('onEnqueue during an active flush does not double-send', async () => {
    const storage = new InMemoryStorage();
    let resolveUpload!: () => void;
    const blocked = new Promise<UploadResult>(resolve => {
      resolveUpload = () => resolve(OK);
    });
    const client = {
      upload: jest.fn().mockReturnValueOnce(blocked).mockResolvedValue(OK),
    };
    const [uploader, queue] = makeUploader(storage, client, { batchSize: 1 });
    await queue.enqueue(makeSample('a'));

    const flush = uploader.flushNow(); // inflight
    await uploader.onEnqueue(); // should be skipped
    resolveUpload();
    await flush;

    expect(client.upload).toHaveBeenCalledTimes(1);
    expect(await queue.count()).toBe(0);
  });
});
