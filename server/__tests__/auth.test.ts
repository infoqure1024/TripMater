/**
 * Unit tests for auth middleware.
 *
 * The DB pool is fully mocked — no real PostgreSQL required.
 * Tests exercise: missing token, invalid token, expired token, revoked token,
 * disabled device, valid token (R1/R2), and admin key auth.
 */

import { createHash } from 'crypto';
import Fastify, { FastifyInstance, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { authPlugin, AuthenticatedDevice } from '../src/plugins/auth';

interface ErrorBody {
  error: { code: string; message: string };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hashToken(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}

type MockPool = {
  query: jest.Mock;
  end: jest.Mock;
};

function makeMockPool(): MockPool {
  return { query: jest.fn(), end: jest.fn().mockResolvedValue(undefined) };
}

/** Build a minimal Fastify app that decorates `db` and registers the auth plugin. */
function makeApp(pool: MockPool, adminApiKey = 'admin-secret'): FastifyInstance {
  const fastify = Fastify({ logger: false });
  fastify.decorate('db', pool as unknown as Pool);

  // authPlugin is wrapped with fastify-plugin (fp), so its decorators escape the
  // child scope and are added directly to the root fastify instance.
  void fastify.register(authPlugin, { adminApiKey });

  // Routes use lazy wrappers so they resolve verifyDeviceToken/verifyAdminKey at
  // request time — the decorators are guaranteed to exist by then (after ready()).
  fastify.get(
    '/protected',
    { preHandler: [(req, reply) => fastify.verifyDeviceToken(req, reply)] },
    async (request) => {
      return { device: (request as FastifyRequest & { device?: AuthenticatedDevice }).device };
    }
  );

  fastify.get(
    '/admin',
    { preHandler: [(req, reply) => fastify.verifyAdminKey(req, reply)] },
    async (request) => {
      return { isAdmin: (request as FastifyRequest & { isAdmin?: boolean }).isAdmin };
    }
  );

  return fastify;
}

// ─── DB row factory ────────────────────────────────────────────────────────────

function makeTokenRow(overrides: Partial<{
  id: string;
  device_id: string;
  revoked_at: Date | null;
  expires_at: Date | null;
  disabled_at: Date | null;
}> = {}) {
  return {
    id: 'token-id-1',
    device_id: 'device-uuid-1',
    revoked_at: null,
    expires_at: null,
    disabled_at: null,
    ...overrides,
  };
}

// ─── verifyDeviceToken tests ───────────────────────────────────────────────────

describe('verifyDeviceToken', () => {
  let app: FastifyInstance;
  let pool: MockPool;

  beforeEach(async () => {
    pool = makeMockPool();
    app = makeApp(pool);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
    expect(res.json<ErrorBody>().error.code).toBe('MISSING_TOKEN');
  });

  it('returns 401 when Authorization header is not Bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<ErrorBody>().error.code).toBe('MISSING_TOKEN');
  });

  it('returns 401 when token is not found in DB', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer tok_unknowntoken' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<ErrorBody>().error.code).toBe('INVALID_TOKEN');
  });

  it('queries DB with SHA-256 hash of the token', async () => {
    const rawToken = 'tok_abc123';
    const expectedHash = hashToken(rawToken);

    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${rawToken}` },
    });

    expect(pool.query).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const calledHash: Buffer = pool.query.mock.calls[0][1][0] as Buffer;
    expect(Buffer.isBuffer(calledHash)).toBe(true);
    expect(calledHash.equals(expectedHash)).toBe(true);
  });

  it('returns 401 when token is revoked', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [makeTokenRow({ revoked_at: new Date('2024-01-01') })],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer tok_revoked' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<ErrorBody>().error.code).toBe('TOKEN_EXPIRED');
  });

  it('returns 401 when token is expired', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [makeTokenRow({ expires_at: new Date('2020-01-01') })],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer tok_expired' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<ErrorBody>().error.code).toBe('TOKEN_EXPIRED');
  });

  it('returns 200 for a token that expires in the future', async () => {
    const futureDate = new Date(Date.now() + 86_400_000); // +1 day
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [makeTokenRow({ expires_at: futureDate })],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer tok_valid_expiry' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('returns 403 when device is disabled', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [makeTokenRow({ disabled_at: new Date('2024-06-01') })],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer tok_disabled_device' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorBody>().error.code).toBe('DEVICE_DISABLED');
  });

  it('injects device_id and tokenId from DB row (R2) and returns 200', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [makeTokenRow()],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer tok_validtoken' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ device: AuthenticatedDevice }>();
    expect(body.device.deviceId).toBe('device-uuid-1');
    expect(body.device.tokenId).toBe('token-id-1');
  });

  it('accepts a token with expires_at = null (no expiry)', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [makeTokenRow({ expires_at: null })],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer tok_no_expiry' },
    });

    expect(res.statusCode).toBe(200);
  });
});

// ─── makeVerifyAdminKey tests ──────────────────────────────────────────────────

describe('makeVerifyAdminKey', () => {
  let app: FastifyInstance;
  let pool: MockPool;

  beforeEach(async () => {
    pool = makeMockPool();
    app = makeApp(pool, 'super-secret-key');
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 401 when X-Admin-Key header is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin' });
    expect(res.statusCode).toBe(401);
    expect(res.json<ErrorBody>().error.code).toBe('INVALID_ADMIN_KEY');
  });

  it('returns 401 when X-Admin-Key is wrong', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { 'x-admin-key': 'wrong-key' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<ErrorBody>().error.code).toBe('INVALID_ADMIN_KEY');
  });

  it('returns 200 and sets isAdmin when key is correct', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { 'x-admin-key': 'super-secret-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ isAdmin: boolean }>().isAdmin).toBe(true);
  });
});

// ─── authPlugin decorator tests ────────────────────────────────────────────────

describe('authPlugin decorators', () => {
  it('decorates verifyDeviceToken and verifyAdminKey on the fastify instance', async () => {
    const pool = makeMockPool();
    const fastify = Fastify({ logger: false });
    fastify.decorate('db', pool as unknown as Pool);
    await fastify.register(authPlugin, { adminApiKey: 'k' });
    await fastify.ready();

    expect(typeof fastify.verifyDeviceToken).toBe('function');
    expect(typeof fastify.verifyAdminKey).toBe('function');

    await fastify.close();
  });
});
