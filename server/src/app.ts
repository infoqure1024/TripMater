import Fastify, { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { AppConfig } from './config';
import { reqSerializer, loggerPlugin } from './plugins/logger';
import { makeDevicePreHandler, makeAdminPreHandler } from './plugins/auth';
import { healthzRoute } from './routes/healthz';
import { locationsRoute } from './routes/locations';
import './types/fastify-augment';

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
  });

  const pool = overrides?.pool ?? new Pool({ connectionString: config.databaseUrl });

  fastify.decorate('db', pool);
  fastify.decorateRequest('deviceId', '');
  fastify.decorate('authenticateDevice', makeDevicePreHandler(pool));
  fastify.decorate('authenticateAdmin', makeAdminPreHandler(config.adminApiKey));

  fastify.addHook('onClose', async () => {
    await pool.end();
  });

  void fastify.register(loggerPlugin);
  void fastify.register(healthzRoute);
  void fastify.register(locationsRoute);

  return fastify;
}
