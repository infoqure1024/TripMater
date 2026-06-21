/**
 * Tests for RetryController and calculateBackoffMs.
 * No React Native dependencies — pure logic.
 */
import {
  BackoffConfig,
  calculateBackoffMs,
  DEFAULT_BACKOFF_CONFIG,
  RetryController,
} from '../src/core/retryController';
import { UploadEvent } from '../src/core/batchUploader';

// ---------------------------------------------------------------------------
// calculateBackoffMs — pure function
// ---------------------------------------------------------------------------
describe('calculateBackoffMs', () => {
  const cfg: BackoffConfig = {
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    jitterFactor: 0.2,
    maxRetries: 5,
  };
  const noJitter = () => 0.5; // random()=0.5 → jitter term = 0

  test('attempt=0 returns baseDelayMs (no jitter)', () => {
    expect(calculateBackoffMs(0, cfg, noJitter)).toBe(1000);
  });

  test('attempt=1 returns 2×baseDelayMs', () => {
    expect(calculateBackoffMs(1, cfg, noJitter)).toBe(2000);
  });

  test('attempt=2 returns 4×baseDelayMs', () => {
    expect(calculateBackoffMs(2, cfg, noJitter)).toBe(4000);
  });

  test('delay is clamped to maxDelayMs', () => {
    // attempt=10 → 1000×1024 >> 30000, should clamp
    expect(calculateBackoffMs(10, cfg, noJitter)).toBe(30_000);
  });

  test('jitter adds ±jitterFactor × clamped delay', () => {
    const maxRandom = () => 1;   // max positive jitter → +20%
    const minRandom = () => 0;   // max negative jitter → -20%
    const noRandom  = () => 0.5; // zero jitter
    const base = 1000;
    expect(calculateBackoffMs(0, cfg, noRandom)).toBe(base);
    expect(calculateBackoffMs(0, cfg, maxRandom)).toBe(Math.round(base * 1.2));
    expect(calculateBackoffMs(0, cfg, minRandom)).toBe(Math.round(base * 0.8));
  });

  test('result is never negative', () => {
    const extremeJitter: BackoffConfig = { ...cfg, jitterFactor: 2.0 };
    expect(calculateBackoffMs(0, extremeJitter, () => 0)).toBeGreaterThanOrEqual(0);
  });

  test('result never exceeds maxDelayMs even with maximum positive jitter', () => {
    const maxRandom = () => 1; // maximum positive jitter
    // At high attempts, clamped=maxDelayMs; positive jitter should not push beyond it
    expect(calculateBackoffMs(20, cfg, maxRandom)).toBeLessThanOrEqual(cfg.maxDelayMs);
    expect(calculateBackoffMs(0, cfg, maxRandom)).toBeLessThanOrEqual(cfg.maxDelayMs);
  });
});

// ---------------------------------------------------------------------------
// RetryController helpers
// ---------------------------------------------------------------------------
function makeUploader() {
  return { flushNow: jest.fn<Promise<void>, []>().mockResolvedValue(undefined) };
}

function makeController(
  uploader = makeUploader(),
  config: Partial<BackoffConfig> = {},
  onAuthError?: (status: number) => void,
) {
  return new RetryController(uploader, { baseDelayMs: 100, maxDelayMs: 800, jitterFactor: 0, ...config }, onAuthError);
}

function successEvent(): UploadEvent { return { type: 'success', count: 1 }; }
function serverErrorEvent(): UploadEvent {
  return { type: 'failure', result: { ok: false, status: 500, retryable: true } };
}
function authErrorEvent(status: 401 | 403): UploadEvent {
  return { type: 'failure', result: { ok: false, status, retryable: false } };
}
function clientErrorEvent(): UploadEvent {
  return { type: 'failure', result: { ok: false, status: 400, retryable: false } };
}
function networkErrorEvent(): UploadEvent {
  return { type: 'error', error: new Error('network down') };
}

// ---------------------------------------------------------------------------
// Backoff scheduling
// ---------------------------------------------------------------------------
describe('retry scheduling', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('retryable failure schedules a flush after backoff delay', async () => {
    const uploader = makeUploader();
    const ctrl = makeController(uploader, { baseDelayMs: 200, maxRetries: 3 });
    ctrl.handleEvent(serverErrorEvent());
    expect(uploader.flushNow).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(200);
    expect(uploader.flushNow).toHaveBeenCalledTimes(1);
  });

  test('network error (type: error) schedules a retry', async () => {
    const uploader = makeUploader();
    const ctrl = makeController(uploader, { baseDelayMs: 200, maxRetries: 3 });
    ctrl.handleEvent(networkErrorEvent());
    await jest.advanceTimersByTimeAsync(200);
    expect(uploader.flushNow).toHaveBeenCalledTimes(1);
  });

  test('backoff delay doubles on each retry attempt', async () => {
    const uploader = makeUploader();
    const ctrl = makeController(uploader, { baseDelayMs: 100, maxRetries: 5, jitterFactor: 0 });
    ctrl.handleEvent(serverErrorEvent());   // attempt 0 → 100ms
    await jest.advanceTimersByTimeAsync(100);
    ctrl.handleEvent(serverErrorEvent());   // attempt 1 → 200ms
    expect(uploader.flushNow).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(200);
    expect(uploader.flushNow).toHaveBeenCalledTimes(2);
  });

  test('retries stop after maxRetries, reset counter, and wait for next periodic trigger', async () => {
    const uploader = makeUploader();
    const ctrl = makeController(uploader, {
      baseDelayMs: 10,
      maxRetries: 3,
      maxDelayMs: 1000,
      jitterFactor: 0,
    });
    // Drive through 3 retries (attempt 0→2, timer increments to 1→3)
    for (let i = 0; i < 3; i++) {
      ctrl.handleEvent(serverErrorEvent());
      await jest.advanceTimersByTimeAsync(10 * Math.pow(2, i));
    }
    expect(uploader.flushNow).toHaveBeenCalledTimes(3);
    // 4th failure: retryCount=3 >= maxRetries=3 → resets to 0, no timer scheduled
    ctrl.handleEvent(serverErrorEvent());
    expect(ctrl.pendingRetryCount).toBe(0);
    // Advancing time should NOT trigger another immediate retry
    await jest.advanceTimersByTimeAsync(200);
    expect(uploader.flushNow).toHaveBeenCalledTimes(3); // still 3, not 4
  });

  test('success event resets retry count and cancels pending timer', async () => {
    const uploader = makeUploader();
    const ctrl = makeController(uploader, { baseDelayMs: 5000, maxRetries: 3 });
    ctrl.handleEvent(serverErrorEvent()); // schedules retry in 5000ms
    ctrl.handleEvent(successEvent());     // should cancel the timer
    await jest.advanceTimersByTimeAsync(5000);
    expect(uploader.flushNow).not.toHaveBeenCalled();
    expect(ctrl.pendingRetryCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Auth error handling
// ---------------------------------------------------------------------------
describe('auth error handling', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('401 fires onAuthError callback and does not schedule retry', async () => {
    const uploader = makeUploader();
    const onAuthError = jest.fn();
    const ctrl = makeController(uploader, { baseDelayMs: 100, maxRetries: 5 }, onAuthError);
    ctrl.handleEvent(authErrorEvent(401));
    expect(onAuthError).toHaveBeenCalledWith(401);
    await jest.advanceTimersByTimeAsync(200);
    expect(uploader.flushNow).not.toHaveBeenCalled();
  });

  test('403 fires onAuthError callback and does not schedule retry', async () => {
    const uploader = makeUploader();
    const onAuthError = jest.fn();
    const ctrl = makeController(uploader, { baseDelayMs: 100, maxRetries: 5 }, onAuthError);
    ctrl.handleEvent(authErrorEvent(403));
    expect(onAuthError).toHaveBeenCalledWith(403);
    await jest.advanceTimersByTimeAsync(200);
    expect(uploader.flushNow).not.toHaveBeenCalled();
  });

  test('non-retryable 4xx (not auth) does not retry and does not call onAuthError', async () => {
    const uploader = makeUploader();
    const onAuthError = jest.fn();
    const ctrl = makeController(uploader, { baseDelayMs: 100 }, onAuthError);
    ctrl.handleEvent(clientErrorEvent());
    expect(onAuthError).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(200);
    expect(uploader.flushNow).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Connectivity restore
// ---------------------------------------------------------------------------
describe('onConnectivityRestored', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('onConnectivityRestored cancels pending retry and immediately flushes', async () => {
    const uploader = makeUploader();
    const ctrl = makeController(uploader, { baseDelayMs: 5000, maxRetries: 3 });
    ctrl.handleEvent(serverErrorEvent()); // pending timer set for 5000ms
    ctrl.onConnectivityRestored();         // should cancel timer and flush now
    await jest.advanceTimersByTimeAsync(5000);
    expect(uploader.flushNow).toHaveBeenCalledTimes(1); // from restore, not from timer
    expect(ctrl.pendingRetryCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// destroy
// ---------------------------------------------------------------------------
describe('destroy', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('destroy cancels pending retry timer', async () => {
    const uploader = makeUploader();
    const ctrl = makeController(uploader, { baseDelayMs: 1000, maxRetries: 3 });
    ctrl.handleEvent(serverErrorEvent());
    ctrl.destroy();
    await jest.advanceTimersByTimeAsync(2000);
    expect(uploader.flushNow).not.toHaveBeenCalled();
  });
});
