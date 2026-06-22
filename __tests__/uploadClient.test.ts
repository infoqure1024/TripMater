import axios from 'axios';
import { HttpUploadClient } from '../src/core/uploadClient';
import { LocationSample, UploadClientConfig, UploadEnvelope } from '../src/core/uploadTypes';

jest.mock('axios');
const mockedPost = axios.post as jest.Mock;

function makeConfig(overrides: Partial<UploadClientConfig> = {}): UploadClientConfig {
  return {
    baseUrl: 'https://example.com',
    path: '/api/v1/locations',
    token: 'test-token',
    ...overrides,
  };
}

function makeSample(overrides: Partial<LocationSample> = {}): LocationSample {
  return {
    id: 'uuid-1',
    deviceId: 'device-1',
    timestamp: 1_000_000,
    lat: 35.6895,
    lng: 139.6917,
    speedMps: 5.5,
    accuracyM: 5.0,
    ...overrides,
  };
}

/** axios.post が指定ステータスで resolve するようにモックする。 */
function mockPostStatus(status: number) {
  mockedPost.mockResolvedValue({ status });
}

/** axios.post の [url, data, config] 呼び出し引数を取り出す。 */
function postCall() {
  return mockedPost.mock.calls[0] as [
    string,
    UploadEnvelope,
    { headers: Record<string, string>; timeout: number },
  ];
}

afterEach(() => {
  mockedPost.mockReset();
  jest.useRealTimers();
});

describe('HttpUploadClient.upload — response classification', () => {
  test('2xx → ok=true, retryable=false', async () => {
    mockPostStatus(200);
    const result = await new HttpUploadClient(makeConfig()).upload([makeSample()]);
    expect(result).toEqual({ ok: true, status: 200, retryable: false });
  });

  test('201 → ok=true, retryable=false', async () => {
    mockPostStatus(201);
    const result = await new HttpUploadClient(makeConfig()).upload([makeSample()]);
    expect(result).toEqual({ ok: true, status: 201, retryable: false });
  });

  test('400 → ok=false, retryable=false', async () => {
    mockPostStatus(400);
    const result = await new HttpUploadClient(makeConfig()).upload([makeSample()]);
    expect(result).toEqual({ ok: false, status: 400, retryable: false });
  });

  test('401 → ok=false, retryable=false', async () => {
    mockPostStatus(401);
    const result = await new HttpUploadClient(makeConfig()).upload([makeSample()]);
    expect(result).toEqual({ ok: false, status: 401, retryable: false });
  });

  test('403 → ok=false, retryable=false', async () => {
    mockPostStatus(403);
    const result = await new HttpUploadClient(makeConfig()).upload([makeSample()]);
    expect(result).toEqual({ ok: false, status: 403, retryable: false });
  });

  test('500 → ok=false, retryable=true', async () => {
    mockPostStatus(500);
    const result = await new HttpUploadClient(makeConfig()).upload([makeSample()]);
    expect(result).toEqual({ ok: false, status: 500, retryable: true });
  });

  test('503 → ok=false, retryable=true', async () => {
    mockPostStatus(503);
    const result = await new HttpUploadClient(makeConfig()).upload([makeSample()]);
    expect(result).toEqual({ ok: false, status: 503, retryable: true });
  });

  test('network error → ok=false, status=0, retryable=true', async () => {
    mockedPost.mockRejectedValue(new Error('Network Error'));
    const result = await new HttpUploadClient(makeConfig()).upload([makeSample()]);
    expect(result).toEqual({ ok: false, status: 0, retryable: true });
  });

  test('timeout (ECONNABORTED) → ok=false, status=0, retryable=true', async () => {
    const err = Object.assign(new Error('timeout of 10ms exceeded'), { code: 'ECONNABORTED' });
    mockedPost.mockRejectedValue(err);
    const result = await new HttpUploadClient(makeConfig({ timeoutMs: 10 })).upload([makeSample()]);
    expect(result).toEqual({ ok: false, status: 0, retryable: true });
  });
});

describe('HttpUploadClient.upload — request shape', () => {
  test('sends Authorization Bearer header with the configured token', async () => {
    mockPostStatus(200);
    await new HttpUploadClient(makeConfig({ token: 'my-secret' })).upload([makeSample()]);
    const [, , config] = postCall();
    expect(config.headers.Authorization).toBe('Bearer my-secret');
  });

  test('sends Content-Type: application/json', async () => {
    mockPostStatus(200);
    await new HttpUploadClient(makeConfig()).upload([makeSample()]);
    const [, , config] = postCall();
    expect(config.headers['Content-Type']).toBe('application/json');
  });

  test('passes the configured timeout to axios', async () => {
    mockPostStatus(200);
    await new HttpUploadClient(makeConfig({ timeoutMs: 12_345 })).upload([makeSample()]);
    const [, , config] = postCall();
    expect(config.timeout).toBe(12_345);
  });

  test('sends POST to baseUrl + path', async () => {
    mockPostStatus(200);
    await new HttpUploadClient(
      makeConfig({ baseUrl: 'https://api.example.com', path: '/v2/gps' }),
    ).upload([makeSample()]);
    const [url] = postCall();
    expect(url).toBe('https://api.example.com/v2/gps');
  });

  test('strips single trailing slash from baseUrl to avoid double slash', async () => {
    mockPostStatus(200);
    await new HttpUploadClient(
      makeConfig({ baseUrl: 'https://api.example.com/', path: '/v2/gps' }),
    ).upload([makeSample()]);
    const [url] = postCall();
    expect(url).toBe('https://api.example.com/v2/gps');
  });

  test('strips multiple trailing slashes from baseUrl', async () => {
    mockPostStatus(200);
    await new HttpUploadClient(
      makeConfig({ baseUrl: 'https://api.example.com//', path: '/v2/gps' }),
    ).upload([makeSample()]);
    const [url] = postCall();
    expect(url).toBe('https://api.example.com/v2/gps');
  });

  test('adds leading slash to path when missing', async () => {
    mockPostStatus(200);
    await new HttpUploadClient(
      makeConfig({ baseUrl: 'https://api.example.com', path: 'v2/gps' }),
    ).upload([makeSample()]);
    const [url] = postCall();
    expect(url).toBe('https://api.example.com/v2/gps');
  });

  test('body contains schemaVersion=1 and the submitted samples', async () => {
    mockPostStatus(200);
    const sample = makeSample({ id: 'abc-123', lat: 1.23, lng: 4.56 });
    await new HttpUploadClient(makeConfig()).upload([sample]);
    const [, body] = postCall();
    expect(body.schemaVersion).toBe(1);
    expect(body.samples).toHaveLength(1);
    expect(body.samples[0]).toMatchObject({ id: 'abc-123', lat: 1.23, lng: 4.56 });
  });

  test('optional sample fields are included in the request body', async () => {
    mockPostStatus(200);
    const sample = makeSample({
      rawSpeedMps: 6.1,
      headingDeg: 90,
      altitudeM: 10,
      sessionId: 'sess-1',
      distanceDeltaM: 5.5,
    });
    await new HttpUploadClient(makeConfig()).upload([sample]);
    const [, body] = postCall();
    expect(body.samples[0]).toMatchObject({
      rawSpeedMps: 6.1,
      headingDeg: 90,
      altitudeM: 10,
      sessionId: 'sess-1',
      distanceDeltaM: 5.5,
    });
  });

  test('sends multiple samples in a single request', async () => {
    mockPostStatus(200);
    const samples = [makeSample({ id: 'a' }), makeSample({ id: 'b' }), makeSample({ id: 'c' })];
    await new HttpUploadClient(makeConfig()).upload(samples);
    const [, body] = postCall();
    expect(body.samples).toHaveLength(3);
    expect(body.samples.map((s: LocationSample) => s.id)).toEqual(['a', 'b', 'c']);
  });
});
