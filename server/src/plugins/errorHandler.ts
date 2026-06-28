import type { FastifyInstance, FastifyError } from 'fastify';

const HTTP_CODE_TO_ERROR_CODE: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  500: 'INTERNAL_SERVER_ERROR',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

const RETRY_AFTER_SECONDS = 5;

export function registerErrorHandler(fastify: FastifyInstance): void {
  // Inject Retry-After on every 503 response, regardless of origin.
  fastify.addHook('onSend', async (_req, reply, payload) => {
    if (reply.statusCode === 503 && !reply.hasHeader('Retry-After')) {
      reply.header('Retry-After', String(RETRY_AFTER_SECONDS));
    }
    return payload;
  });

  // Global error handler: formats all uncaught errors as {error:{code,message}}.
  // Scoped handlers (e.g. locationsRoute) run first; thrown errors bubble here.
  fastify.setErrorHandler(async (err: FastifyError, req, reply) => {
    const statusCode = err.statusCode ?? 500;
    const code = HTTP_CODE_TO_ERROR_CODE[statusCode] ?? 'INTERNAL_SERVER_ERROR';

    if (statusCode >= 500) {
      req.log.error({ err }, 'unhandled server error');
    } else {
      req.log.warn({ err, statusCode }, 'request error');
    }

    return reply.code(statusCode).send({
      error: { code, message: err.message },
    });
  });
}
