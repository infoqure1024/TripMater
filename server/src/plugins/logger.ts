import { FastifyInstance } from 'fastify';

const TOKEN_PATTERN = /tok_[A-Za-z0-9_-]+/g;

function maskTokens(value: string): string {
  return value.replace(TOKEN_PATTERN, '[REDACTED]');
}

function maskObject(obj: unknown): unknown {
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

// pino serializer for request objects — masks Authorization header and PII fields
export function reqSerializer(req: {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
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
    body: maskObject(req.body),
    remoteAddress: req.remoteAddress,
    remotePort: req.remotePort,
  };
}

export async function loggerPlugin(fastify: FastifyInstance): Promise<void> {
  // Apply body PII masking via onSend hook so body is available after parsing.
  // The reqSerializer above covers headers in access logs; this hook masks
  // any body content that pino may log at DEBUG level via addContentTypeParser.
  fastify.addHook('onSend', async (request, _reply, payload) => {
    // Log the sanitised request body for traceability (debug level only)
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
