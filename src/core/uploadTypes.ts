export interface LocationSample {
  id: string;                  // UUID — idempotency / de-duplication key
  deviceId: string;
  timestamp: number;           // epoch ms
  lat: number;
  lng: number;
  speedMps: number;            // Kalman-filtered speed
  rawSpeedMps?: number;
  accuracyM: number;
  headingDeg?: number;
  altitudeM?: number;
  sessionId?: string;          // groups fixes from one measurement session
  distanceDeltaM?: number;     // distance added by this fix
}

export interface UploadEnvelope {
  schemaVersion: number;
  samples: LocationSample[];
}

export interface UploadResult {
  ok: boolean;
  status: number;
  retryable: boolean;
}

export interface UploadClient {
  upload(batch: LocationSample[]): Promise<UploadResult>;
}

export interface UploadClientConfig {
  baseUrl: string;
  path: string;
  token: string;
  timeoutMs?: number;
}
