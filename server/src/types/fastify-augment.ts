import type { Pool } from 'pg';
import type { FastifyReply } from 'fastify';

// Module augmentation: extend Fastify's built-in interfaces with project-specific
// decorators so they are visible everywhere without casting.
declare module 'fastify' {
  interface FastifyInstance {
    db: Pool;
    authenticateDevice(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    authenticateAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    authenticateQuery(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
  interface FastifyRequest {
    deviceId: string;
    isAdmin: boolean;
  }
}

export {};
