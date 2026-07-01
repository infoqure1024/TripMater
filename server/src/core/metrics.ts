export interface IngestCounts {
  received: number;
  inserted: number;
  duplicates: number;
  dropped: number;
  deviceMismatch: number;
}

export interface MetricsSnapshot {
  ingest: IngestCounts;
  rejectedEnvelopes: number;
  errors4xx: number;
  errors5xx: number;
  requestCount: number;
  uptimeMs: number;
}

export class MetricsStore {
  private readonly startedAt: number;
  private ingest: IngestCounts = {
    received: 0,
    inserted: 0,
    duplicates: 0,
    dropped: 0,
    deviceMismatch: 0,
  };
  private rejectedEnvelopes = 0;
  private errors4xx = 0;
  private errors5xx = 0;
  // Counts ingest requests processed after auth (recordIngest + recordRejectedEnvelope),
  // regardless of whether the DB write succeeded or failed.
  private requestCount = 0;

  constructor() {
    this.startedAt = Date.now();
  }

  recordIngest(counts: IngestCounts): void {
    this.ingest.received += counts.received;
    this.ingest.inserted += counts.inserted;
    this.ingest.duplicates += counts.duplicates;
    this.ingest.dropped += counts.dropped;
    this.ingest.deviceMismatch += counts.deviceMismatch;
    this.requestCount++;
  }

  recordRejectedEnvelope(): void {
    this.rejectedEnvelopes++;
    this.requestCount++;
  }

  recordError4xx(): void {
    this.errors4xx++;
  }

  recordError5xx(): void {
    this.errors5xx++;
  }

  snapshot(): MetricsSnapshot {
    return {
      ingest: { ...this.ingest },
      rejectedEnvelopes: this.rejectedEnvelopes,
      errors4xx: this.errors4xx,
      errors5xx: this.errors5xx,
      requestCount: this.requestCount,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  // For use in tests only — resets all counters.
  reset(): void {
    this.ingest = { received: 0, inserted: 0, duplicates: 0, dropped: 0, deviceMismatch: 0 };
    this.rejectedEnvelopes = 0;
    this.errors4xx = 0;
    this.errors5xx = 0;
    this.requestCount = 0;
  }
}
