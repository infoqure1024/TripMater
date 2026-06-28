import type { FastifyInstance } from 'fastify';

/**
 * GET /metrics — returns a JSON snapshot of server-wide ingest counters.
 *
 * Requires X-Admin-Key authentication (same credential as the admin routes).
 * This endpoint is intentionally separate from /api/v1/admin/* so that
 * monitoring infrastructure can scrape it without being aware of the admin
 * device-management API surface.
 *
 * Response shape: MetricsSnapshot (see src/core/metrics.ts).
 */
export async function metricsRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/metrics',
    {
      preHandler: [(req, reply) => fastify.authenticateAdmin(req, reply)],
    },
    async (_req, reply) => {
      const snap = fastify.metrics.snapshot();
      return reply.code(200).send(snap);
    }
  );
}
