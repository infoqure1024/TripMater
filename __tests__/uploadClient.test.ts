import { HttpUploadClient } from '../src/core/uploadClient';
import { LocationSample, UploadClientConfig } from '../src/core/uploadTypes';

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

function mockFetchResponse(status: number) {
  return jest.fn().mockResolvedValue({ status });
}

let savedFetch: typeof global.fetch;
beforeEach(() => { savedFetch = global.fetch; });
afterEach(() => { global.fetch = savedFetch; jest.useRealTimers(); });

describe('HttpUploadClient.upload — response classification', () => {
  test('2xx → ok=true, retryable=false', async () => {
    global.fetch = mockFetchResponse(200);
    const result = await new HttpUploadClient(makeConfig()).upload([makeSample()]);
    expect(result).toEqual({ ok: true, status: 200, retryable: false });
  });

  test('201 → ok=true, retryable=false', async () => {
    global.fetch = mockFetchResponse(201);
    const result = await new HttpUploadClient(makeConfig()).upload([makeSample()]);
    expect(result).toEqual({ ok: true, status: 201, retryable: false });
  });

  test('400 → ok=false, retryable=false', async () => {
    global.fetch = mockFetchResponse(400);
    const result = await new HttpUploadClient(makeConfig()).upload([makeSample()]);
    expect(result).toEqual({ ok: false, status: 400, retryable: false });
  });

  test('401 → ok=false, retryable=false', async () => {
    global.fetch = mockFetchResponse(401);
    const result = await new HttpUploadClient(makeConfig()).upload([makeSample()]);
    expect(result).toEqual({ ok: false, status: 401, retryable: false });
  });

  test('403 → ok=false, retryable=false', async () => {
    global.fetch = mockFetchResponse(403);
    const result = await new HttpUploadClient(makeConfig()).upload([makeSample()]);
    expect(result).toEqual({ ok: false, status: 403, retryable: false });
  });

  test('500 → ok=false, retryable=true', async () => {
    global.fetch = mockFetchResponse(500);
    const result = await new HttpUploadClient(makeConfig()).upload([makeSample()]);
    expect(result).toEqual({ ok: false, status: 500, retryable: true });
  });

  test('503 → ok=false, retryable=true', async () => {
    global.fetch = mockFetchResponse(503);
    const result = await new HttpUploadClient(makeConfig()).upload([makeSample()]);
    expect(result).toEqual({ ok: false, status: 503, retryable: true });
  });

  test('network error → ok=false, status=0, retryable=true', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network request failed'));
    const result = await new HttpUploadClient(makeConfig()).upload([makeSample()]);
    expect(result).toEqual({ ok: false, status: 0, retryable: true });
  });

  test('AbortError (timeout) → ok=false, status=0, retryable=true', async () => {
    const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    global.fetch = jest.fn().mockRejectedValue(err);
    const result = await new HttpUploadClient(makeConfig({ timeoutMs: 10 })).upload([makeSample()]);
    expect(result).toEqual({ ok: false, status: 0, retryable: true });
  });
});

describe('HttpUploadClient.upload — request shape', () => {
  test('sends Authorization Bearer header with the configured token', async () => {
    const fetchMock = mockFetchResponse(200);
    global.fetch = fetchMock;
    await new HttpUploadClient(makeConfig({ token: 'my-secret' })).upload([makeSample()]);
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer my-secret');
  });

  test('sends Content-Type: application/json', async () => {
    const fetchMock = mockFetchResponse(200);
    global.fetch = fetchMock;
    await new HttpUploadClient(makeConfig()).upload([makeSample()]);
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  test('sends POST to baseUrl + path', async () => {
    const fetchMock = mockFetchResponse(200);
    global.fetch = fetchMock;
    await new HttpUploadClient(
      makeConfig({ baseUrl: 'https://api.example.com', path: '/v2/gps' }),
    ).upload([makeSample()]);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v2/gps');
    expect(opts.method).toBe('POST');
  });

  test('strips single trailing slash from baseUrl to avoid double slash', async () => {
    const fetchMock = mockFetchResponse(200);
    global.fetch = fetchMock;
    await new HttpUploadClient(
      makeConfig({ baseUrl: 'https://api.example.com/', path: '/v2/gps' }),
    ).upload([makeSample()]);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v2/gps');
  });

  test('strips multiple trailing slashes from baseUrl', async () => {
    const fetchMock = mockFetchResponse(200);
    global.fetch = fetchMock;
    await new HttpUploadClient(
      makeConfig({ baseUrl: 'https://api.example.com//', path: '/v2/gps' }),
    ).upload([makeSample()]);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v2/gps');
  });

  test('adds leading slash to path when missing', async () => {
    const fetchMock = mockFetchResponse(200);
    global.fetch = fetchMock;
    await new HttpUploadClient(
      makeConfig({ baseUrl: 'https://api.example.com', path: 'v2/gps' }),
    ).upload([makeSample()]);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v2/gps');
  });

  test('body contains schemaVersion=1 and the submitted samples', async () => {
    const fetchMock = mockFetchResponse(200);
    global.fetch = fetchMock;
    const sample = makeSample({ id: 'abc-123', lat: 1.23, lng: 4.56 });
    await new HttpUploadClient(makeConfig()).upload([sample]);
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.schemaVersion).toBe(1);
    expect(body.samples).toHaveLength(1);
    expect(body.samples[0]).toMatchObject({ id: 'abc-123', lat: 1.23, lng: 4.56 });
  });

  test('optional sample fields are included in the serialized body', async () => {
    const fetchMock = mockFetchResponse(200);
    global.fetch = fetchMock;
    const sample = makeSample({
      rawSpeedMps: 6.1,
      headingDeg: 90,
      altitudeM: 10,
      sessionId: 'sess-1',
      distanceDeltaM: 5.5,
    });
    await new HttpUploadClient(makeConfig()).upload([sample]);
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.samples[0]).toMatchObject({
      rawSpeedMps: 6.1,
      headingDeg: 90,
      altitudeM: 10,
      sessionId: 'sess-1',
      distanceDeltaM: 5.5,
    });
  });

  test('sends multiple samples in a single request', async () => {
    const fetchMock = mockFetchResponse(200);
    global.fetch = fetchMock;
    const samples = [makeSample({ id: 'a' }), makeSample({ id: 'b' }), makeSample({ id: 'c' })];
    await new HttpUploadClient(makeConfig()).upload(samples);
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.samples).toHaveLength(3);
    expect(body.samples.map((s: LocationSample) => s.id)).toEqual(['a', 'b', 'c']);
  });
});
