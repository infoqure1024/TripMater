import Fastify, { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { AppConfig } from './config';
import { reqSerializer, loggerPlugin } from './plugins/logger';
import { makeDevicePreHandler, makeAdminPreHandler } from './plugins/auth';
import { registerErrorHandler } from './plugins/errorHandler';
import { registerOverloadGuard } from './plugins/overloadGuard';
import { healthzRoute } from './routes/healthz';
import { locationsRoute } from './routes/locations';
import { adminRoute } from './routes/admin';
import './types/fastify-augment';

// 1 MB global body limit aligns with the per-route limit in locations.ts (§7).
const GLOBAL_BODY_LIMIT = 1 * 1024 * 1024;

interface AppOverrides {
  pool?: Pool;
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

  fastify.decorate('db', pool);
  fastify.decorateRequest('deviceId', '');
  fastify.decorate('authenticateDevice', makeDevicePreHandler(pool));
  fastify.decorate('authenticateAdmin', makeAdminPreHandler(config.adminApiKey));

  fastify.addHook('onClose', async () => {
    await pool.end();
  });

  // Global cross-cutting concerns registered before routes.
  registerErrorHandler(fastify);
  registerOverloadGuard(fastify, config.maxInflightRequests);

  void fastify.register(loggerPlugin);
  void fastify.register(healthzRoute);
  void fastify.register(locationsRoute);
  void fastify.register(adminRoute);

  return fastify;
}
