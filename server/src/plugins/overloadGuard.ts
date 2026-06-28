import type { FastifyInstance } from 'fastify';

const RETRY_AFTER_SECONDS = 5;

/**
 * Rejects incoming requests with 503 + Retry-After when the number of
 * concurrently active requests exceeds maxInflight.
 * Uses a Set keyed by request ID so the onResponse decrement is always safe
 * (no-op for early-rejected requests that never incremented the count).
 */
export function registerOverloadGuard(fastify: FastifyInstance, maxInflight: number): void {
  const inflightIds = new Set<string>();

  fastify.addHook('onRequest', async (req, reply) => {
    if (inflightIds.size >= maxInflight) {
      req.log.warn(
        { inflight: inflightIds.size, maxInflight },
        'overload guard: rejecting request with 503'
      );
      reply.header('Retry-After', String(RETRY_AFTER_SECONDS));
      return reply.code(503).send({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Server is overloaded, please retry later',
        },
      });
    }
    inflightIds.add(req.id);
  });

  // onResponse fires for all requests, including early 503s from this hook.
  // inflightIds.delete is a no-op for IDs that were never added, so rejected
  // requests are handled correctly without a separate counter flag.
  fastify.addHook('onResponse', async (req) => {
    inflightIds.delete(req.id);
  });
}
