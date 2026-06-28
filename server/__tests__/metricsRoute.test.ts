import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { buildApp } from '../src/app';
import { MetricsStore } from '../src/core/metrics';
import { PoisonPillDetector } from '../src/core/poisonPill';

// ── helpers ───────────────────────────────────────────────────────────────────

const ADMIN_KEY = 'secret-admin-key';

function makePool(): Pool {
  return {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  } as unknown as Pool;
}

function makeApp(
  pool = makePool(),
  metricsStore?: MetricsStore,
  poisonPillDetector?: PoisonPillDetector
): FastifyInstance {
  return buildApp(
    {
      port: 0,
      host: '127.0.0.1',
      databaseUrl: 'postgresql://localhost/test',
      adminApiKey: ADMIN_KEY,
      logLevel: 'silent',
      maxInflightRequests: 200,
      requestTimeoutMs: 29_000,
    },
    { pool, metricsStore, poisonPillDetector }
  );
}

// ── GET /metrics authentication ───────────────────────────────────────────────

describe('GET /metrics', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('returns 401 when X-Admin-Key header is missing', async () => {
    app = makeApp();
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when X-Admin-Key is wrong', async () => {
    app = makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-admin-key': 'wrong-key' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 with a MetricsSnapshot for a valid admin key', async () => {
    app = makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      ingest: {
        received: number;
        inserted: number;
        duplicates: number;
        dropped: number;
        deviceMismatch: number;
      };
      rejectedEnvelopes: number;
      errors4xx: number;
      errors5xx: number;
      requestCount: number;
      uptimeMs: number;
    }>();

    expect(typeof body.ingest.received).toBe('number');
    expect(typeof body.ingest.inserted).toBe('number');
    expect(typeof body.ingest.duplicates).toBe('number');
    expect(typeof body.ingest.dropped).toBe('number');
    expect(typeof body.ingest.deviceMismatch).toBe('number');
    expect(typeof body.rejectedEnvelopes).toBe('number');
    expect(typeof body.errors4xx).toBe('number');
    expect(typeof body.errors5xx).toBe('number');
    expect(typeof body.requestCount).toBe('number');
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  // ── MetricsStore injection: snapshot reflects accumulated state ───────────

  it('returns snapshot that reflects accumulated ingest counts', async () => {
    const metricsStore = new MetricsStore();
    metricsStore.recordIngest({
      received: 10,
      inserted: 8,
      duplicates: 1,
      dropped: 1,
      deviceMismatch: 0,
    });
    metricsStore.recordRejectedEnvelope();
    metricsStore.recordError4xx();
    metricsStore.recordError5xx();

    app = makeApp(makePool(), metricsStore);
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      ingest: { received: number; inserted: number; duplicates: number; dropped: number };
      rejectedEnvelopes: number;
      errors4xx: number;
      errors5xx: number;
      requestCount: number;
    }>();

    // requestCount = 1 ingest + 1 rejected = 2, but the /metrics GET itself
    // does NOT call recordIngest/recordRejectedEnvelope so it stays at 2.
    expect(body.ingest.received).toBe(10);
    expect(body.ingest.inserted).toBe(8);
    expect(body.ingest.duplicates).toBe(1);
    expect(body.ingest.dropped).toBe(1);
    expect(body.rejectedEnvelopes).toBe(1);
    // errors4xx is incremented by the onResponse hook, but because metricsStore is
    // pre-populated (not through live requests here), we just verify the store value.
    expect(body.errors4xx).toBe(1);
    expect(body.errors5xx).toBe(1);
  });

  // ── Log hygiene: /metrics response must not leak lat/lng ─────────────────

  it('does not include lat or lng in the JSON response body', async () => {
    app = makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);

    // The metrics snapshot should only contain counter fields — no location data.
    const bodyStr = res.body;
    expect(bodyStr).not.toMatch(/"lat"\s*:/);
    expect(bodyStr).not.toMatch(/"lng"\s*:/);
  });
});
