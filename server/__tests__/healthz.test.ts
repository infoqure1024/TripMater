import { buildApp } from '../src/app';

// Build a test instance with no real DB dependency — /healthz does not query DB.
function makeApp() {
  return buildApp({
    port: 0,
    host: '127.0.0.1',
    databaseUrl: process.env['DATABASE_URL'] ?? 'postgresql://localhost/test',
    adminApiKey: 'test-key',
    logLevel: 'silent',
  });
}

describe('GET /healthz', () => {
  it('returns HTTP 200', async () => {
    const app = makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('body.status is "ok"', async () => {
    const app = makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    const body = res.json<{ status: string; timestamp: string }>();
    expect(body.status).toBe('ok');
    await app.close();
  });

  it('body.timestamp is a valid ISO 8601 string', async () => {
    const app = makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    const body = res.json<{ status: string; timestamp: string }>();
    // new Date() on a valid ISO string gives a non-NaN time value.
    const parsed = new Date(body.timestamp);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    // toISOString() canonical form: YYYY-MM-DDTHH:mm:ss.mmmZ
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    await app.close();
  });

  it('Content-Type is application/json', async () => {
    const app = makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
    await app.close();
  });
});
