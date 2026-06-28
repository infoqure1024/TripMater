import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';

// Build a test instance with no real DB dependency — /healthz does not query DB.
function makeApp() {
  return buildApp({
    port: 0,
    host: '127.0.0.1',
    databaseUrl: process.env['DATABASE_URL'] ?? 'postgresql://localhost/test',
    adminApiKey: 'test-key',
    logLevel: 'silent',
    maxInflightRequests: 200,
    requestTimeoutMs: 29_000,
  });
}

describe('GET /healthz', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = makeApp();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('returns HTTP 200', async () => {
    const res = await app!.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('body.status is "ok"', async () => {
    const res = await app!.inject({ method: 'GET', url: '/healthz' });
    const body = res.json<{ status: string; timestamp: string }>();
    expect(body.status).toBe('ok');
  });

  it('body.timestamp is a valid ISO 8601 string', async () => {
    const res = await app!.inject({ method: 'GET', url: '/healthz' });
    const body = res.json<{ status: string; timestamp: string }>();
    // new Date() on a valid ISO string gives a non-NaN time value.
    const parsed = new Date(body.timestamp);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    // toISOString() canonical form: YYYY-MM-DDTHH:mm:ss.mmmZ
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it('Content-Type is application/json', async () => {
    const res = await app!.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});
