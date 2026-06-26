import { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

const HealthzResponse = Type.Object({
  status: Type.Literal('ok'),
  timestamp: Type.String({ format: 'date-time' }),
});

export async function healthzRoute(fastify: FastifyInstance): Promise<void> {
  const server = fastify.withTypeProvider<TypeBoxTypeProvider>();

  server.get(
    '/healthz',
    {
      schema: {
        response: {
          200: HealthzResponse,
        },
      },
    },
    async (_request, _reply) => {
      return {
        status: 'ok' as const,
        timestamp: new Date().toISOString(),
      };
    }
  );
}
