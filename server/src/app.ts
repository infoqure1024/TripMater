import Fastify, { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { AppConfig } from './config';
import { reqSerializer, loggerPlugin } from './plugins/logger';
import { makeDevicePreHandler, makeAdminPreHandler, makeQueryPreHandler } from './plugins/auth';
import { registerErrorHandler } from './plugins/errorHandler';
import { registerOverloadGuard } from './plugins/overloadGuard';
import { healthzRoute } from './routes/healthz';
import { locationsRoute } from './routes/locations';
import { adminRoute } from './routes/admin';
import { queryRoute } from './routes/query';
import { metricsRoute } from './routes/metrics';
import { MetricsStore } from './core/metrics';
import { PoisonPillDetector } from './core/poisonPill';
import './types/fastify-augment';

// 1 MB global body limit aligns with the per-route limit in locations.ts (§7).
const GLOBAL_BODY_LIMIT = 1 * 1024 * 1024;

// Prune stale poison-pill ID entries every 5 minutes.
const POISON_PILL_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

interface AppOverrides {
  pool?: Pool;
  metricsStore?: MetricsStore;
  poisonPillDetector?: PoisonPillDetector;
}

export function buildApp(config: AppConfig, overrides?: AppOverrides): FastifyInstance {
  const fastify = Fastify({
    logger: {
      level: config.logLevel,
      serializers: {
        req: reqSerializer,
      },
    },
    bodyLimit: GLOBAL_BODY_LIMIT,
    requestTimeout: config.requestTimeoutMs,
  });

  const pool = overrides?.pool ?? new Pool({ connectionString: config.databaseUrl });
  const metricsStore = overrides?.metricsStore ?? new MetricsStore();
  const detector = overrides?.poisonPillDetector ?? new PoisonPillDetector();

  fastify.decorate('db', pool);
  fastify.decorate('metrics', metricsStore);
  fastify.decorate('poisonPillDetector', detector);
  fastify.decorateRequest('deviceId', '');
  fastify.decorateRequest('isAdmin', false);
  fastify.decorate('authenticateDevice', makeDevicePreHandler(pool));
  fastify.decorate('authenticateAdmin', makeAdminPreHandler(config.adminApiKey));
  fastify.decorate('authenticateQuery', makeQueryPreHandler(pool, config.adminApiKey));

  // Periodically prune stale poison-pill ID entries to bound memory usage.
  const pruneInterval = setInterval(() => {
    detector.prune();
  }, POISON_PILL_PRUNE_INTERVAL_MS);

  fastify.addHook('onClose', async () => {
    clearInterval(pruneInterval);
    await pool.end();
  });

  // Track 4xx / 5xx response counts for the metrics snapshot.
  fastify.addHook('onResponse', (_req, reply, done) => {
    const status = reply.statusCode;
    if (status >= 400 && status < 500) {
      metricsStore.recordError4xx();
    } else if (status >= 500) {
      metricsStore.recordError5xx();
    }
    done();
  });

  // Global cross-cutting concerns registered before routes.
  registerErrorHandler(fastify);
  registerOverloadGuard(fastify, config.maxInflightRequests);

  void fastify.register(loggerPlugin);
  void fastify.register(healthzRoute);
  void fastify.register(locationsRoute);
  void fastify.register(adminRoute);
  void fastify.register(queryRoute);
  void fastify.register(metricsRoute);

  return fastify;
}
