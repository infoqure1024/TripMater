import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';

interface TokenRow {
  id: string;
  prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

function generateToken(): { plaintext: string; hash: Buffer; prefix: string } {
  const raw = crypto.randomBytes(32);
  const b64url = raw.toString('base64url');
  const plaintext = `tok_${b64url}`;
  const hash = crypto.createHash('sha256').update(plaintext, 'utf8').digest();
  const prefix = `tok_${b64url.slice(0, 4)}`;
  return { plaintext, hash, prefix };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23503';
}

export async function adminRoute(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', (req, reply) => fastify.authenticateAdmin(req, reply));

  // POST /api/v1/admin/devices — register a device, optionally issue a token
  fastify.post<{ Body: unknown }>('/api/v1/admin/devices', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const rawDeviceId = body['deviceId'];
    if (typeof rawDeviceId !== 'string' || rawDeviceId.trim() === '') {
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: 'deviceId is required' } });
    }
    const deviceId = rawDeviceId.trim();

    const name = typeof body['name'] === 'string' ? body['name'] : null;
    const metadata =
      typeof body['metadata'] === 'object' && body['metadata'] !== null ? body['metadata'] : {};
    const issueToken = body['issueToken'] === true;

    let client: import('pg').PoolClient | undefined;
    try {
      client = await fastify.db.connect();
      await client.query('BEGIN');

      try {
        await client.query('INSERT INTO devices (id, name, metadata) VALUES ($1, $2, $3)', [
          deviceId,
          name,
          JSON.stringify(metadata),
        ]);
      } catch (err) {
        if (isUniqueViolation(err)) {
          await client.query('ROLLBACK');
          client.release();
          client = undefined;
          return reply
            .code(409)
            .send({ error: { code: 'CONFLICT', message: 'Device already exists' } });
        }
        throw err;
      }

      if (!issueToken) {
        await client.query('COMMIT');
        return reply.code(201).send({ deviceId });
      }

      const tokenId = crypto.randomUUID();
      const { plaintext, hash, prefix } = generateToken();
      await client.query(
        'INSERT INTO api_tokens (id, device_id, token_hash, prefix) VALUES ($1, $2, $3, $4)',
        [tokenId, deviceId, hash, prefix]
      );
      await client.query('COMMIT');

      return reply.code(201).send({ deviceId, tokenId, token: plaintext, expiresAt: null });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      req.log.error({ err }, 'DB error in POST /admin/devices');
      return reply.code(503).send({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
      });
    } finally {
      if (client) client.release();
    }
  });

  // POST /api/v1/admin/devices/:deviceId/tokens — issue / rotate a token
  fastify.post<{ Params: { deviceId: string }; Body: unknown }>(
    '/api/v1/admin/devices/:deviceId/tokens',
    async (req, reply) => {
      const { deviceId } = req.params;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const expiresAt = typeof body['expiresAt'] === 'string' ? body['expiresAt'] : null;

      if (expiresAt !== null && isNaN(Date.parse(expiresAt))) {
        return reply
          .code(400)
          .send({ error: { code: 'BAD_REQUEST', message: 'invalid expiresAt format' } });
      }

      try {
        const deviceResult = await fastify.db.query('SELECT id FROM devices WHERE id = $1', [
          deviceId,
        ]);
        if (deviceResult.rows.length === 0) {
          return reply
            .code(404)
            .send({ error: { code: 'NOT_FOUND', message: 'Device not found' } });
        }

        const tokenId = crypto.randomUUID();
        const { plaintext, hash, prefix } = generateToken();
        await fastify.db.query(
          'INSERT INTO api_tokens (id, device_id, token_hash, prefix, expires_at) VALUES ($1, $2, $3, $4, $5)',
          [tokenId, deviceId, hash, prefix, expiresAt]
        );

        return reply.code(201).send({ deviceId, tokenId, token: plaintext, expiresAt });
      } catch (err) {
        // Race condition: device deleted between SELECT and INSERT → FK violation → 404
        if (isForeignKeyViolation(err)) {
          return reply
            .code(404)
            .send({ error: { code: 'NOT_FOUND', message: 'Device not found' } });
        }
        req.log.error({ err }, 'DB error in POST /admin/devices/:deviceId/tokens');
        return reply.code(503).send({
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
        });
      }
    }
  );

  // GET /api/v1/admin/devices/:deviceId/tokens — list token metadata (no plaintext)
  fastify.get<{ Params: { deviceId: string } }>(
    '/api/v1/admin/devices/:deviceId/tokens',
    async (req, reply) => {
      const { deviceId } = req.params;

      try {
        const deviceResult = await fastify.db.query('SELECT id FROM devices WHERE id = $1', [
          deviceId,
        ]);
        if (deviceResult.rows.length === 0) {
          return reply
            .code(404)
            .send({ error: { code: 'NOT_FOUND', message: 'Device not found' } });
        }

        const result = await fastify.db.query<TokenRow>(
          `SELECT id, prefix, created_at, last_used_at, expires_at, revoked_at
           FROM api_tokens
           WHERE device_id = $1
           ORDER BY created_at DESC`,
          [deviceId]
        );

        const tokens = result.rows.map((row) => ({
          tokenId: row.id,
          prefix: row.prefix,
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
          expiresAt: row.expires_at,
          revokedAt: row.revoked_at,
        }));

        return reply.code(200).send({ tokens });
      } catch (err) {
        req.log.error({ err }, 'DB error in GET /admin/devices/:deviceId/tokens');
        return reply.code(503).send({
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
        });
      }
    }
  );

  // DELETE /api/v1/admin/devices/:deviceId/tokens/:tokenId — revoke a token
  fastify.delete<{ Params: { deviceId: string; tokenId: string } }>(
    '/api/v1/admin/devices/:deviceId/tokens/:tokenId',
    async (req, reply) => {
      const { deviceId, tokenId } = req.params;

      try {
        // COALESCE preserves the original revoked_at if already revoked (idempotent).
        // Scoping by device_id prevents IDOR: wrong device → 404 (existence not leaked).
        const result = await fastify.db.query<{ revoked_at: Date }>(
          `UPDATE api_tokens
           SET revoked_at = COALESCE(revoked_at, now())
           WHERE id = $1 AND device_id = $2
           RETURNING revoked_at`,
          [tokenId, deviceId]
        );

        if (result.rows.length === 0) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Token not found' } });
        }

        return reply.code(200).send({ tokenId, revokedAt: result.rows[0].revoked_at });
      } catch (err) {
        req.log.error({ err }, 'DB error in DELETE /admin/devices/:deviceId/tokens/:tokenId');
        return reply.code(503).send({
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
        });
      }
    }
  );
}
