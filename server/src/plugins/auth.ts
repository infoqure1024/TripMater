import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { createHash } from 'crypto';
import { Pool } from 'pg';

// How long (ms) to defer last_used_at updates per token to avoid thundering-herd writes.
const LAST_USED_DEBOUNCE_MS = 60_000;

// Per-process debounce map: tokenId → timeout handle.
const lastUsedPending = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleLastUsedUpdate(pool: Pool, tokenId: string): void {
  if (lastUsedPending.has(tokenId)) return;
  const handle = setTimeout(() => {
    lastUsedPending.delete(tokenId);
    pool
      .query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [tokenId])
      .catch(() => {
        // Non-critical — tolerate failures silently.
      });
  }, LAST_USED_DEBOUNCE_MS);
  // Allow Node to exit even with pending timers.
  handle.unref();
  lastUsedPending.set(tokenId, handle);
}

export interface AuthenticatedDevice {
  deviceId: string;
  tokenId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by verifyDeviceToken preHandler. */
    device?: AuthenticatedDevice;
    /** True when request passed admin key auth. */
    isAdmin?: boolean;
  }
}

function hashToken(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}

/**
 * Extracts the raw token from "Authorization: Bearer <token>".
 * Returns null if the header is missing or malformed.
 */
function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers['authorization'];
  if (typeof header !== 'string') return null;
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer' || !parts[1]) {
    return null;
  }
  return parts[1];
}

/**
 * Fastify preHandler: validates the Bearer device token.
 *
 * On success, populates request.device with { deviceId, tokenId }.
 * Returns 401 for invalid/expired/revoked tokens, 403 for disabled devices.
 */
export async function verifyDeviceToken(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const raw = extractBearerToken(request);
  if (!raw) {
    return reply
      .status(401)
      .send({ error: { code: 'MISSING_TOKEN', message: 'Bearer token required' } });
  }

  const pool: Pool = (request.server as FastifyInstance & { db: Pool }).db;
  const tokenHash = hashToken(raw);

  const result = await pool.query<{
    id: string;
    device_id: string;
    revoked_at: Date | null;
    expires_at: Date | null;
    disabled_at: Date | null;
  }>(
    `SELECT t.id, t.device_id, t.revoked_at, t.expires_at, d.disabled_at
     FROM api_tokens t
     JOIN devices d ON d.id = t.device_id
     WHERE t.token_hash = $1`,
    [tokenHash]
  );

  if (result.rowCount === 0) {
    return reply
      .status(401)
      .send({ error: { code: 'INVALID_TOKEN', message: 'Token not found' } });
  }

  const row = result.rows[0];
  const now = new Date();

  // R1: token validity
  const isRevoked = row.revoked_at !== null;
  const isExpired = row.expires_at !== null && row.expires_at <= now;
  if (isRevoked || isExpired) {
    return reply
      .status(401)
      .send({ error: { code: 'TOKEN_EXPIRED', message: 'Token is revoked or expired' } });
  }

  // R1: device active
  if (row.disabled_at !== null) {
    return reply
      .status(403)
      .send({ error: { code: 'DEVICE_DISABLED', message: 'Device is disabled' } });
  }

  request.device = { deviceId: row.device_id, tokenId: row.id };

  // Non-blocking last_used_at update (debounced).
  scheduleLastUsedUpdate(pool, row.id);
}

/**
 * Fastify preHandler: validates the X-Admin-Key header.
 *
 * Returns 401 if the key is missing or wrong.
 */
export function makeVerifyAdminKey(
  adminApiKey: string
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const key = request.headers['x-admin-key'];
    if (key !== adminApiKey) {
      return reply
        .status(401)
        .send({ error: { code: 'INVALID_ADMIN_KEY', message: 'Invalid or missing X-Admin-Key' } });
    }
    request.isAdmin = true;
  };
}

/**
 * Plugin that wires verifyDeviceToken and makeVerifyAdminKey onto the Fastify
 * instance as decorators so routes can reference them by name.
 *
 * Wrapped with fastify-plugin so the decorators escape the plugin's child scope
 * and are visible to sibling plugins and the parent instance.
 */
export const authPlugin = fp(
  async function authPlugin(
    fastify: FastifyInstance,
    opts: { adminApiKey: string }
  ): Promise<void> {
    fastify.decorate('verifyDeviceToken', verifyDeviceToken);
    fastify.decorate('verifyAdminKey', makeVerifyAdminKey(opts.adminApiKey));
  },
  { name: 'auth' }
);

declare module 'fastify' {
  interface FastifyInstance {
    verifyDeviceToken: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    verifyAdminKey: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
