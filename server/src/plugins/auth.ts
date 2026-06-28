import crypto from 'crypto';
import type { Pool } from 'pg';
import type { FastifyRequest, FastifyReply } from 'fastify';

interface TokenRow {
  token_id: string;
  device_id: string;
  revoked_at: Date | null;
  expires_at: Date | null;
  disabled_at: Date | null;
}

// Per-token timestamp of last last_used_at write. Module-level so it persists
// across requests for the lifetime of the process.
const lastUsedCache = new Map<string, number>();
const LAST_USED_DEBOUNCE_MS = 60_000;

function hashToken(raw: string): Buffer {
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function scheduleLastUsedUpdate(pool: Pool, tokenId: string): void {
  const now = Date.now();
  const last = lastUsedCache.get(tokenId);
  if (last !== undefined && now - last < LAST_USED_DEBOUNCE_MS) {
    return;
  }
  lastUsedCache.set(tokenId, now);
  // Fire-and-forget — auth path must not block on this write.
  pool.query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [tokenId]).catch(() => {
    // Best-effort; failures are non-fatal and not worth logging at error level.
  });
}

export function makeDevicePreHandler(
  pool: Pool
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing or malformed Authorization header' });
    }

    const rawToken = authHeader.slice('Bearer '.length);
    const tokenHash = hashToken(rawToken);

    let row: TokenRow;
    try {
      const result = await pool.query<TokenRow>(
        `SELECT
           t.id        AS token_id,
           t.device_id,
           t.revoked_at,
           t.expires_at,
           d.disabled_at
         FROM api_tokens t
         JOIN devices d ON d.id = t.device_id
         WHERE t.token_hash = $1`,
        [tokenHash]
      );

      if (result.rows.length === 0) {
        return reply.code(401).send({ error: 'Invalid token' });
      }
      row = result.rows[0];
    } catch {
      req.log.error('DB error during token lookup');
      return reply.code(503).send({ error: 'Service temporarily unavailable' });
    }

    if (row.revoked_at !== null) {
      return reply.code(401).send({ error: 'Token revoked' });
    }

    if (row.expires_at !== null && row.expires_at <= new Date()) {
      return reply.code(401).send({ error: 'Token expired' });
    }

    if (row.disabled_at !== null) {
      return reply.code(403).send({ error: 'Device disabled' });
    }

    req.log.debug({ tokenId: row.token_id }, 'token validated');

    // R2: inject server-derived device_id — never trust sample.deviceId from the payload.
    req.deviceId = row.device_id;

    scheduleLastUsedUpdate(pool, row.token_id);
  };
}

export function makeAdminPreHandler(
  adminApiKey: string
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const key = req.headers['x-admin-key'];
    if (!key || key !== adminApiKey) {
      return reply.code(401).send({ error: 'Invalid or missing X-Admin-Key' });
    }
  };
}
