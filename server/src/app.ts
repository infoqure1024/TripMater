import Fastify, { FastifyInstance } from 'fastify';
import { AppConfig } from './config';
import { reqSerializer, loggerPlugin } from './plugins/logger';
import { dbPlugin } from './plugins/db';
import { authPlugin } from './plugins/auth';
import { healthzRoute } from './routes/healthz';

export function buildApp(config: AppConfig): FastifyInstance {
  const fastify = Fastify({
    logger: {
      level: config.logLevel,
      serializers: {
        req: reqSerializer,
      },
    },
  });

  void fastify.register(loggerPlugin);
  void fastify.register(dbPlugin, { databaseUrl: config.databaseUrl });
  void fastify.register(authPlugin, { adminApiKey: config.adminApiKey });
  void fastify.register(healthzRoute);

  return fastify;
}
