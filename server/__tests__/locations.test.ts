import { FastifyInstance } from 'fastify';
import { Pool, PoolClient } from 'pg';
import { buildApp } from '../src/app';

// ── helpers ──────────────────────────────────────────────────────────────────

interface TokenRow {
  token_id: string;
  device_id: string;
  revoked_at: Date | null;
  expires_at: Date | null;
  disabled_at: Date | null;
}

function validTokenRow(deviceId = 'device-1'): TokenRow {
  return {
    token_id: 'tok-1',
    device_id: deviceId,
    revoked_at: null,
    expires_at: null,
    disabled_at: null,
  };
}

function makeSample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    deviceId: 'device-1',
    timestamp: 1_750_000_000_000,
    lat: 35.6895,
    lng: 139.6917,
    speedMps: 13.89,
    accuracyM: 5.0,
    ...overrides,
  };
}

/**
 * Build a mock Pool that:
 *   - pool.query()  → returns tokenRows (used by auth preHandler)
 *   - pool.connect() → returns a client that simulates a transaction:
 *       BEGIN/COMMIT/ROLLBACK → {rowCount:0}
 *       INSERT ... RETURNING → {rows: insertedIds.map(id=>({id})), rowCount: insertedIds.length}
 */
function makePool(tokenRows: TokenRow[], insertedIds: string[] = []): Pool {
  const client: Partial<PoolClient> & { query: jest.Mock; release: jest.Mock } = {
    query: jest.fn().mockImplementation(async (sql: string) => {
      const s = sql.trim().toUpperCase();
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      // INSERT … RETURNING
      return {
        rows: insertedIds.map((id) => ({ id })),
        rowCount: insertedIds.length,
      };
    }),
    release: jest.fn(),
  };

  return {
    query: jest.fn().mockResolvedValue({ rows: tokenRows, rowCount: tokenRows.length }),
    connect: jest.fn().mockResolvedValue(client),
    end: jest.fn().mockResolvedValue(undefined),
  } as unknown as Pool;
}

/** Pool whose connect() client throws on the INSERT query to simulate a DB error. */
function makeErrorPool(tokenRows: TokenRow[]): Pool {
  return makeErrorPoolWithClient(tokenRows)[0];
}

/**
 * Same as makeErrorPool but also returns the mock client so callers can assert
 * that release() was invoked in the finally block.
 */
function makeErrorPoolWithClient(tokenRows: TokenRow[]): [Pool, { release: jest.Mock }] {
  const client: { query: jest.Mock; release: jest.Mock } = {
    query: jest.fn().mockImplementation(async (sql: string) => {
      const s = sql.trim().toUpperCase();
      if (s === 'BEGIN' || s === 'ROLLBACK') return { rows: [], rowCount: 0 };
      throw new Error('DB connection error');
    }),
    release: jest.fn(),
  };

  const pool = {
    query: jest.fn().mockResolvedValue({ rows: tokenRows, rowCount: tokenRows.length }),
    connect: jest.fn().mockResolvedValue(client),
    end: jest.fn().mockResolvedValue(undefined),
  } as unknown as Pool;

  return [pool, client];
}

/** Pool whose connect() itself rejects to simulate pool exhaustion or DB unreachable. */
function makeConnectErrorPool(tokenRows: TokenRow[]): Pool {
  return {
    query: jest.fn().mockResolvedValue({ rows: tokenRows, rowCount: tokenRows.length }),
    connect: jest.fn().mockRejectedValue(new Error('connection pool exhausted')),
    end: jest.fn().mockResolvedValue(undefined),
  } as unknown as Pool;
}

function makeApp(pool: Pool, maxInflightRequests = 200): FastifyInstance {
  return buildApp(
    {
      port: 0,
      host: '127.0.0.1',
      databaseUrl: 'postgresql://localhost/test',
      adminApiKey: 'secret-admin-key',
      logLevel: 'silent',
      maxInflightRequests,
    },
    { pool }
  );
}

function validHeaders() {
  return {
    'content-type': 'application/json',
    authorization: 'Bearer valid-token',
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/locations', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  it('returns 401 when Authorization header is missing', async () => {
    app = makeApp(makePool([validTokenRow()]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, samples: [makeSample()] }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when device is disabled', async () => {
    const row = validTokenRow();
    row.disabled_at = new Date('2024-06-01T00:00:00Z');
    app = makeApp(makePool([row]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({ schemaVersion: 1, samples: [makeSample()] }),
    });
    expect(res.statusCode).toBe(403);
  });

  // ── Envelope validation (accept-and-drop, §2.3) ───────────────────────────

  it('returns 200 received:0 for unknown schemaVersion', async () => {
    app = makeApp(makePool([validTokenRow()]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({ schemaVersion: 99, samples: [makeSample()] }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ received: number }>();
    expect(body.received).toBe(0);
  });

  it('returns 200 received:0 when samples is not an array', async () => {
    app = makeApp(makePool([validTokenRow()]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({ schemaVersion: 1, samples: 'not-an-array' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ received: number }>().received).toBe(0);
  });

  it('returns 200 received:0 when samples is an empty array', async () => {
    app = makeApp(makePool([validTokenRow()]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({ schemaVersion: 1, samples: [] }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ received: number }>().received).toBe(0);
  });

  it('returns 200 received:0 for invalid JSON body (accept-and-drop, §2.3)', async () => {
    app = makeApp(makePool([validTokenRow()]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      payload: 'not-json{{{',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ received: number }>().received).toBe(0);
  });

  // ── Size limits (§7) ──────────────────────────────────────────────────────

  it('returns 413 when samples exceed 1000', async () => {
    app = makeApp(makePool([validTokenRow()]));
    const samples = Array.from({ length: 1001 }, (_, i) => ({
      ...makeSample(),
      id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({ schemaVersion: 1, samples }),
    });
    expect(res.statusCode).toBe(413);
  });

  // ── Happy path: all inserted ──────────────────────────────────────────────

  it('returns 200 with correct counts for a clean batch', async () => {
    const sampleId = '00000000-0000-0000-0000-000000000001';
    app = makeApp(makePool([validTokenRow()], [sampleId]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({ schemaVersion: 1, samples: [makeSample({ id: sampleId })] }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      received: number;
      inserted: number;
      duplicates: number;
      dropped: number;
      deviceMismatch: number;
      schemaVersion: number;
    }>();
    expect(body.received).toBe(1);
    expect(body.inserted).toBe(1);
    expect(body.duplicates).toBe(0);
    expect(body.dropped).toBe(0);
    expect(body.deviceMismatch).toBe(0);
    expect(body.schemaVersion).toBe(1);
  });

  // ── Idempotency: duplicate re-send → duplicates counted (§3.3, §8) ───────

  it('counts duplicates when ON CONFLICT returns 0 rows (re-send scenario)', async () => {
    // insertedIds = [] means ON CONFLICT DO NOTHING skipped all rows → duplicates
    app = makeApp(makePool([validTokenRow()], []));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({ schemaVersion: 1, samples: [makeSample()] }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      received: number;
      inserted: number;
      duplicates: number;
      dropped: number;
    }>();
    expect(body.received).toBe(1);
    expect(body.inserted).toBe(0);
    expect(body.duplicates).toBe(1);
    expect(body.dropped).toBe(0);
  });

  // ── Invariant: received = inserted + duplicates + dropped (§3.2) ──────────

  it('satisfies the invariant received = inserted + duplicates + dropped', async () => {
    // 3 samples: 1 dropped (bad id), 1 inserted, 1 duplicate
    const goodId1 = '00000000-0000-0000-0000-000000000001';
    const goodId2 = '00000000-0000-0000-0000-000000000002';
    const samples = [
      { ...makeSample({ id: 'not-a-uuid' }) }, // dropped
      { ...makeSample({ id: goodId1 }) }, // inserted
      { ...makeSample({ id: goodId2 }) }, // duplicate (conflict)
    ];
    // Only goodId1 is "newly inserted"
    app = makeApp(makePool([validTokenRow()], [goodId1]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({ schemaVersion: 1, samples }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      received: number;
      inserted: number;
      duplicates: number;
      dropped: number;
    }>();
    expect(body.received).toBe(3);
    expect(body.dropped).toBe(1);
    expect(body.inserted).toBe(1);
    expect(body.duplicates).toBe(1);
    // Invariant
    expect(body.inserted + body.duplicates + body.dropped).toBe(body.received);
  });

  // ── Per-sample validation: dropped cases (§3.3) ───────────────────────────

  it('drops samples with missing required fields', async () => {
    const samples = [
      makeSample({ id: undefined }), // missing id
      makeSample({ timestamp: undefined }), // missing timestamp
      makeSample({ lat: undefined }), // missing lat
      makeSample({ speedMps: -1 }), // negative speedMps
      makeSample({ accuracyM: -5 }), // negative accuracyM
    ];
    app = makeApp(makePool([validTokenRow()], []));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({ schemaVersion: 1, samples }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ received: number; dropped: number }>();
    expect(body.received).toBe(5);
    expect(body.dropped).toBe(5);
  });

  // ── device_id from token, not sample (R2) ─────────────────────────────────

  it('counts deviceMismatch when sample.deviceId differs from token device', async () => {
    const sampleId = '00000000-0000-0000-0000-000000000001';
    app = makeApp(makePool([validTokenRow('device-1')], [sampleId]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({
        schemaVersion: 1,
        samples: [makeSample({ id: sampleId, deviceId: 'device-WRONG' })],
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ deviceMismatch: number; inserted: number }>();
    // Sample is still inserted (not dropped) — mismatch is an independent counter
    expect(body.deviceMismatch).toBe(1);
    expect(body.inserted).toBe(1);
  });

  // ── DB error → 503 (§3.4) ────────────────────────────────────────────────

  it('returns 503 on DB error during insert', async () => {
    app = makeApp(makeErrorPool([validTokenRow()]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({ schemaVersion: 1, samples: [makeSample()] }),
    });
    expect(res.statusCode).toBe(503);
  });

  it('calls client.release() in finally block even when INSERT throws', async () => {
    const [pool, mockClient] = makeErrorPoolWithClient([validTokenRow()]);
    app = makeApp(pool);
    await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({ schemaVersion: 1, samples: [makeSample()] }),
    });
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('returns 503 when pool.connect() itself rejects (pool exhausted)', async () => {
    app = makeApp(makeConnectErrorPool([validTokenRow()]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({ schemaVersion: 1, samples: [makeSample()] }),
    });
    expect(res.statusCode).toBe(503);
  });

  // ── schemaVersion absent → received:0 ────────────────────────────────────

  it('returns 200 received:0 when schemaVersion field is absent', async () => {
    app = makeApp(makePool([validTokenRow()]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({ samples: [makeSample()] }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ received: number }>().received).toBe(0);
  });

  // ── All samples dropped → no DB call needed ───────────────────────────────

  it('returns 200 without hitting DB when every sample is dropped', async () => {
    const pool = makePool([validTokenRow()], []);
    app = makeApp(pool);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({
        schemaVersion: 1,
        samples: [makeSample({ id: 'not-a-uuid' })],
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ received: number; dropped: number; inserted: number }>();
    expect(body.received).toBe(1);
    expect(body.dropped).toBe(1);
    expect(body.inserted).toBe(0);
    // pool.connect() should never be called when all samples are dropped
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(pool.connect).not.toHaveBeenCalled();
  });

  // ── Optional fields are accepted (clamp/null, §2.3) ──────────────────────

  it('accepts a sample with optional fields and counts it as inserted', async () => {
    const sampleId = '00000000-0000-0000-0000-000000000001';
    app = makeApp(makePool([validTokenRow()], [sampleId]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({
        schemaVersion: 1,
        samples: [
          makeSample({
            id: sampleId,
            rawSpeedMps: 14.1,
            headingDeg: 270,
            altitudeM: 30,
            distanceDeltaM: 13.89,
            sessionId: 'session-uuid',
          }),
        ],
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ inserted: number }>().inserted).toBe(1);
  });

  // ── 503 includes Retry-After header (§1.3, §7) ───────────────────────────

  it('returns Retry-After header with 503 on DB error', async () => {
    app = makeApp(makeErrorPool([validTokenRow()]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({ schemaVersion: 1, samples: [makeSample()] }),
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBeDefined();
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('returns Retry-After header with 503 on pool exhaustion', async () => {
    app = makeApp(makeConnectErrorPool([validTokenRow()]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({ schemaVersion: 1, samples: [makeSample()] }),
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBeDefined();
  });

  // ── Uniform {error:{code,message}} body shape for auth errors (§3.4) ─────

  it('returns structured error body for 401 missing auth header', async () => {
    app = makeApp(makePool([validTokenRow()]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, samples: [makeSample()] }),
    });
    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(typeof body.error.message).toBe('string');
  });

  it('returns structured error body for 403 disabled device', async () => {
    const row = validTokenRow();
    row.disabled_at = new Date('2024-06-01T00:00:00Z');
    app = makeApp(makePool([row]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({ schemaVersion: 1, samples: [makeSample()] }),
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('FORBIDDEN');
    expect(typeof body.error.message).toBe('string');
  });
});

// ── Overload guard: 503 + Retry-After when maxInflight exceeded (§1.3, §7) ──

describe('overload guard', () => {
  it('returns 503 + Retry-After when maxInflightRequests is 0', async () => {
    const app = makeApp(makePool([validTokenRow()]), 0);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({ schemaVersion: 1, samples: [makeSample()] }),
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBeDefined();
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    await app.close();
  });

  it('passes through normally when inflight is below limit', async () => {
    const sampleId = '00000000-0000-0000-0000-000000000001';
    const app = makeApp(makePool([validTokenRow()], [sampleId]), 10);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: validHeaders(),
      body: JSON.stringify({ schemaVersion: 1, samples: [makeSample({ id: sampleId })] }),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
