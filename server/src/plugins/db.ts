import { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Pool } from 'pg';

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool;
  }
}

export const dbPlugin = fp(async function dbPlugin(
  fastify: FastifyInstance,
  opts: { databaseUrl: string }
): Promise<void> {
  const pool = new Pool({ connectionString: opts.databaseUrl });

  fastify.decorate('db', pool);

  fastify.addHook('onClose', async () => {
    await pool.end();
  });
}, { name: 'db' });
