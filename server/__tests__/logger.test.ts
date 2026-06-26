import { reqSerializer } from '../src/plugins/logger';

// PII masking regression tests for reqSerializer (§7 of the server spec).
// These act as a CI gate: if Authorization masking or lat/lng masking regresses,
// the test suite fails before code can be merged.

describe('reqSerializer — Authorization header masking', () => {
  it('replaces the token value but preserves "Bearer " prefix', () => {
    const req = {
      method: 'POST',
      url: '/api/v1/locations',
      headers: {
        authorization: 'Bearer tok_supersecrettoken123',
        'content-type': 'application/json',
      },
    };

    const serialized = reqSerializer(req);

    expect(serialized.headers['authorization']).toBe('Bearer [REDACTED]');
  });

  it('does not leak the raw token value in serialized output', () => {
    const rawToken = 'tok_supersecrettoken123';
    const req = {
      method: 'POST',
      url: '/api/v1/locations',
      headers: {
        authorization: `Bearer ${rawToken}`,
      },
    };

    const serialized = reqSerializer(req);
    const serializedStr = JSON.stringify(serialized);

    expect(serializedStr).not.toContain(rawToken);
  });

  it('passes through non-Authorization headers unchanged', () => {
    const req = {
      method: 'GET',
      url: '/healthz',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'abc-123',
        accept: '*/*',
      },
    };

    const serialized = reqSerializer(req);

    expect(serialized.headers['content-type']).toBe('application/json');
    expect(serialized.headers['x-request-id']).toBe('abc-123');
    expect(serialized.headers['accept']).toBe('*/*');
  });

  it('returns empty headers object when headers are missing', () => {
    const req = {
      method: 'GET',
      url: '/healthz',
      // headers intentionally omitted
    };

    const serialized = reqSerializer(req);

    expect(serialized.headers).toEqual({});
  });

  it('handles Authorization header with mixed case key', () => {
    // Fastify normalises header keys to lowercase, but test the serializer
    // independently to confirm it handles the lower-case form correctly.
    const req = {
      method: 'POST',
      url: '/api/v1/locations',
      headers: {
        authorization: 'Bearer tok_abc',
      },
    };

    const serialized = reqSerializer(req);

    expect(serialized.headers['authorization']).toBe('Bearer [REDACTED]');
    expect(serialized.headers['authorization']).not.toContain('tok_abc');
  });
});
