import { UploadEvent } from './batchUploader';

export interface BackoffConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number; // fraction of delay added as ±random jitter, e.g. 0.2 = ±20%
}

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  maxRetries: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterFactor: 0.2,
};

/**
 * Pure function — injectable `random` param enables deterministic tests.
 * Returns the number of milliseconds to wait before the next retry attempt.
 */
export function calculateBackoffMs(
  attempt: number,
  config: BackoffConfig,
  random: () => number = Math.random,
): number {
  const exponential = config.baseDelayMs * Math.pow(2, attempt);
  const clamped = Math.min(exponential, config.maxDelayMs);
  const jitter = clamped * config.jitterFactor * (random() * 2 - 1);
  return Math.min(config.maxDelayMs, Math.max(0, Math.round(clamped + jitter)));
}

export type AuthErrorHandler = (status: number) => void;

export class RetryController {
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private readonly fullConfig: BackoffConfig;

  constructor(
    private readonly uploader: { flushNow(): Promise<void> },
    config: Partial<BackoffConfig> = {},
    private readonly onAuthError?: AuthErrorHandler,
  ) {
    this.fullConfig = { ...DEFAULT_BACKOFF_CONFIG, ...config };
  }

  /** Feed upload events from BatchUploader.setListener into this method. */
  handleEvent(event: UploadEvent): void {
    if (this.destroyed) {
      return;
    }
    if (event.type === 'success') {
      this.resetRetry();
    } else if (event.type === 'dead_letter') {
      // The poison-pill batch was evicted (Issue #49); BatchUploader already
      // continues its flush loop for subsequent batches within the same
      // call. Treat like a recovery signal so backoff doesn't stay elevated
      // for whatever batch comes next.
      this.resetRetry();
    } else if (event.type === 'failure') {
      const { status, retryable } = event.result;
      if (status === 401 || status === 403) {
        this.onAuthError?.(status);
        this.resetRetry();
      } else if (retryable) {
        this.scheduleRetry();
      } else {
        // Non-retryable 4xx (not auth): drop and wait for next periodic trigger
        this.resetRetry();
      }
    } else {
      // type === 'error' (network/timeout): always retryable
      this.scheduleRetry();
    }
  }

  /** Call when NetInfo signals connectivity restored. */
  onConnectivityRestored(): void {
    if (this.destroyed) {
      return;
    }
    this.cancelPendingRetry();
    this.retryCount = 0;
    this.uploader.flushNow().catch(() => {
      /* flush errors handled by BatchUploader */
    });
  }

  /** Call on service teardown to cancel any pending retry timer. */
  destroy(): void {
    this.destroyed = true;
    this.cancelPendingRetry();
  }

  get pendingRetryCount(): number {
    return this.retryCount;
  }

  private scheduleRetry(): void {
    if (this.retryCount >= this.fullConfig.maxRetries) {
      // Max retries reached — reset so the next periodic timer flush can restart
      this.retryCount = 0;
      return;
    }
    this.cancelPendingRetry();
    const delay = calculateBackoffMs(this.retryCount, this.fullConfig);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryCount++;
      this.uploader.flushNow().catch(() => {
        /* handled by BatchUploader */
      });
    }, delay);
  }

  private resetRetry(): void {
    this.cancelPendingRetry();
    this.retryCount = 0;
  }

  private cancelPendingRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
