import { UploadClient, UploadResult } from './uploadTypes';
import { UploadQueue } from '../storage/uploadQueue';

export interface UploadConfig {
  batchSize: number;
  flushIntervalMs: number;
}

export const DEFAULT_UPLOAD_CONFIG: UploadConfig = {
  batchSize: 50,
  flushIntervalMs: 30_000,
};

export type UploadEventListener = (event: UploadEvent) => void;

export type UploadEvent =
  | { type: 'success'; count: number }
  | { type: 'failure'; result: UploadResult }
  | { type: 'error'; error: Error };

export class BatchUploader {
  private config: UploadConfig;
  private inflight = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listener: UploadEventListener | null = null;

  constructor(
    private readonly queue: UploadQueue,
    private readonly client: UploadClient,
    config: Partial<UploadConfig> = {},
  ) {
    this.config = { ...DEFAULT_UPLOAD_CONFIG, ...config };
  }

  setConfig(config: Partial<UploadConfig>): void {
    this.config = { ...this.config, ...config };
  }

  setListener(listener: UploadEventListener): void {
    this.listener = listener;
  }

  /** Start the periodic flush timer. Call once on service startup. */
  start(): void {
    if (this.timer !== null) { return; }
    this.timer = setInterval(() => { this.flush(); }, this.config.flushIntervalMs);
  }

  /** Stop the timer. Call on service teardown. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Called after each enqueue. Triggers a flush if pending count >= batchSize.
   * Returns immediately if a flush is already in flight.
   */
  async onEnqueue(): Promise<void> {
    const pending = await this.queue.count();
    if (pending >= this.config.batchSize) {
      await this.flush();
    }
  }

  /** Manually trigger a flush (e.g. connectivity restored, foreground return). */
  async flushNow(): Promise<void> {
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.inflight) { return; }
    this.inflight = true;
    try {
      await this.flushLoop();
    } catch (e) {
      // Absorb unexpected errors (e.g. queue storage throws) so the timer
      // callback's fire-and-forget invocation never becomes an unhandled rejection.
      this.listener?.({ type: 'error', error: e as Error });
    } finally {
      this.inflight = false;
    }
  }

  private async flushLoop(): Promise<void> {
    while (true) {
      const batch = await this.queue.peekBatch(this.config.batchSize);
      if (batch.length === 0) { return; }

      let result: UploadResult;
      try {
        result = await this.client.upload(batch);
      } catch (e) {
        this.listener?.({ type: 'error', error: e as Error });
        return;
      }

      if (result.ok) {
        await this.queue.ack(batch.map(s => s.id));
        this.listener?.({ type: 'success', count: batch.length });
        // If there were exactly batchSize items, there may be more — keep going.
        if (batch.length < this.config.batchSize) { return; }
      } else {
        this.listener?.({ type: 'failure', result });
        return;
      }
    }
  }
}
