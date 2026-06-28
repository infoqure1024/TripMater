import type { FastifyInstance, FastifyError } from 'fastify';

interface ValidSample {
  id: string;
  deviceId: string | null;
  timestamp: number;
  lat: number;
  lng: number;
  speedMps: number;
  accuracyM: number;
  rawSpeedMps: number | null;
  headingDeg: number | null;
  altitudeM: number | null;
  sessionId: string | null;
  distanceDeltaM: number | null;
}

interface IngestResult {
  received: number;
  inserted: number;
  duplicates: number;
  dropped: number;
  deviceMismatch: number;
  schemaVersion: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SAMPLES = 1000;
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

// Per §3.3: required fields missing/unclampable → null (dropped).
// Optional fields out of range → clamp or null (inserted with sanitized value).
function validateSample(raw: unknown): ValidSample | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;

  const id = s['id'];
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;

  const timestamp = s['timestamp'];
  if (!isFiniteNum(timestamp)) return null;

  const lat = s['lat'];
  if (!isFiniteNum(lat)) return null;

  const lng = s['lng'];
  if (!isFiniteNum(lng)) return null;

  const speedMps = s['speedMps'];
  if (!isFiniteNum(speedMps) || speedMps < 0) return null;

  const accuracyM = s['accuracyM'];
  if (!isFiniteNum(accuracyM) || accuracyM < 0) return null;

  const rawSpeed = s['rawSpeedMps'];
  const heading = s['headingDeg'];
  const altitude = s['altitudeM'];
  const distanceDelta = s['distanceDeltaM'];
  const deviceId = s['deviceId'];
  const sessionId = s['sessionId'];

  return {
    id,
    deviceId: typeof deviceId === 'string' ? deviceId : null,
    timestamp,
    lat: Math.max(-90, Math.min(90, lat)),
    lng: Math.max(-180, Math.min(180, lng)),
    speedMps: Math.max(0, speedMps),
    accuracyM: Math.max(0, accuracyM),
    rawSpeedMps: isFiniteNum(rawSpeed) ? Math.max(0, rawSpeed) : null,
    headingDeg: isFiniteNum(heading) ? ((heading % 360) + 360) % 360 : null,
    altitudeM: isFiniteNum(altitude) ? altitude : null,
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    distanceDeltaM: isFiniteNum(distanceDelta) ? distanceDelta : null,
  };
}

const EMPTY_ENVELOPE: IngestResult = {
  received: 0,
  inserted: 0,
  duplicates: 0,
  dropped: 0,
  deviceMismatch: 0,
  schemaVersion: 1,
};

export async function locationsRoute(fastify: FastifyInstance): Promise<void> {
  // Scope: catch body-parse errors (invalid JSON → 400) and return 200 accept-and-drop
  // so the client queue advances rather than getting stuck (§2.3, §1.4).
  fastify.setErrorHandler(async (err: FastifyError, req, reply) => {
    if (err.statusCode === 400) {
      req.log.warn(
        { code: err.code },
        'envelope rejected (body parse error), returning received:0'
      );
      return reply.code(200).send(EMPTY_ENVELOPE);
    }
    // 413 (body size limit) and everything else: forward to parent handler.
    throw err;
  });

  fastify.post<{ Body: unknown }>(
    '/api/v1/locations',
    {
      bodyLimit: MAX_BODY_BYTES,
      preHandler: [(req, reply) => fastify.authenticateDevice(req, reply)],
    },
    async (req, reply) => {
      const deviceId = req.deviceId;
      const body = req.body;

      // ── Envelope validation (§2.3) ──────────────────────────────────────────
      if (typeof body !== 'object' || body === null) {
        req.log.warn('envelope rejected: body is not an object');
        return reply.code(200).send(EMPTY_ENVELOPE);
      }

      const env = body as Record<string, unknown>;
      const schemaVersion = env['schemaVersion'];

      // Accept only known version 1; unknown future versions get received:0.
      if (schemaVersion !== 1) {
        req.log.warn({ schemaVersion }, 'envelope rejected: unknown schemaVersion');
        return reply.code(200).send(EMPTY_ENVELOPE);
      }

      const samples = env['samples'];
      if (!Array.isArray(samples) || samples.length === 0) {
        req.log.warn('envelope rejected: samples must be a non-empty array');
        return reply.code(200).send({ ...EMPTY_ENVELOPE, schemaVersion: 1 });
      }

      // Size limit: 1000 samples (§7). 413 is safe here because client batchSize
      // must be kept below this threshold to prevent poison-pill (§3.4).
      if (samples.length > MAX_SAMPLES) {
        return reply.code(413).send({
          error: { code: 'PAYLOAD_TOO_LARGE', message: `samples must not exceed ${MAX_SAMPLES}` },
        });
      }

      // ── Per-sample classification (§3.3) ────────────────────────────────────
      const received = samples.length;
      let dropped = 0;
      let deviceMismatch = 0;
      const validSamples: ValidSample[] = [];

      for (const raw of samples) {
        const s = validateSample(raw);
        if (s === null) {
          dropped++;
          continue;
        }
        // R2: device_id comes from the token. Track mismatches as an independent
        // warning counter — do not exclude the sample (§3.1).
        if (s.deviceId !== null && s.deviceId !== deviceId) {
          deviceMismatch++;
          req.log.warn(
            { sampleDeviceId: s.deviceId, tokenDeviceId: deviceId },
            'deviceMismatch: sample.deviceId differs from token device'
          );
        }
        validSamples.push(s);
      }

      let inserted = 0;
      let duplicates = 0;

      // ── DB: 1 transaction, batch INSERT ON CONFLICT DO NOTHING (§3.3) ───────
      if (validSamples.length > 0) {
        let client: import('pg').PoolClient | undefined;
        try {
          client = await fastify.db.connect();
          await client.query('BEGIN');

          // Batch insert via unnest — single round-trip, O(n) params.
          const result = await client.query<{ id: string }>(
            `INSERT INTO location_samples
               (id, device_id, session_id, recorded_at, lat, lng,
                speed_mps, raw_speed_mps, accuracy_m, heading_deg, altitude_m, distance_delta_m)
             SELECT
               unnest($1::uuid[]),
               $2::text,
               unnest($3::text[]),
               to_timestamp(unnest($4::float8[]) / 1000.0),
               unnest($5::float8[]),
               unnest($6::float8[]),
               unnest($7::float4[]),
               unnest($8::float4[]),
               unnest($9::float4[]),
               unnest($10::float4[]),
               unnest($11::float4[]),
               unnest($12::float4[])
             ON CONFLICT (id) DO NOTHING
             RETURNING id`,
            [
              validSamples.map((s) => s.id),
              deviceId,
              validSamples.map((s) => s.sessionId),
              validSamples.map((s) => s.timestamp),
              validSamples.map((s) => s.lat),
              validSamples.map((s) => s.lng),
              validSamples.map((s) => s.speedMps),
              validSamples.map((s) => s.rawSpeedMps),
              validSamples.map((s) => s.accuracyM),
              validSamples.map((s) => s.headingDeg),
              validSamples.map((s) => s.altitudeM),
              validSamples.map((s) => s.distanceDeltaM),
            ]
          );

          // RETURNING id only contains newly inserted rows; conflicts are silently skipped.
          inserted = result.rowCount ?? 0;
          duplicates = validSamples.length - inserted;

          await client.query('COMMIT');
        } catch (err) {
          if (client) await client.query('ROLLBACK').catch(() => {}); // best-effort rollback
          req.log.error({ err }, 'DB error during location ingest');
          return reply.code(503).send({
            error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
          });
        } finally {
          if (client) client.release();
        }
      }

      // Invariant: received = inserted + duplicates + dropped (§3.2).
      const result: IngestResult = {
        received,
        inserted,
        duplicates,
        dropped,
        deviceMismatch,
        schemaVersion: 1,
      };
      return reply.code(200).send(result);
    }
  );
}
