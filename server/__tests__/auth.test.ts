import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { buildApp } from '../src/app';

// Row shape returned by the token lookup query.
interface TokenRow {
  token_id: string;
  device_id: string;
  revoked_at: Date | null;
  expires_at: Date | null;
  disabled_at: Date | null;
}

function makePool(rows: TokenRow[]): Pool {
  return {
    query: jest.fn().mockResolvedValue({ rows, rowCount: rows.length }),
    end: jest.fn().mockResolvedValue(undefined),
  } as unknown as Pool;
}

function makeErrorPool(): Pool {
  return {
    query: jest.fn().mockRejectedValue(new Error('DB connection error')),
    end: jest.fn().mockResolvedValue(undefined),
  } as unknown as Pool;
}

function validRow(): TokenRow {
  return {
    token_id: 'tok-1',
    device_id: 'device-1',
    revoked_at: null,
    expires_at: null,
    disabled_at: null,
  };
}

function makeApp(pool: Pool): FastifyInstance {
  return buildApp(
    {
      port: 0,
      host: '127.0.0.1',
      databaseUrl: 'postgresql://localhost/test',
      adminApiKey: 'secret-admin-key',
      logLevel: 'silent',
    },
    { pool }
  );
}

async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (instance) => {
    instance.get(
      '/secure',
      {
        preHandler: [(req, reply) => app.authenticateDevice(req, reply)],
      },
      (req, reply) => {
        void reply.send({ deviceId: req.deviceId });
      }
    );
    instance.get(
      '/admin',
      {
        preHandler: [(req, reply) => app.authenticateAdmin(req, reply)],
      },
      (_req, reply) => {
        void reply.send({ ok: true });
      }
    );
  });
}

// ── authenticateDevice ──────────────────────────────────────────────────────

describe('authenticateDevice', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('returns 401 when Authorization header is missing', async () => {
    app = makeApp(makePool([validRow()]));
    await registerRoutes(app);
    const res = await app.inject({ method: 'GET', url: '/secure' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when Authorization scheme is not Bearer', async () => {
    app = makeApp(makePool([validRow()]));
    await registerRoutes(app);
    const res = await app.inject({
      method: 'GET',
      url: '/secure',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when token is not found in DB', async () => {
    app = makeApp(makePool([]));
    await registerRoutes(app);
    const res = await app.inject({
      method: 'GET',
      url: '/secure',
      headers: { authorization: 'Bearer unknown-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when token is revoked', async () => {
    const row = validRow();
    row.revoked_at = new Date('2024-01-01T00:00:00Z');
    app = makeApp(makePool([row]));
    await registerRoutes(app);
    const res = await app.inject({
      method: 'GET',
      url: '/secure',
      headers: { authorization: 'Bearer some-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when token is expired', async () => {
    const row = validRow();
    row.expires_at = new Date('2020-01-01T00:00:00Z');
    app = makeApp(makePool([row]));
    await registerRoutes(app);
    const res = await app.inject({
      method: 'GET',
      url: '/secure',
      headers: { authorization: 'Bearer some-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when device is disabled', async () => {
    const row = validRow();
    row.disabled_at = new Date('2024-06-01T00:00:00Z');
    app = makeApp(makePool([row]));
    await registerRoutes(app);
    const res = await app.inject({
      method: 'GET',
      url: '/secure',
      headers: { authorization: 'Bearer some-token' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 200 and injects deviceId for a valid token', async () => {
    app = makeApp(makePool([validRow()]));
    await registerRoutes(app);
    const res = await app.inject({
      method: 'GET',
      url: '/secure',
      headers: { authorization: 'Bearer valid-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ deviceId: string }>().deviceId).toBe('device-1');
  });

  it('returns 503 when the DB query throws', async () => {
    app = makeApp(makeErrorPool());
    await registerRoutes(app);
    const res = await app.inject({
      method: 'GET',
      url: '/secure',
      headers: { authorization: 'Bearer some-token' },
    });
    expect(res.statusCode).toBe(503);
  });
});

// ── authenticateAdmin ───────────────────────────────────────────────────────

describe('authenticateAdmin', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('returns 401 when X-Admin-Key header is missing', async () => {
    app = makeApp(makePool([]));
    await registerRoutes(app);
    const res = await app.inject({ method: 'GET', url: '/admin' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when X-Admin-Key is wrong', async () => {
    app = makeApp(makePool([]));
    await registerRoutes(app);
    const res = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { 'x-admin-key': 'wrong-key' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 when X-Admin-Key is correct', async () => {
    app = makeApp(makePool([]));
    await registerRoutes(app);
    const res = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { 'x-admin-key': 'secret-admin-key' },
    });
    expect(res.statusCode).toBe(200);
  });
});
