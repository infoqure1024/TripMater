import axios from 'axios';
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

    try {
      // validateStatus: () => true で全ステータスを resolve させ、
      // 既存の分類ロジック（2xx→ok、5xx→retryable、4xx→non-retryable）を維持する。
      const response = await axios.post(url, envelope, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.token}`,
        },
        timeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        validateStatus: () => true,
      });

      const ok = response.status >= 200 && response.status < 300;
      const retryable = !ok && response.status >= 500;
      return { ok, status: response.status, retryable };
    } catch (e) {
      // ネットワークエラー / タイムアウト（error.code === 'ECONNABORTED'）は
      // レスポンスを持たないため status: 0, retryable: true にマッピングする。
      return { ok: false, status: 0, retryable: true };
    }
  }
}
