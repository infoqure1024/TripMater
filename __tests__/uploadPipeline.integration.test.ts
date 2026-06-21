/**
 * Integration tests for the upload pipeline.
 * Tests cross-module scenarios: UploadQueue + BatchUploader + RetryController + HttpUploadClient.
 * All HTTP is mocked via global.fetch; all FS is mocked via InMemoryStorage.
 */

jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/mock/documents',
  exists: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
}));

import { QueueStorage, UploadQueue } from '../src/storage/uploadQueue';
import { BatchUploader } from '../src/core/batchUploader';
import { HttpUploadClient } from '../src/core/uploadClient';
import { RetryController } from '../src/core/retryController';
import { LocationSample } from '../src/core/uploadTypes';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

class InMemoryStorage implements QueueStorage {
  private data: LocationSample[] = [];
  async load() { return [...this.data]; }
  async save(items: LocationSample[]) { this.data = [...items]; }
}

function makeSample(id: string, overrides: Partial<LocationSample> = {}): LocationSample {
  return {
    id,
    deviceId: 'device-1',
    timestamp: Date.now(),
    lat: 35.0,
    lng: 139.0,
    speedMps: 5,
    accuracyM: 5,
    ...overrides,
  };
}

function makePipeline(
  storage: InMemoryStorage,
  fetchMock: jest.Mock,
  opts: { batchSize?: number; backoffMs?: number; flushIntervalMs?: number; maxRetries?: number } = {},
) {
  const { batchSize = 10, backoffMs = 100, flushIntervalMs = 60_000, maxRetries = 3 } = opts;
  const queue = new UploadQueue(storage);
  const client = new HttpUploadClient({ baseUrl: 'https://api.test', path: '/locs', token: 'tok' });
  const uploader = new BatchUploader(queue, client, { batchSize, flushIntervalMs });
  const onAuthError = jest.fn();
  const retry = new RetryController(
    uploader,
    { baseDelayMs: backoffMs, maxDelayMs: backoffMs * 8, jitterFactor: 0, maxRetries },
    onAuthError,
  );
  uploader.setListener(event => {
    retry.handleEvent(event);
  });
  global.fetch = fetchMock;
  return { queue, client, uploader, retry, onAuthError };
}

/** Drain all pending microtasks so fire-and-forget async ops complete. */
const drain = () => new Promise<void>(r => setImmediate(r));

let savedFetch: typeof global.fetch;
beforeEach(() => { savedFetch = global.fetch; });
afterEach(() => {
  global.fetch = savedFetch;
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// End-to-end: fix → enqueue → batch upload → ack → queue empty
// ---------------------------------------------------------------------------
describe('end-to-end pipeline', () => {
  test('three fixes reach batchSize, trigger upload, and leave queue empty', async () => {
    const storage = new InMemoryStorage();
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    const { queue, uploader } = makePipeline(storage, fetchMock, { batchSize: 3 });

    // Mirror production path: onEnqueue called after each individual enqueue
    await queue.enqueue(makeSample('fix-1'));
    await uploader.onEnqueue(); // count=1, no flush
    await queue.enqueue(makeSample('fix-2'));
    await uploader.onEnqueue(); // count=2, no flush
    await queue.enqueue(makeSample('fix-3'));
    await uploader.onEnqueue(); // count=3 === batchSize → flush

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await queue.count()).toBe(0);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.samples.map((s: LocationSample) => s.id)).toEqual(['fix-1', 'fix-2', 'fix-3']);
  });

  test('items below batchSize are not flushed by onEnqueue alone', async () => {
    const storage = new InMemoryStorage();
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    const { queue, uploader } = makePipeline(storage, fetchMock, { batchSize: 5 });

    await queue.enqueue(makeSample('a'));
    await queue.enqueue(makeSample('b'));
    await uploader.onEnqueue(); // count=2 < 5

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await queue.count()).toBe(2);
  });

  test('flushNow sends partial batch and clears queue', async () => {
    const storage = new InMemoryStorage();
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    const { queue, uploader } = makePipeline(storage, fetchMock, { batchSize: 50 });

    await queue.enqueue(makeSample('a'));
    await queue.enqueue(makeSample('b'));
    await uploader.flushNow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await queue.count()).toBe(0);
  });

  test('multi-batch flush drains queue in multiple HTTP requests', async () => {
    const storage = new InMemoryStorage();
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    const { queue, uploader } = makePipeline(storage, fetchMock, { batchSize: 2 });

    for (const id of ['a', 'b', 'c', 'd']) { await queue.enqueue(makeSample(id)); }
    await uploader.flushNow();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await queue.count()).toBe(0);

    const batch1 = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const batch2 = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(batch1.samples.map((s: LocationSample) => s.id)).toEqual(['a', 'b']);
    expect(batch2.samples.map((s: LocationSample) => s.id)).toEqual(['c', 'd']);
  });
});

// ---------------------------------------------------------------------------
// Offline accumulation → connectivity restore → flush
// ---------------------------------------------------------------------------
describe('offline accumulation and connectivity restore', () => {
  test('items accumulated offline are all sent on connectivity restore', async () => {
    const storage = new InMemoryStorage();
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    const { queue, retry } = makePipeline(storage, fetchMock, { batchSize: 100 });

    // Accumulate items while "offline" (no flush triggered — batchSize is high and timer not started)
    await queue.enqueue(makeSample('a'));
    await queue.enqueue(makeSample('b'));
    await queue.enqueue(makeSample('c'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await queue.count()).toBe(3);

    // Simulate connectivity restore
    retry.onConnectivityRestored();
    await drain(); // let flushNow() complete

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await queue.count()).toBe(0);
  });

  test('connectivity restore while already connected is safe (no double-flush)', async () => {
    const storage = new InMemoryStorage();
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    const { queue, retry } = makePipeline(storage, fetchMock, { batchSize: 100 });

    await queue.enqueue(makeSample('a'));

    // Two rapid connectivity-restore signals
    retry.onConnectivityRestored();
    retry.onConnectivityRestored();
    await drain();

    // Only one batch should have been sent (inflight guard prevents double-flush)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await queue.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Upload failure → retry → success
// ---------------------------------------------------------------------------
describe('failure and retry', () => {
  beforeEach(() => jest.useFakeTimers());

  test('server 5xx triggers backoff retry that succeeds on second attempt', async () => {
    const storage = new InMemoryStorage();
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ status: 500 })
      .mockResolvedValue({ status: 200 });
    const { queue, uploader } = makePipeline(storage, fetchMock, { batchSize: 10, backoffMs: 1000 });

    await queue.enqueue(makeSample('a'));

    // First flush: 500 → RetryController schedules retry after 1000ms
    await uploader.flushNow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await queue.count()).toBe(1);

    // Advance to trigger retry
    await jest.advanceTimersByTimeAsync(1000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await queue.count()).toBe(0);
  });

  test('network error (fetch throws) triggers backoff retry', async () => {
    const storage = new InMemoryStorage();
    const fetchMock = jest.fn()
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValue({ status: 200 });
    const { queue, uploader } = makePipeline(storage, fetchMock, { batchSize: 10, backoffMs: 500 });

    await queue.enqueue(makeSample('a'));
    await uploader.flushNow();
    expect(await queue.count()).toBe(1);

    await jest.advanceTimersByTimeAsync(500);
    expect(await queue.count()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('retry does not fire after destroy() is called during backoff window', async () => {
    const storage = new InMemoryStorage();
    const fetchMock = jest.fn().mockResolvedValue({ status: 500 });
    const { queue, uploader, retry } = makePipeline(storage, fetchMock, { batchSize: 10, backoffMs: 2000 });

    await queue.enqueue(makeSample('a'));
    await uploader.flushNow(); // schedules retry in 2000ms

    retry.destroy();
    uploader.stop();

    await jest.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
  });
});

// ---------------------------------------------------------------------------
// 401 / 403 — auth errors
// ---------------------------------------------------------------------------
describe('authentication errors', () => {
  beforeEach(() => jest.useFakeTimers());

  test('401 fires onAuthError callback and items remain in queue (no retry)', async () => {
    const storage = new InMemoryStorage();
    const fetchMock = jest.fn().mockResolvedValue({ status: 401 });
    const { queue, uploader, onAuthError } = makePipeline(storage, fetchMock, { backoffMs: 500 });

    await queue.enqueue(makeSample('a'));
    await uploader.flushNow();

    expect(onAuthError).toHaveBeenCalledWith(401);
    await jest.advanceTimersByTimeAsync(2000); // no retry timer should fire
    expect(fetchMock).toHaveBeenCalledTimes(1); // still just the original attempt
    expect(await queue.count()).toBe(1);
  });

  test('403 fires onAuthError callback and items remain in queue (no retry)', async () => {
    const storage = new InMemoryStorage();
    const fetchMock = jest.fn().mockResolvedValue({ status: 403 });
    const { queue, uploader, onAuthError } = makePipeline(storage, fetchMock, { backoffMs: 500 });

    await queue.enqueue(makeSample('a'));
    await uploader.flushNow();

    expect(onAuthError).toHaveBeenCalledWith(403);
    await jest.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await queue.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// App-kill survival — queue persistence across instances
// ---------------------------------------------------------------------------
describe('app-kill survival (queue persistence)', () => {
  test('items enqueued before kill are uploaded by a new pipeline instance', async () => {
    const storage = new InMemoryStorage();

    // --- Before kill ---
    const q1 = new UploadQueue(storage);
    await q1.enqueue(makeSample('pre-kill-1'));
    await q1.enqueue(makeSample('pre-kill-2'));

    // --- After kill: new instances share the same backing storage ---
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    global.fetch = fetchMock;
    const q2 = new UploadQueue(storage);
    const client = new HttpUploadClient({ baseUrl: 'https://api.test', path: '/locs', token: 'tok' });
    const uploader2 = new BatchUploader(q2, client, { batchSize: 10 });

    await uploader2.flushNow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await q2.count()).toBe(0);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.samples.map((s: LocationSample) => s.id)).toEqual(['pre-kill-1', 'pre-kill-2']);
  });

  test('successfully acked items are not re-sent after kill', async () => {
    const storage = new InMemoryStorage();

    // --- Before kill: enqueue and send 2 items, ack succeeds ---
    const fetchMock1 = jest.fn().mockResolvedValue({ status: 200 });
    global.fetch = fetchMock1;
    const q1 = new UploadQueue(storage);
    const client1 = new HttpUploadClient({ baseUrl: 'https://api.test', path: '/locs', token: 'tok' });
    const u1 = new BatchUploader(q1, client1, { batchSize: 10 });
    await q1.enqueue(makeSample('sent-1'));
    await q1.enqueue(makeSample('sent-2'));
    await u1.flushNow();
    expect(await q1.count()).toBe(0);
    expect(fetchMock1).toHaveBeenCalledTimes(1);

    // --- After kill: new pipeline instance with a fresh fetch mock ---
    const fetchMock2 = jest.fn().mockResolvedValue({ status: 200 });
    global.fetch = fetchMock2;
    const q2 = new UploadQueue(storage);
    const client2 = new HttpUploadClient({ baseUrl: 'https://api.test', path: '/locs', token: 'tok' });
    const u2 = new BatchUploader(q2, client2, { batchSize: 10 });

    expect(await q2.count()).toBe(0); // queue is empty after ack
    await u2.flushNow();
    expect(fetchMock2).not.toHaveBeenCalled(); // empty queue → no HTTP request
  });
});

// ---------------------------------------------------------------------------
// Duplicate id handling — client sends stable ids for server idempotency
// ---------------------------------------------------------------------------
describe('duplicate id / ack failure idempotency', () => {
  test('same ids re-sent when ack fails after successful upload', async () => {
    let failOnNextAck = false;
    let inMemory: LocationSample[] = [];
    // Position-independent flag prevents the fragility of a call-count counter.
    // maxRetries: 0 prevents an implicit 0ms retry timer from racing with the
    // explicit second flushNow() call below.
    const storage: QueueStorage = {
      async load() { return [...inMemory]; },
      async save(items) {
        if (failOnNextAck) { failOnNextAck = false; throw new Error('ack save failed'); }
        inMemory = [...items];
      },
    };

    const queue = new UploadQueue(storage);
    await queue.enqueue(makeSample('id-stable-1'));
    await queue.enqueue(makeSample('id-stable-2'));

    const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    global.fetch = fetchMock;
    const client = new HttpUploadClient({ baseUrl: 'https://api.test', path: '/locs', token: 'tok' });
    const uploader = new BatchUploader(queue, client, { batchSize: 10 });
    const retry = new RetryController(uploader, { baseDelayMs: 0, maxDelayMs: 0, jitterFactor: 0, maxRetries: 0 }, jest.fn());
    uploader.setListener(event => { retry.handleEvent(event); });

    // First flush: upload succeeds (HTTP 200) but ack save fails
    failOnNextAck = true;
    await uploader.flushNow();

    // Ack rolled back — items remain in queue
    expect(await queue.count()).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second flush (manual): same stable ids sent again for server-side idempotency
    await uploader.flushNow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await queue.count()).toBe(0);

    const firstBatch = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const secondBatch = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(firstBatch.samples.map((s: LocationSample) => s.id)).toEqual(['id-stable-1', 'id-stable-2']);
    expect(secondBatch.samples.map((s: LocationSample) => s.id)).toEqual(['id-stable-1', 'id-stable-2']);
  });
});

// ---------------------------------------------------------------------------
// Issue #29: non-retryable 4xx (422) — no retry, periodic timer re-flushes
// ---------------------------------------------------------------------------
describe('non-retryable 4xx handling', () => {
  beforeEach(() => jest.useFakeTimers());

  test('422 triggers no retry; periodic timer re-flushes after flushIntervalMs', async () => {
    const storage = new InMemoryStorage();
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ status: 422 })
      .mockResolvedValue({ status: 200 });
    const { queue, uploader } = makePipeline(storage, fetchMock, {
      backoffMs: 2000,       // backoff delay intentionally long — confirms no retry fires
      flushIntervalMs: 1000,
    });

    await queue.enqueue(makeSample('a'));
    uploader.start();

    // 422 → resetRetry() → no retry timer scheduled
    await uploader.flushNow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await queue.count()).toBe(1);

    // No retry fires within the backoff window (no timer was scheduled)
    await jest.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Periodic timer fires at 1000ms total — item is re-sent and succeeds
    await jest.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await queue.count()).toBe(0);

    uploader.stop();
  });
});

// ---------------------------------------------------------------------------
// Issue #30: maxRetries exhaustion — counter resets, periodic timer re-flushes
// ---------------------------------------------------------------------------
describe('maxRetries exhaustion', () => {
  beforeEach(() => jest.useFakeTimers());

  test('after maxRetries 5xx failures retryCount resets and periodic timer re-flushes', async () => {
    const storage = new InMemoryStorage();
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ status: 500 }) // initial flush
      .mockResolvedValueOnce({ status: 500 }) // retry 1
      .mockResolvedValueOnce({ status: 500 }) // retry 2 = maxRetries → exhausted
      .mockResolvedValue({ status: 200 });    // periodic timer flush
    const { queue, uploader } = makePipeline(storage, fetchMock, {
      maxRetries: 2,
      backoffMs: 100,        // retry 1 at +100ms, retry 2 at +200ms (exponential)
      flushIntervalMs: 1000,
    });

    await queue.enqueue(makeSample('a'));
    uploader.start();

    // Initial flush: 500 → schedules retry #1 at 100ms
    await uploader.flushNow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await queue.count()).toBe(1);

    // Retry #1 fires at 100ms: 500 → schedules retry #2 at 200ms later
    await jest.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Retry #2 fires at 300ms total: retryCount(2) >= maxRetries(2) → reset, no more retries
    await jest.advanceTimersByTimeAsync(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await queue.count()).toBe(1); // items not consumed

    // No retry timer — advancing well past any backoff delay has no effect
    await jest.advanceTimersByTimeAsync(300); // 600ms total
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Periodic timer fires at 1000ms: items re-sent and succeed
    await jest.advanceTimersByTimeAsync(400); // 1000ms total
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(await queue.count()).toBe(0);

    uploader.stop();
  });
});

// ---------------------------------------------------------------------------
// maxSize auto-prune
// ---------------------------------------------------------------------------
describe('maxSize and prune', () => {
  test('prune removes oldest items; subsequent flush sends only remaining items', async () => {
    const storage = new InMemoryStorage();
    const queue = new UploadQueue(storage);

    for (const id of ['old-1', 'old-2', 'new-1', 'new-2', 'new-3']) {
      await queue.enqueue(makeSample(id));
    }

    // Prune to keep only 3 newest
    const pruned = await queue.prune(3);
    expect(pruned).toBe(2);
    expect(await queue.count()).toBe(3);

    const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    global.fetch = fetchMock;
    const client = new HttpUploadClient({ baseUrl: 'https://api.test', path: '/locs', token: 'tok' });
    const uploader = new BatchUploader(queue, client, { batchSize: 10 });

    await uploader.flushNow();

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.samples.map((s: LocationSample) => s.id)).toEqual(['new-1', 'new-2', 'new-3']);
    expect(await queue.count()).toBe(0);
  });

  test('prune to 0 removes all items so flush sends nothing', async () => {
    const storage = new InMemoryStorage();
    const queue = new UploadQueue(storage);

    await queue.enqueue(makeSample('a'));
    await queue.enqueue(makeSample('b'));
    await queue.prune(0);

    const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    global.fetch = fetchMock;
    const client = new HttpUploadClient({ baseUrl: 'https://api.test', path: '/locs', token: 'tok' });
    const uploader = new BatchUploader(queue, client, { batchSize: 10 });

    await uploader.flushNow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pipeline teardown — no post-stop activity
// ---------------------------------------------------------------------------
describe('pipeline teardown safety', () => {
  beforeEach(() => jest.useFakeTimers());

  test('uploader.stop() prevents timer-triggered flushes after teardown', async () => {
    const storage = new InMemoryStorage();
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    const queue = new UploadQueue(storage);
    global.fetch = fetchMock;
    const client = new HttpUploadClient({ baseUrl: 'https://api.test', path: '/locs', token: 'tok' });
    const uploader = new BatchUploader(queue, client, { batchSize: 10, flushIntervalMs: 1000 });

    await queue.enqueue(makeSample('a'));
    uploader.start();
    uploader.stop(); // teardown before timer fires

    await jest.advanceTimersByTimeAsync(5000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('flushNow() is a no-op after stop()', async () => {
    const storage = new InMemoryStorage();
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    const queue = new UploadQueue(storage);
    global.fetch = fetchMock;
    const client = new HttpUploadClient({ baseUrl: 'https://api.test', path: '/locs', token: 'tok' });
    const uploader = new BatchUploader(queue, client, { batchSize: 10 });

    await queue.enqueue(makeSample('a'));
    uploader.stop();
    await uploader.flushNow(); // must be no-op

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await queue.count()).toBe(1); // item not consumed
  });

  test('RetryController.handleEvent() is a no-op after destroy()', async () => {
    const fakeUploader = { flushNow: jest.fn<Promise<void>, []>().mockResolvedValue(undefined) };
    const retry = new RetryController(fakeUploader, { baseDelayMs: 100, maxDelayMs: 1000, jitterFactor: 0, maxRetries: 3 });

    retry.destroy();
    retry.handleEvent({ type: 'failure', result: { ok: false, status: 500, retryable: true } });

    await jest.advanceTimersByTimeAsync(500);
    expect(fakeUploader.flushNow).not.toHaveBeenCalled();
  });
});
