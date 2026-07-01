/**
 * Integration tests — Issue #59
 * 冪等性 / 不変条件 / 認証 / IDOR
 *
 * These tests require a real PostgreSQL database.
 * They are skipped automatically when DATABASE_URL is not set in the environment.
 *
 * CI setup: server-ci.yml provides
 *   DATABASE_URL=postgresql://tripmater:tripmater@localhost:5432/tripmater_test
 *   ADMIN_API_KEY=ci-test-admin-key
 */

import crypto from 'crypto';
import { Pool } from 'pg';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';

// ── Skip guard ────────────────────────────────────────────────────────────────

const INTEGRATION_DB_URL = process.env['DATABASE_URL'];
const describeDb = INTEGRATION_DB_URL ? describe : describe.skip;

const ADMIN_KEY = process.env['ADMIN_API_KEY'] ?? 'ci-test-admin-key';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DeviceCreatedResponse {
  deviceId: string;
}

interface TokenCreatedResponse {
  deviceId: string;
  tokenId: string;
  token: string;
  expiresAt: string | null;
}

interface IngestResponse {
  received: number;
  inserted: number;
  duplicates: number;
  dropped: number;
  deviceMismatch: number;
  schemaVersion: number;
}

interface SampleInput {
  id: string;
  deviceId?: string;
  timestamp: number;
  lat: number;
  lng: number;
  speedMps: number;
  accuracyM: number;
  rawSpeedMps?: number | null;
  headingDeg?: number | null;
  altitudeM?: number | null;
  distanceDeltaM?: number | null;
  sessionId?: string | null;
}

interface SessionSummaryItem {
  sessionId: string;
  deviceId: string;
  sampleCount: number;
  totalDistanceM: number;
  startedAt: string;
  endedAt: string;
}

interface SessionsListResponse {
  sessions: SessionSummaryItem[];
  total: number;
}

// ── Helper utilities ──────────────────────────────────────────────────────────

async function createDevice(app: FastifyInstance, adminKey: string): Promise<string> {
  const deviceId = `test-device-${crypto.randomUUID()}`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/devices',
    headers: { 'x-admin-key': adminKey, 'content-type': 'application/json' },
    payload: { deviceId },
  });
  if (res.statusCode !== 201) {
    throw new Error(`createDevice failed: ${res.statusCode} ${res.body}`);
  }
  return res.json<DeviceCreatedResponse>().deviceId;
}

async function createToken(
  app: FastifyInstance,
  adminKey: string,
  deviceId: string
): Promise<{ tokenId: string; plaintext: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/admin/devices/${deviceId}/tokens`,
    headers: { 'x-admin-key': adminKey, 'content-type': 'application/json' },
    payload: {},
  });
  if (res.statusCode !== 201) {
    throw new Error(`createToken failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json<TokenCreatedResponse>();
  return { tokenId: body.tokenId, plaintext: body.token };
}

function makeSample(overrides: Partial<SampleInput> = {}): SampleInput {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    lat: 35.6895,
    lng: 139.6917,
    speedMps: 13.89,
    accuracyM: 5.0,
    ...overrides,
  };
}

async function ingest(
  app: FastifyInstance,
  token: string,
  samples: SampleInput[]
): Promise<IngestResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/locations',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    payload: { schemaVersion: 1, samples },
  });
  if (res.statusCode !== 200) {
    throw new Error(`ingest returned ${res.statusCode}: ${res.body}`);
  }
  return res.json<IngestResponse>();
}

// ── Integration test suite ────────────────────────────────────────────────────

describeDb('統合テスト (real PostgreSQL)', () => {
  // H-1 fix: separate pools — appPool is owned by buildApp (ended via onClose),
  // cleanupPool is owned by the test suite (ended explicitly in afterAll).
  let cleanupPool: Pool;
  let app: FastifyInstance;
  const createdDeviceIds: string[] = [];

  beforeAll(async () => {
    cleanupPool = new Pool({ connectionString: INTEGRATION_DB_URL });
    const appPool = new Pool({ connectionString: INTEGRATION_DB_URL });
    app = buildApp(
      {
        port: 0,
        host: '127.0.0.1',
        databaseUrl: INTEGRATION_DB_URL!,
        adminApiKey: ADMIN_KEY,
        logLevel: 'silent',
        requestTimeoutMs: 29_000,
        maxInflightRequests: 200,
      },
      { pool: appPool }
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close(); // ends appPool via the onClose hook in buildApp
    await cleanupPool.end();
  });

  afterEach(async () => {
    // location_samples.device_id has NO ACTION (no cascade), so delete child rows first.
    if (createdDeviceIds.length > 0) {
      await cleanupPool.query(`DELETE FROM location_samples WHERE device_id = ANY($1::text[])`, [
        createdDeviceIds,
      ]);
      await cleanupPool.query(`DELETE FROM devices WHERE id = ANY($1::text[])`, [createdDeviceIds]);
      createdDeviceIds.length = 0;
    }
  });

  // Helper that creates a device and tracks it for cleanup
  async function makeDevice(): Promise<string> {
    const deviceId = await createDevice(app, ADMIN_KEY);
    createdDeviceIds.push(deviceId);
    return deviceId;
  }

  // ── A. 冪等性 (Idempotency) ─────────────────────────────────────────────────

  describe('A. 冪等性: 同一バッチを2回 POST しても duplicates でカウントされる', () => {
    it('2回目の送信は inserted=0, duplicates=3, received=3 になる', async () => {
      // Arrange
      const deviceId = await makeDevice();
      const { plaintext: token } = await createToken(app, ADMIN_KEY, deviceId);
      const samples = [makeSample(), makeSample(), makeSample()];

      // Act — first POST
      const first = await ingest(app, token, samples);
      expect(first.inserted).toBe(3);
      expect(first.duplicates).toBe(0);
      expect(first.dropped).toBe(0);
      expect(first.deviceMismatch).toBe(0);

      // Act — second POST with identical samples
      const second = await ingest(app, token, samples);

      // Assert
      expect(second.received).toBe(3);
      expect(second.inserted).toBe(0);
      expect(second.duplicates).toBe(3);
      expect(second.dropped).toBe(0);
      expect(second.deviceMismatch).toBe(0); // M-4: assert no spurious mismatch
    });

    it('不変条件: received = inserted + duplicates + dropped (冪等性ケース)', async () => {
      // Arrange
      const deviceId = await makeDevice();
      const { plaintext: token } = await createToken(app, ADMIN_KEY, deviceId);
      const samples = [makeSample(), makeSample()];

      // Act
      const first = await ingest(app, token, samples);
      const second = await ingest(app, token, samples);

      // Assert invariant holds for both responses
      expect(first.received).toBe(first.inserted + first.duplicates + first.dropped);
      expect(second.received).toBe(second.inserted + second.duplicates + second.dropped);
    });
  });

  // ── B. 不変条件 (Invariant) ─────────────────────────────────────────────────

  describe('B. 不変条件: received = inserted + duplicates + dropped', () => {
    it('有効1件 + 無効1件(drop) + 既存1件(duplicate) の混合バッチでも不変条件が成立する', async () => {
      // Arrange
      const deviceId = await makeDevice();
      const { plaintext: token } = await createToken(app, ADMIN_KEY, deviceId);
      const validSample = makeSample();

      // Step 1: insert the valid sample
      const step1 = await ingest(app, token, [validSample]);
      expect(step1.inserted).toBe(1);

      // Step 2: send 1 valid new sample + 1 invalid sample (has id but timestamp missing → dropped)
      // + 1 duplicate. H-3 fix: provide id so drop reason is timestamp, not id.
      const invalidSample = {
        id: crypto.randomUUID(),
        // timestamp intentionally omitted → validateSample returns null
        lat: 35.6895,
        lng: 139.6917,
        speedMps: 13.89,
        accuracyM: 5.0,
      };
      const newValidSample = makeSample();
      const step2 = await ingest(app, token, [
        newValidSample,
        invalidSample as SampleInput,
        validSample, // already inserted → duplicate
      ]);

      // Assert invariant
      expect(step2.received).toBe(3);
      expect(step2.inserted).toBe(1); // newValidSample
      expect(step2.duplicates).toBe(1); // validSample from step 1
      expect(step2.dropped).toBe(1); // invalidSample (dropped because timestamp is missing)
      expect(step2.received).toBe(step2.inserted + step2.duplicates + step2.dropped);
    });
  });

  // ── C. 認証 R1 - 失効トークン ────────────────────────────────────────────────

  describe('C. 認証 R1: 失効トークン → 401', () => {
    it('DELETE で失効させたトークンでの POST /locations は 401 を返す', async () => {
      // Arrange
      const deviceId = await makeDevice();
      const { tokenId, plaintext: token } = await createToken(app, ADMIN_KEY, deviceId);

      // Revoke the token
      const revokeRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/devices/${deviceId}/tokens/${tokenId}`,
        headers: { 'x-admin-key': ADMIN_KEY },
      });
      expect(revokeRes.statusCode).toBe(200);

      // Act
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { schemaVersion: 1, samples: [makeSample()] },
      });

      // Assert
      expect(res.statusCode).toBe(401);
    });
  });

  // ── D. 認証 R1 - 期限切れトークン ──────────────────────────────────────────

  describe('D. 認証 R1: 期限切れトークン → 401', () => {
    it('expires_at が過去のトークンでの POST /locations は 401 を返す', async () => {
      // Arrange: create device and directly insert an already-expired token
      const deviceId = await makeDevice();
      const tokenId = crypto.randomUUID();
      const plaintext = `tok_${crypto.randomBytes(32).toString('base64url')}`;
      const tokenHash = crypto.createHash('sha256').update(plaintext, 'utf8').digest();
      const prefix = `tok_${plaintext.slice(4, 8)}`;

      // H-2 fix: assert the INSERT succeeded so the test doesn't vacuously pass
      const insertResult = await cleanupPool.query(
        `INSERT INTO api_tokens (id, device_id, token_hash, prefix, expires_at, created_at)
         VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 hour', NOW())`,
        [tokenId, deviceId, tokenHash, prefix]
      );
      expect(insertResult.rowCount).toBe(1);

      // Act
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
        payload: { schemaVersion: 1, samples: [makeSample()] },
      });

      // Assert
      expect(res.statusCode).toBe(401);
    });
  });

  // ── E. 認証 R1 - デバイス無効化 ─────────────────────────────────────────────

  describe('E. 認証 R1: デバイス無効化 → 403', () => {
    it('disabled_at が設定されたデバイスのトークンでの POST /locations は 403 を返す', async () => {
      // Arrange
      const deviceId = await makeDevice();
      const { plaintext: token } = await createToken(app, ADMIN_KEY, deviceId);

      // Disable the device directly in DB
      await cleanupPool.query(`UPDATE devices SET disabled_at = NOW() WHERE id = $1`, [deviceId]);

      // Act
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { schemaVersion: 1, samples: [makeSample()] },
      });

      // Assert
      expect(res.statusCode).toBe(403);
    });
  });

  // ── F. device_id 導出 R2 (deviceId spoofing) ────────────────────────────────

  describe('F. device_id 導出 R2: サンプルの deviceId はトークンのデバイス ID で上書きされる', () => {
    it('samples[].deviceId に偽装 ID を入れても DB には正しい device_id で保存される', async () => {
      // Arrange
      const deviceId = await makeDevice();
      const { plaintext: token } = await createToken(app, ADMIN_KEY, deviceId);
      const sessionId = crypto.randomUUID();
      const sample = makeSample({ deviceId: 'device-B-fake-id', sessionId });

      // Act
      const result = await ingest(app, token, [sample]);

      // Assert: deviceMismatch is counted
      expect(result.deviceMismatch).toBeGreaterThan(0);
      expect(result.inserted).toBeGreaterThan(0);

      // Verify: stored sample has device_id = real device's ID, not the spoofed one
      const dbRows = await cleanupPool.query<{ device_id: string }>(
        `SELECT device_id FROM location_samples WHERE id = $1`,
        [sample.id]
      );
      expect(dbRows.rows).toHaveLength(1);
      expect(dbRows.rows[0]?.device_id).toBe(deviceId);
      expect(dbRows.rows[0]?.device_id).not.toBe('device-B-fake-id');
    });
  });

  // ── G. IDOR S4 ──────────────────────────────────────────────────────────────

  describe('G. IDOR S4: 他デバイスのセッション・サマリーは 404 を返す', () => {
    it('デバイス B のトークンでデバイス A のセッション一覧を取得すると 404', async () => {
      // Arrange
      const deviceAId = await makeDevice();
      const deviceBId = await makeDevice();
      const { plaintext: tokenA } = await createToken(app, ADMIN_KEY, deviceAId);
      const { plaintext: tokenB } = await createToken(app, ADMIN_KEY, deviceBId);

      // Ingest a session under device A
      const sessionId = crypto.randomUUID();
      await ingest(app, tokenA, [makeSample({ sessionId })]);

      // Act: device B tries to list device A's sessions
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/devices/${deviceAId}/sessions`,
        headers: { authorization: `Bearer ${tokenB}` },
      });

      // Assert
      expect(res.statusCode).toBe(404);
    });

    // M-5: admin can access any device's sessions (positive path)
    it('admin キーはどのデバイスのセッション一覧も取得できる', async () => {
      // Arrange
      const deviceAId = await makeDevice();
      const { plaintext: tokenA } = await createToken(app, ADMIN_KEY, deviceAId);
      const sessionId = crypto.randomUUID();
      await ingest(app, tokenA, [makeSample({ sessionId })]);

      // Act: admin accesses device A's sessions
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/devices/${deviceAId}/sessions`,
        headers: { 'x-admin-key': ADMIN_KEY },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const body = res.json<SessionsListResponse>();
      expect(body.sessions.length).toBeGreaterThan(0);
    });

    it('デバイス B のトークンでデバイス A のセッションサマリーを取得すると 404', async () => {
      // Arrange
      const deviceAId = await makeDevice();
      const deviceBId = await makeDevice();
      const { plaintext: tokenA } = await createToken(app, ADMIN_KEY, deviceAId);
      const { plaintext: tokenB } = await createToken(app, ADMIN_KEY, deviceBId);

      // Ingest a session under device A
      const sessionId = crypto.randomUUID();
      await ingest(app, tokenA, [makeSample({ sessionId })]);

      // Retrieve the sessionId from device A's sessions (using admin key)
      const sessionsRes = await app.inject({
        method: 'GET',
        url: `/api/v1/devices/${deviceAId}/sessions`,
        headers: { 'x-admin-key': ADMIN_KEY },
      });
      expect(sessionsRes.statusCode).toBe(200);
      const sessionsBody = sessionsRes.json<SessionsListResponse>();
      expect(sessionsBody.sessions.length).toBeGreaterThan(0);
      const storedSessionId = sessionsBody.sessions[0]?.sessionId ?? '';

      // Act: device B tries to access device A's session summary
      const summaryRes = await app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${storedSessionId}/summary`,
        headers: { authorization: `Bearer ${tokenB}` },
      });

      // Assert
      expect(summaryRes.statusCode).toBe(404);
    });

    it('デバイス B のトークンでデバイス A のセッションサンプル一覧を取得すると 404', async () => {
      // Arrange
      const deviceAId = await makeDevice();
      const deviceBId = await makeDevice();
      const { plaintext: tokenA } = await createToken(app, ADMIN_KEY, deviceAId);
      const { plaintext: tokenB } = await createToken(app, ADMIN_KEY, deviceBId);

      // Ingest a session under device A
      const sessionId = crypto.randomUUID();
      await ingest(app, tokenA, [makeSample({ sessionId })]);

      // M-2 fix: query DB to get the stored sessionId (consistent with summary test)
      const sessionsRes = await app.inject({
        method: 'GET',
        url: `/api/v1/devices/${deviceAId}/sessions`,
        headers: { 'x-admin-key': ADMIN_KEY },
      });
      expect(sessionsRes.statusCode).toBe(200);
      const storedSessionId = sessionsRes.json<SessionsListResponse>().sessions[0]?.sessionId ?? '';

      // Act: device B tries to access device A's session samples
      const samplesRes = await app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${storedSessionId}/samples`,
        headers: { authorization: `Bearer ${tokenB}` },
      });

      // Assert
      expect(samplesRes.statusCode).toBe(404);
    });
  });

  // ── H. バックプレッシャー (503 + Retry-After) ────────────────────────────────

  describe('H. バックプレッシャー: maxInflightRequests=0 → 503 + Retry-After', () => {
    it('maxInflightRequests=0 のアプリへの POST /locations は 503 を返し Retry-After ヘッダーを持つ', async () => {
      // M-1 fix: overload guard fires in onRequest before auth, so no real token needed.
      // Build a separate app instance with maxInflightRequests=0.
      const limitedPool = new Pool({ connectionString: INTEGRATION_DB_URL });
      const limitedApp = buildApp(
        {
          port: 0,
          host: '127.0.0.1',
          databaseUrl: INTEGRATION_DB_URL!,
          adminApiKey: ADMIN_KEY,
          logLevel: 'silent',
          requestTimeoutMs: 29_000,
          maxInflightRequests: 0,
        },
        { pool: limitedPool }
      );

      try {
        await limitedApp.ready();

        // Act — any token value triggers the 503 before auth runs
        const res = await limitedApp.inject({
          method: 'POST',
          url: '/api/v1/locations',
          headers: {
            authorization: 'Bearer irrelevant',
            'content-type': 'application/json',
          },
          payload: { schemaVersion: 1, samples: [makeSample()] },
        });

        // Assert
        expect(res.statusCode).toBe(503);
        expect(res.headers['retry-after']).toBeDefined();
      } finally {
        await limitedApp.close(); // ends limitedPool via onClose
      }
    });
  });

  // ── I. 追加カバレッジ (Issue #99) ───────────────────────────────────────────

  describe('I-1. deviceId 一致時の deviceMismatch=0', () => {
    it('samples[].deviceId がトークンのデバイス ID と一致する場合 deviceMismatch は 0', async () => {
      // Arrange
      const deviceId = await makeDevice();
      const { plaintext: token } = await createToken(app, ADMIN_KEY, deviceId);
      // Provide the correct deviceId in the sample (matches token's device)
      const sample = makeSample({ deviceId });

      // Act
      const result = await ingest(app, token, [sample]);

      // Assert: mismatch branch is NOT taken → deviceMismatch stays 0
      expect(result.deviceMismatch).toBe(0);
      expect(result.inserted).toBe(1);
      expect(result.received).toBe(1);
      expect(result.duplicates).toBe(0);
      expect(result.dropped).toBe(0);
      expect(result.received).toBe(result.inserted + result.duplicates + result.dropped);
    });
  });

  describe('I-2. schemaVersion !== 1 → received: 0', () => {
    it('schemaVersion が 1 以外の場合は 200 + received: 0 を返す', async () => {
      // Arrange
      const deviceId = await makeDevice();
      const { plaintext: token } = await createToken(app, ADMIN_KEY, deviceId);

      // Act — send an unknown schema version
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: { schemaVersion: 2, samples: [makeSample()] },
      });

      // Assert: accepted-and-dropped envelope (EMPTY_ENVELOPE)
      expect(res.statusCode).toBe(200);
      const body = res.json<IngestResponse>();
      expect(body.received).toBe(0);
      expect(body.inserted).toBe(0);
      expect(body.duplicates).toBe(0);
      expect(body.dropped).toBe(0);
      expect(body.deviceMismatch).toBe(0);
      expect(body.schemaVersion).toBe(1); // EMPTY_ENVELOPE always returns schemaVersion: 1
    });
  });

  describe('I-3. 1000 件超 → 413', () => {
    it('samples が 1001 件の場合は 413 を返す', async () => {
      // Arrange
      const deviceId = await makeDevice();
      const { plaintext: token } = await createToken(app, ADMIN_KEY, deviceId);
      // Generate 1001 samples — just over MAX_SAMPLES (1000)
      const samples = Array.from({ length: 1001 }, () => makeSample());

      // Act
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: { schemaVersion: 1, samples },
      });

      // Assert: 413 PAYLOAD_TOO_LARGE before any DB writes
      expect(res.statusCode).toBe(413);
    });
  });
});
