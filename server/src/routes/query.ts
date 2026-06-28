import type { FastifyInstance } from 'fastify';

const MAX_LIMIT_SESSIONS = 100;
const DEFAULT_LIMIT_SESSIONS = 20;
const MAX_LIMIT_SAMPLES = 1000;
const DEFAULT_LIMIT_SAMPLES = 100;

function parsePageParams(
  query: Record<string, unknown>,
  defaultLimit: number,
  maxLimit: number
): { limit: number; offset: number } | null {
  const rawLimit = query['limit'];
  const rawOffset = query['offset'];

  const limit = rawLimit === undefined ? defaultLimit : Number(rawLimit);
  const offset = rawOffset === undefined ? 0 : Number(rawOffset);

  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) return null;
  if (!Number.isInteger(offset) || offset < 0) return null;

  return { limit, offset };
}

export async function queryRoute(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', (req, reply) => fastify.authenticateQuery(req, reply));

  // GET /api/v1/devices/:deviceId/sessions
  // Returns paginated session summaries for a device.
  // Device token: only own device (path.deviceId == token.device). Admin: any device.
  fastify.get<{ Params: { deviceId: string }; Querystring: Record<string, unknown> }>(
    '/api/v1/devices/:deviceId/sessions',
    async (req, reply) => {
      const { deviceId } = req.params;

      // IDOR check for device tokens (§4)
      if (!req.isAdmin && req.deviceId !== deviceId) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      }

      const page = parsePageParams(req.query, DEFAULT_LIMIT_SESSIONS, MAX_LIMIT_SESSIONS);
      if (page === null) {
        return reply.code(400).send({
          error: { code: 'BAD_REQUEST', message: 'Invalid limit or offset parameter' },
        });
      }

      try {
        const [rowsResult, countResult] = await Promise.all([
          fastify.db.query<{
            session_id: string;
            device_id: string;
            sample_count: string;
            total_distance_m: string;
            started_at: Date;
            ended_at: Date;
          }>(
            `SELECT
               session_id,
               device_id,
               COUNT(*)                              AS sample_count,
               COALESCE(SUM(distance_delta_m), 0)   AS total_distance_m,
               MIN(recorded_at)                      AS started_at,
               MAX(recorded_at)                      AS ended_at
             FROM location_samples
             WHERE device_id = $1
               AND session_id IS NOT NULL
             GROUP BY session_id, device_id
             ORDER BY MIN(recorded_at) DESC
             LIMIT $2 OFFSET $3`,
            [deviceId, page.limit, page.offset]
          ),
          fastify.db.query<{ total: string }>(
            `SELECT COUNT(DISTINCT session_id) AS total
             FROM location_samples
             WHERE device_id = $1
               AND session_id IS NOT NULL`,
            [deviceId]
          ),
        ]);

        const sessions = rowsResult.rows.map((row) => ({
          sessionId: row.session_id,
          deviceId: row.device_id,
          sampleCount: Number(row.sample_count),
          totalDistanceM: Number(row.total_distance_m),
          startedAt: row.started_at,
          endedAt: row.ended_at,
        }));

        return reply.code(200).send({
          sessions,
          total: Number(countResult.rows[0]?.total ?? 0),
        });
      } catch (err) {
        req.log.error({ err }, 'DB error in GET /devices/:deviceId/sessions');
        return reply.code(503).send({
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
        });
      }
    }
  );

  // GET /api/v1/sessions/:sessionId/summary
  // Returns aggregated summary for one session.
  // Device token: session must belong to own device (IDOR → 404). Admin: any session.
  fastify.get<{ Params: { sessionId: string } }>(
    '/api/v1/sessions/:sessionId/summary',
    async (req, reply) => {
      const { sessionId } = req.params;

      try {
        // For device token, add device_id predicate so a mismatch returns 0 rows → 404.
        // Admin skips this predicate and can access any session.
        const result = await fastify.db.query<{
          session_id: string;
          device_id: string;
          sample_count: string;
          total_distance_m: string;
          started_at: Date;
          ended_at: Date;
        }>(
          req.isAdmin
            ? `SELECT
                 session_id,
                 device_id,
                 COUNT(*)                              AS sample_count,
                 COALESCE(SUM(distance_delta_m), 0)   AS total_distance_m,
                 MIN(recorded_at)                      AS started_at,
                 MAX(recorded_at)                      AS ended_at
               FROM location_samples
               WHERE session_id = $1
               GROUP BY session_id, device_id`
            : `SELECT
                 session_id,
                 device_id,
                 COUNT(*)                              AS sample_count,
                 COALESCE(SUM(distance_delta_m), 0)   AS total_distance_m,
                 MIN(recorded_at)                      AS started_at,
                 MAX(recorded_at)                      AS ended_at
               FROM location_samples
               WHERE session_id = $1
                 AND device_id = $2
               GROUP BY session_id, device_id`,
          req.isAdmin ? [sessionId] : [sessionId, req.deviceId]
        );

        if (result.rows.length === 0) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
        }

        const row = result.rows[0];
        return reply.code(200).send({
          sessionId: row.session_id,
          deviceId: row.device_id,
          sampleCount: Number(row.sample_count),
          totalDistanceM: Number(row.total_distance_m),
          startedAt: row.started_at,
          endedAt: row.ended_at,
        });
      } catch (err) {
        req.log.error({ err }, 'DB error in GET /sessions/:sessionId/summary');
        return reply.code(503).send({
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
        });
      }
    }
  );

  // GET /api/v1/sessions/:sessionId/samples
  // Returns paginated raw samples for a session.
  // Device token: session must belong to own device (IDOR → 404). Admin: any session.
  fastify.get<{ Params: { sessionId: string }; Querystring: Record<string, unknown> }>(
    '/api/v1/sessions/:sessionId/samples',
    async (req, reply) => {
      const { sessionId } = req.params;

      const page = parsePageParams(req.query, DEFAULT_LIMIT_SAMPLES, MAX_LIMIT_SAMPLES);
      if (page === null) {
        return reply.code(400).send({
          error: { code: 'BAD_REQUEST', message: 'Invalid limit or offset parameter' },
        });
      }

      try {
        // Ownership check for device tokens: first verify the session belongs to this device.
        // Combining into one query keeps the round-trip count at 1.
        if (!req.isAdmin) {
          const ownerCheck = await fastify.db.query<{ device_id: string }>(
            `SELECT device_id FROM location_samples
             WHERE session_id = $1 AND device_id = $2
             LIMIT 1`,
            [sessionId, req.deviceId]
          );
          if (ownerCheck.rows.length === 0) {
            return reply
              .code(404)
              .send({ error: { code: 'NOT_FOUND', message: 'Session not found' } });
          }
        }

        const [samplesResult, countResult] = await Promise.all([
          fastify.db.query<{
            id: string;
            device_id: string;
            session_id: string;
            recorded_at: Date;
            lat: number;
            lng: number;
            speed_mps: number;
            raw_speed_mps: number | null;
            accuracy_m: number;
            heading_deg: number | null;
            altitude_m: number | null;
            distance_delta_m: number | null;
            ingested_at: Date;
          }>(
            `SELECT
               id, device_id, session_id, recorded_at,
               lat, lng, speed_mps, raw_speed_mps, accuracy_m,
               heading_deg, altitude_m, distance_delta_m, ingested_at
             FROM location_samples
             WHERE session_id = $1
             ORDER BY recorded_at ASC
             LIMIT $2 OFFSET $3`,
            [sessionId, page.limit, page.offset]
          ),
          fastify.db.query<{ total: string }>(
            `SELECT COUNT(*) AS total FROM location_samples WHERE session_id = $1`,
            [sessionId]
          ),
        ]);

        const samples = samplesResult.rows.map((row) => ({
          id: row.id,
          deviceId: row.device_id,
          sessionId: row.session_id,
          recordedAt: row.recorded_at,
          lat: row.lat,
          lng: row.lng,
          speedMps: row.speed_mps,
          rawSpeedMps: row.raw_speed_mps,
          accuracyM: row.accuracy_m,
          headingDeg: row.heading_deg,
          altitudeM: row.altitude_m,
          distanceDeltaM: row.distance_delta_m,
          ingestedAt: row.ingested_at,
        }));

        return reply.code(200).send({
          samples,
          total: Number(countResult.rows[0]?.total ?? 0),
        });
      } catch (err) {
        req.log.error({ err }, 'DB error in GET /sessions/:sessionId/samples');
        return reply.code(503).send({
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
        });
      }
    }
  );
}
