import type { Pool } from 'pg';

// Module augmentation: extend Fastify's built-in interfaces with project-specific
// decorators so they are visible everywhere without casting.
declare module 'fastify' {
  interface FastifyInstance {
    db: Pool;
    authenticateDevice(
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply
    ): Promise<void>;
    authenticateAdmin(
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply
    ): Promise<void>;
  }
  interface FastifyRequest {
    deviceId: string;
  }
}

export {};
