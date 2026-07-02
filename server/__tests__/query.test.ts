import { FastifyInstance } from 'fastify';
import { Pool, PoolClient } from 'pg';
import { buildApp } from '../src/app';

// ── helpers ──────────────────────────────────────────────────────────────────

const ADMIN_KEY = 'secret-admin-key';
const DEVICE_ID = 'device-aaa';
const OTHER_DEVICE_ID = 'device-bbb';
const SESSION_ID = 'session-001';

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

interface TokenRow {
  token_id: string;
  device_id: string;
  revoked_at: Date | null;
  expires_at: Date | null;
  disabled_at: Date | null;
}

function validTokenRow(deviceId = DEVICE_ID): TokenRow {
  return {
    token_id: 'tok-1',
    device_id: deviceId,
    revoked_at: null,
    expires_at: null,
    disabled_at: null,
  };
}

type QueryResult = { rows: unknown[]; rowCount?: number } | Error;

/**
 * Builds a mock Pool where pool.query() returns responses from `querySequence` in order.
 * Used for query route tests (no transactions needed — all reads use pool.query directly).
 */
function makePool(querySequence: QueryResult[] = []): Pool {
  let qi = 0;

  const client: Partial<PoolClient> & { query: jest.Mock; release: jest.Mock } = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
  };

  return {
    query: jest.fn().mockImplementation(async () => {
      const r = querySequence[qi++];
      if (r instanceof Error) throw r;
      return { rows: r?.rows ?? [], rowCount: r?.rowCount ?? r?.rows?.length ?? 0 };
    }),
    connect: jest.fn().mockResolvedValue(client),
    end: jest.fn().mockResolvedValue(undefined),
  } as unknown as Pool;
}

function adminHeaders(): Record<string, string> {
  return { 'x-admin-key': ADMIN_KEY };
}

function deviceHeaders(token = 'valid-token'): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

interface SessionSummary {
  sessionId: string;
  deviceId: string;
  sampleCount: number;
  totalDistanceM: number;
  startedAt: string;
  endedAt: string;
}

interface SessionsBody {
  sessions: SessionSummary[];
  total: number;
}

interface SampleItem {
  id: string;
  deviceId: string;
  sessionId: string;
  recordedAt: string;
  lat: number;
  lng: number;
  speedMps: number;
  rawSpeedMps: number | null;
  accuracyM: number;
  headingDeg: number | null;
  altitudeM: number | null;
  distanceDeltaM: number | null;
  ingestedAt: string;
}

interface SamplesBody {
  samples: SampleItem[];
  total: number;
}

interface ErrorBody {
  error: { code: string; message: string };
}

// Typical session row returned by aggregate queries
function sessionRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    session_id: SESSION_ID,
    device_id: DEVICE_ID,
    sample_count: '42',
    total_distance_m: '5432.1',
    started_at: new Date('2024-01-01T08:00:00Z'),
    ended_at: new Date('2024-01-01T09:00:00Z'),
    ...overrides,
  };
}

// Typical sample row returned by samples query
function sampleRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    device_id: DEVICE_ID,
    session_id: SESSION_ID,
    recorded_at: new Date('2024-01-01T08:00:01Z'),
    lat: 35.6895,
    lng: 139.6917,
    speed_mps: 13.89,
    raw_speed_mps: 14.1,
    accuracy_m: 5.0,
    heading_deg: 270,
    altitude_m: 30,
    distance_delta_m: 13.89,
    ingested_at: new Date('2024-01-01T08:00:02Z'),
    ...overrides,
  };
}

// ── GET /api/v1/devices/:deviceId/sessions ───────────────────────────────────

describe('GET /api/v1/devices/:deviceId/sessions', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns 401 when no auth is provided', async () => {
    app = makeApp(makePool());
    const res = await app.inject({ method: 'GET', url: `/api/v1/devices/${DEVICE_ID}/sessions` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for invalid admin key', async () => {
    app = makeApp(makePool());
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/devices/${DEVICE_ID}/sessions`,
      headers: { 'x-admin-key': 'wrong-key' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when device token accesses a different deviceId (IDOR)', async () => {
    // Auth lookup returns DEVICE_ID; path has OTHER_DEVICE_ID
    app = makeApp(makePool([{ rows: [validTokenRow(DEVICE_ID)] }]));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/devices/${OTHER_DEVICE_ID}/sessions`,
      headers: deviceHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with sessions for device token accessing own deviceId', async () => {
    app = makeApp(
      makePool([
        { rows: [validTokenRow(DEVICE_ID)] }, // auth token lookup
        { rows: [sessionRow()] }, // sessions query
        { rows: [{ total: '1' }] }, // count query (Promise.all)
      ])
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/devices/${DEVICE_ID}/sessions`,
      headers: deviceHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SessionsBody>();
    expect(body.sessions).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.sessions[0].sessionId).toBe(SESSION_ID);
    expect(body.sessions[0].deviceId).toBe(DEVICE_ID);
    expect(body.sessions[0].sampleCount).toBe(42);
    expect(body.sessions[0].totalDistanceM).toBeCloseTo(5432.1, 1);
  });

  it('returns 200 with sessions for admin accessing any deviceId', async () => {
    app = makeApp(
      makePool([
        { rows: [sessionRow({ device_id: OTHER_DEVICE_ID })] }, // no auth query for admin
        { rows: [{ total: '1' }] },
      ])
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/devices/${OTHER_DEVICE_ID}/sessions`,
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SessionsBody>();
    expect(body.sessions).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it('returns 200 with empty sessions list when device has no sessions', async () => {
    app = makeApp(
      makePool([{ rows: [validTokenRow(DEVICE_ID)] }, { rows: [] }, { rows: [{ total: '0' }] }])
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/devices/${DEVICE_ID}/sessions`,
      headers: deviceHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SessionsBody>();
    expect(body.sessions).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it('returns 400 for invalid limit param', async () => {
    app = makeApp(makePool([{ rows: [validTokenRow(DEVICE_ID)] }]));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/devices/${DEVICE_ID}/sessions?limit=0`,
      headers: deviceHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for limit exceeding max', async () => {
    app = makeApp(makePool([{ rows: [validTokenRow(DEVICE_ID)] }]));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/devices/${DEVICE_ID}/sessions?limit=101`,
      headers: deviceHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 on DB error', async () => {
    app = makeApp(makePool([{ rows: [validTokenRow(DEVICE_ID)] }, new Error('DB down')]));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/devices/${DEVICE_ID}/sessions`,
      headers: deviceHeaders(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<ErrorBody>().error.code).toBe('SERVICE_UNAVAILABLE');
  });
});

// ── GET /api/v1/sessions/:sessionId/summary ──────────────────────────────────

describe('GET /api/v1/sessions/:sessionId/summary', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns 401 when no auth is provided', async () => {
    app = makeApp(makePool());
    const res = await app.inject({ method: 'GET', url: `/api/v1/sessions/${SESSION_ID}/summary` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when device token accesses another device session (IDOR)', async () => {
    // token belongs to DEVICE_ID, but session belongs to OTHER_DEVICE_ID → 0 rows → 404
    app = makeApp(makePool([{ rows: [validTokenRow(DEVICE_ID)] }, { rows: [] }]));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${SESSION_ID}/summary`,
      headers: deviceHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when session does not exist', async () => {
    app = makeApp(makePool([{ rows: [validTokenRow(DEVICE_ID)] }, { rows: [] }]));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/nonexistent/summary`,
      headers: deviceHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('returns 200 with summary for device token accessing own session', async () => {
    app = makeApp(makePool([{ rows: [validTokenRow(DEVICE_ID)] }, { rows: [sessionRow()] }]));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${SESSION_ID}/summary`,
      headers: deviceHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SessionSummary>();
    expect(body.sessionId).toBe(SESSION_ID);
    expect(body.deviceId).toBe(DEVICE_ID);
    expect(body.sampleCount).toBe(42);
    expect(body.totalDistanceM).toBeCloseTo(5432.1, 1);
    expect(body.startedAt).toBeDefined();
    expect(body.endedAt).toBeDefined();
  });

  it('returns 200 with summary for admin (any session)', async () => {
    app = makeApp(makePool([{ rows: [sessionRow({ device_id: OTHER_DEVICE_ID })] }]));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${SESSION_ID}/summary`,
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SessionSummary>().deviceId).toBe(OTHER_DEVICE_ID);
  });

  it('returns 200 with first row when session_id appears under multiple devices (admin, UUID collision)', async () => {
    // If session_id appears for two devices (client bug / UUID collision), admin path uses
    // GROUP BY session_id, device_id ORDER BY MIN(recorded_at) ASC LIMIT 1 → deterministic first row.
    app = makeApp(
      makePool([
        // DB returns only one row due to LIMIT 1 in the fixed admin SQL
        { rows: [sessionRow({ device_id: DEVICE_ID })] },
      ])
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${SESSION_ID}/summary`,
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SessionSummary>().sessionId).toBe(SESSION_ID);
  });

  it('returns 503 on DB error', async () => {
    app = makeApp(makePool([{ rows: [validTokenRow(DEVICE_ID)] }, new Error('DB down')]));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${SESSION_ID}/summary`,
      headers: deviceHeaders(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<ErrorBody>().error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('returns all device groups as an array when admin passes ?all=true (session_id collision)', async () => {
    app = makeApp(
      makePool([
        {
          rows: [sessionRow({ device_id: DEVICE_ID }), sessionRow({ device_id: OTHER_DEVICE_ID })],
        },
      ])
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${SESSION_ID}/summary?all=true`,
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SessionsBody>();
    expect(body.sessions).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.sessions.map((s) => s.deviceId).sort()).toEqual(
      [DEVICE_ID, OTHER_DEVICE_ID].sort()
    );
  });

  it('ignores ?all=true for device tokens (still returns a single flat object)', async () => {
    app = makeApp(makePool([{ rows: [validTokenRow(DEVICE_ID)] }, { rows: [sessionRow()] }]));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${SESSION_ID}/summary?all=true`,
      headers: deviceHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SessionSummary>();
    expect(body.sessionId).toBe(SESSION_ID);
    expect(body.deviceId).toBe(DEVICE_ID);
  });
});

// ── GET /api/v1/sessions/:sessionId/samples ──────────────────────────────────

describe('GET /api/v1/sessions/:sessionId/samples', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns 401 when no auth is provided', async () => {
    app = makeApp(makePool());
    const res = await app.inject({ method: 'GET', url: `/api/v1/sessions/${SESSION_ID}/samples` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when device token accesses another device session (IDOR)', async () => {
    // ownership check returns 0 rows (session belongs to OTHER_DEVICE_ID)
    app = makeApp(makePool([{ rows: [validTokenRow(DEVICE_ID)] }, { rows: [] }]));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${SESSION_ID}/samples`,
      headers: deviceHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('returns 200 with samples for device token accessing own session', async () => {
    const pool = makePool([
      { rows: [validTokenRow(DEVICE_ID)] }, // auth
      { rows: [{ device_id: DEVICE_ID }] }, // ownership check
      { rows: [sampleRow()] }, // samples query (Promise.all)
      { rows: [{ total: '1' }] }, // count query (Promise.all)
    ]);
    app = makeApp(pool);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${SESSION_ID}/samples`,
      headers: deviceHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SamplesBody>();
    expect(body.samples).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.samples[0].sessionId).toBe(SESSION_ID);
    expect(body.samples[0].deviceId).toBe(DEVICE_ID);
    expect(body.samples[0].lat).toBe(35.6895);
    expect(body.samples[0].speedMps).toBe(13.89);

    // Verify device_id is passed to both the samples fetch and count queries (security fix).
    // pool.query call order: [0]=auth, [1]=ownership, [2]=samples, [3]=count
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const poolQueryMock = jest.mocked(pool.query);
    const samplesFetchParams = poolQueryMock.mock.calls[2][1] as unknown[];
    const countParams = poolQueryMock.mock.calls[3][1] as unknown[];
    expect(samplesFetchParams).toContain(DEVICE_ID);
    expect(countParams).toContain(DEVICE_ID);
  });

  it('returns 200 with samples for admin (no ownership check)', async () => {
    app = makeApp(
      makePool([
        // no auth query for admin, no ownership check
        { rows: [sampleRow({ device_id: OTHER_DEVICE_ID })] },
        { rows: [{ total: '1' }] },
      ])
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${SESSION_ID}/samples`,
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SamplesBody>();
    expect(body.samples).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.samples[0].deviceId).toBe(OTHER_DEVICE_ID);
  });

  it('returns 200 with empty samples when session exists but is empty (admin)', async () => {
    app = makeApp(makePool([{ rows: [] }, { rows: [{ total: '0' }] }]));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${SESSION_ID}/samples`,
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SamplesBody>();
    expect(body.samples).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it('returns 400 for invalid offset param', async () => {
    app = makeApp(makePool([{ rows: [validTokenRow(DEVICE_ID)] }]));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${SESSION_ID}/samples?offset=-1`,
      headers: deviceHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for limit exceeding max (1000)', async () => {
    app = makeApp(makePool([{ rows: [validTokenRow(DEVICE_ID)] }]));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${SESSION_ID}/samples?limit=1001`,
      headers: deviceHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 on DB error during ownership check', async () => {
    app = makeApp(makePool([{ rows: [validTokenRow(DEVICE_ID)] }, new Error('DB down')]));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${SESSION_ID}/samples`,
      headers: deviceHeaders(),
    });
    expect(res.statusCode).toBe(503);
  });

  it('returns 503 on DB error during samples fetch (admin)', async () => {
    app = makeApp(makePool([new Error('DB down')]));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${SESSION_ID}/samples`,
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(503);
  });

  it('maps null optional fields correctly', async () => {
    app = makeApp(
      makePool([
        { rows: [validTokenRow(DEVICE_ID)] },
        { rows: [{ device_id: DEVICE_ID }] },
        {
          rows: [
            sampleRow({
              raw_speed_mps: null,
              heading_deg: null,
              altitude_m: null,
              distance_delta_m: null,
            }),
          ],
        },
        { rows: [{ total: '1' }] },
      ])
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${SESSION_ID}/samples`,
      headers: deviceHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const sample = res.json<SamplesBody>().samples[0];
    expect(sample.rawSpeedMps).toBeNull();
    expect(sample.headingDeg).toBeNull();
    expect(sample.altitudeM).toBeNull();
    expect(sample.distanceDeltaM).toBeNull();
  });
});
