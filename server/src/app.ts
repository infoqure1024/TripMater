import Fastify, { FastifyInstance } from 'fastify';
import { AppConfig } from './config';
import { reqSerializer, loggerPlugin } from './plugins/logger';
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
  void fastify.register(healthzRoute);

  return fastify;
}
