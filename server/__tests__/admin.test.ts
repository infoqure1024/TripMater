import { FastifyInstance } from 'fastify';
import { Pool, PoolClient } from 'pg';
import { buildApp } from '../src/app';

// ── helpers ──────────────────────────────────────────────────────────────────

const ADMIN_KEY = 'secret-admin-key';

function makeApp(pool: Pool): FastifyInstance {
  return buildApp(
    {
      port: 0,
      host: '127.0.0.1',
      databaseUrl: 'postgresql://localhost/test',
      adminApiKey: ADMIN_KEY,
      logLevel: 'silent',
      requestTimeoutMs: 29_000,
      maxInflightRequests: 200,
    },
    { pool }
  );
}

type QueryResult = { rows: unknown[]; rowCount?: number } | Error;

/**
 * Builds a mock Pool where:
 * - `pool.query()` returns responses from `querySequence` in order
 * - `pool.connect()` returns a single client whose data-query calls (non-BEGIN/COMMIT/ROLLBACK)
 *   return responses from `txSequence` in order
 */
function makePool(
  opts: {
    querySequence?: QueryResult[];
    txSequence?: QueryResult[];
  } = {}
): Pool {
  let qi = 0;
  let ti = 0;

  const client: Partial<PoolClient> & { query: jest.Mock; release: jest.Mock } = {
    query: jest.fn().mockImplementation(async (sql: string) => {
      const s = sql.trim().toUpperCase();
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      const r = opts.txSequence?.[ti++];
      if (r instanceof Error) throw r;
      return { rows: r?.rows ?? [], rowCount: r?.rowCount ?? r?.rows?.length ?? 0 };
    }),
    release: jest.fn(),
  };

  return {
    query: jest.fn().mockImplementation(async () => {
      const r = opts.querySequence?.[qi++];
      if (r instanceof Error) throw r;
      return { rows: r?.rows ?? [], rowCount: r?.rowCount ?? r?.rows?.length ?? 0 };
    }),
    connect: jest.fn().mockResolvedValue(client),
    end: jest.fn().mockResolvedValue(undefined),
  } as unknown as Pool;
}

function adminHeaders(): Record<string, string> {
  return { 'x-admin-key': ADMIN_KEY, 'content-type': 'application/json' };
}

// ── POST /api/v1/admin/devices ───────────────────────────────────────────────

describe('POST /api/v1/admin/devices', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns 401 when X-Admin-Key is missing', async () => {
    app = makeApp(makePool());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/devices',
      payload: { deviceId: 'device-1' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when X-Admin-Key is wrong', async () => {
    app = makeApp(makePool());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/devices',
      headers: { 'x-admin-key': 'wrong', 'content-type': 'application/json' },
      payload: { deviceId: 'device-1' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when deviceId is missing', async () => {
    app = makeApp(makePool());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/devices',
      headers: adminHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 when deviceId is an empty string', async () => {
    app = makeApp(makePool());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/devices',
      headers: adminHeaders(),
      payload: { deviceId: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 201 with deviceId when issueToken is false', async () => {
    app = makeApp(makePool({ txSequence: [{ rows: [], rowCount: 1 }] }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/devices',
      headers: adminHeaders(),
      payload: { deviceId: 'device-1', name: 'Test Device' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ deviceId: string }>().deviceId).toBe('device-1');
    expect(res.json()).not.toHaveProperty('token');
  });

  it('returns 201 with token when issueToken is true', async () => {
    app = makeApp(
      makePool({
        txSequence: [
          { rows: [], rowCount: 1 }, // INSERT devices
          { rows: [], rowCount: 1 }, // INSERT api_tokens
        ],
      })
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/devices',
      headers: adminHeaders(),
      payload: { deviceId: 'device-1', issueToken: true },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ deviceId: string; tokenId: string; token: string; expiresAt: null }>();
    expect(body.deviceId).toBe('device-1');
    expect(body.tokenId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(body.token).toMatch(/^tok_[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBeNull();
  });

  it('returns 409 when device already exists', async () => {
    const uniqueErr = Object.assign(new Error('duplicate key'), { code: '23505' });
    app = makeApp(makePool({ txSequence: [uniqueErr] }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/devices',
      headers: adminHeaders(),
      payload: { deviceId: 'device-1' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('CONFLICT');
  });

  it('returns 503 on unexpected DB error', async () => {
    app = makeApp(makePool({ txSequence: [new Error('connection reset')] }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/devices',
      headers: adminHeaders(),
      payload: { deviceId: 'device-1' },
    });
    expect(res.statusCode).toBe(503);
  });
});

// ── POST /api/v1/admin/devices/:deviceId/tokens ──────────────────────────────

describe('POST /api/v1/admin/devices/:deviceId/tokens', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns 401 when X-Admin-Key is missing', async () => {
    app = makeApp(makePool());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/devices/device-1/tokens',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when device does not exist', async () => {
    app = makeApp(makePool({ querySequence: [{ rows: [] }] }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/devices/unknown/tokens',
      headers: adminHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });

  it('returns 201 with plaintext token on success', async () => {
    app = makeApp(
      makePool({
        querySequence: [
          { rows: [{ id: 'device-1' }] }, // device check
          { rows: [], rowCount: 1 }, // INSERT api_tokens
        ],
      })
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/devices/device-1/tokens',
      headers: adminHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ deviceId: string; tokenId: string; token: string; expiresAt: null }>();
    expect(body.deviceId).toBe('device-1');
    expect(body.token).toMatch(/^tok_[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBeNull();
  });

  it('propagates expiresAt from request body', async () => {
    app = makeApp(
      makePool({
        querySequence: [{ rows: [{ id: 'device-1' }] }, { rows: [], rowCount: 1 }],
      })
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/devices/device-1/tokens',
      headers: adminHeaders(),
      payload: { expiresAt: '2027-01-01T00:00:00Z' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ expiresAt: string }>().expiresAt).toBe('2027-01-01T00:00:00Z');
  });

  it('returns 503 on DB error', async () => {
    app = makeApp(makePool({ querySequence: [new Error('DB down')] }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/devices/device-1/tokens',
      headers: adminHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(503);
  });
});

// ── GET /api/v1/admin/devices/:deviceId/tokens ───────────────────────────────

describe('GET /api/v1/admin/devices/:deviceId/tokens', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns 401 when X-Admin-Key is missing', async () => {
    app = makeApp(makePool());
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/devices/device-1/tokens',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when device does not exist', async () => {
    app = makeApp(makePool({ querySequence: [{ rows: [] }] }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/devices/unknown/tokens',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with empty token list', async () => {
    app = makeApp(
      makePool({
        querySequence: [{ rows: [{ id: 'device-1' }] }, { rows: [] }],
      })
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/devices/device-1/tokens',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ tokens: unknown[] }>().tokens).toEqual([]);
  });

  it('returns 200 with token metadata and no plaintext', async () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    app = makeApp(
      makePool({
        querySequence: [
          { rows: [{ id: 'device-1' }] },
          {
            rows: [
              {
                id: 'tok-uuid-1',
                prefix: 'tok_abcd',
                created_at: createdAt,
                last_used_at: null,
                expires_at: null,
                revoked_at: null,
              },
            ],
          },
        ],
      })
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/devices/device-1/tokens',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);
    const { tokens } = res.json<{
      tokens: Array<{
        tokenId: string;
        prefix: string;
        createdAt: string;
        lastUsedAt: null;
        expiresAt: null;
        revokedAt: null;
      }>;
    }>();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].tokenId).toBe('tok-uuid-1');
    expect(tokens[0].prefix).toBe('tok_abcd');
    // Plaintext token must never appear
    expect(tokens[0]).not.toHaveProperty('token');
    expect(tokens[0].revokedAt).toBeNull();
  });

  it('returns 503 on DB error', async () => {
    app = makeApp(makePool({ querySequence: [new Error('DB error')] }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/devices/device-1/tokens',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(503);
  });
});

// ── DELETE /api/v1/admin/devices/:deviceId/tokens/:tokenId ───────────────────

describe('DELETE /api/v1/admin/devices/:deviceId/tokens/:tokenId', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns 401 when X-Admin-Key is missing', async () => {
    app = makeApp(makePool());
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/devices/device-1/tokens/tok-1',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when token is not found or belongs to a different device', async () => {
    app = makeApp(makePool({ querySequence: [{ rows: [] }] }));
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/devices/device-1/tokens/unknown-tok',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });

  it('returns 200 with revokedAt on successful revocation', async () => {
    const revokedAt = new Date('2026-06-28T12:00:00Z');
    app = makeApp(makePool({ querySequence: [{ rows: [{ revoked_at: revokedAt }] }] }));
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/devices/device-1/tokens/tok-1',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tokenId: string; revokedAt: string }>();
    expect(body.tokenId).toBe('tok-1');
    expect(new Date(body.revokedAt)).toEqual(revokedAt);
  });

  it('is idempotent: returns 200 when token is already revoked', async () => {
    // COALESCE(revoked_at, now()) preserves existing revoked_at → RETURNING still fires
    const originalRevokedAt = new Date('2026-06-01T00:00:00Z');
    app = makeApp(makePool({ querySequence: [{ rows: [{ revoked_at: originalRevokedAt }] }] }));
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/devices/device-1/tokens/tok-1',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(new Date(res.json<{ revokedAt: string }>().revokedAt)).toEqual(originalRevokedAt);
  });

  it('returns 503 on DB error', async () => {
    app = makeApp(makePool({ querySequence: [new Error('DB error')] }));
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/devices/device-1/tokens/tok-1',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(503);
  });
});
