import { FastifyInstance } from 'fastify';

const TOKEN_PATTERN = /tok_[A-Za-z0-9_-]+/g;

function maskTokens(value: string): string {
  return value.replace(TOKEN_PATTERN, '[REDACTED]');
}

// Exported for unit testing (log hygiene gate — §7).
export function maskObject(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return maskTokens(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(maskObject);
  }
  if (obj !== null && typeof obj === 'object') {
    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (key === 'lat' || key === 'lng') {
        masked[key] = '[REDACTED]';
      } else {
        masked[key] = maskObject(value);
      }
    }
    return masked;
  }
  return obj;
}

// pino serializer for request objects — masks Authorization header.
// Note: body is NOT included here because pino's req serializer runs before
// Fastify parses the body, so req.body is always undefined at this point.
// Request body PII masking is handled in the ingest route handler (future Issue).
export function reqSerializer(req: {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
  remotePort?: number;
}) {
  const headers: Record<string, string | string[] | undefined> = {};
  if (req.headers) {
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() === 'authorization') {
        // Preserve the Bearer scheme but redact the token value
        headers[key] = 'Bearer [REDACTED]';
      } else {
        headers[key] = value;
      }
    }
  }

  return {
    method: req.method,
    url: req.url,
    headers,
    remoteAddress: req.remoteAddress,
    remotePort: req.remotePort,
  };
}

export async function loggerPlugin(fastify: FastifyInstance): Promise<void> {
  // Log the response body at DEBUG level with PII masking applied.
  // The reqSerializer above covers request headers; this hook covers response bodies.
  fastify.addHook('onSend', async (request, _reply, payload) => {
    if (typeof payload === 'string') {
      try {
        const parsed: unknown = JSON.parse(payload);
        request.log.debug({ body: maskObject(parsed) }, 'response body');
      } catch {
        // Non-JSON response — nothing to mask
      }
    }
    return payload;
  });
}
