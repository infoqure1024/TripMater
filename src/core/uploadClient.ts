import {
  LocationSample,
  UploadClient,
  UploadClientConfig,
  UploadEnvelope,
  UploadResult,
} from './uploadTypes';

const SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 30_000;

export class HttpUploadClient implements UploadClient {
  constructor(private readonly config: UploadClientConfig) {}

  async upload(batch: LocationSample[]): Promise<UploadResult> {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const path = this.config.path.startsWith('/') ? this.config.path : `/${this.config.path}`;
    const url = `${base}${path}`;
    const envelope: UploadEnvelope = { schemaVersion: SCHEMA_VERSION, samples: batch };
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.token}`,
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });

      const ok = response.status >= 200 && response.status < 300;
      const retryable = !ok && response.status >= 500;
      return { ok, status: response.status, retryable };
    } catch (e) {
      return { ok: false, status: 0, retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }
}
