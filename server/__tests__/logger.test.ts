import { reqSerializer, maskObject } from '../src/plugins/logger';

// PII masking regression tests (§7 of the server spec).
// Acts as a CI gate: if Authorization header masking, lat/lng masking, or token
// masking regresses, the test suite fails before code can be merged.

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

  it('masks Authorization header regardless of key casing', () => {
    // HTTP/2 normalises headers to lowercase, but test that the serializer
    // handles mixed-case keys that might appear in HTTP/1.1 proxies.
    const req = {
      method: 'POST',
      url: '/api/v1/locations',
      headers: {
        Authorization: 'Bearer tok_mixedcase',
      } as Record<string, string>,
    };

    const serialized = reqSerializer(req);

    expect(serialized.headers['Authorization']).toBe('Bearer [REDACTED]');
    expect(JSON.stringify(serialized)).not.toContain('tok_mixedcase');
  });
});

describe('maskObject — response body PII masking', () => {
  it('redacts lat and lng fields at the top level', () => {
    const body = { lat: 35.6895, lng: 139.6917, speed: 13.5 };

    const masked = maskObject(body) as Record<string, unknown>;

    expect(masked['lat']).toBe('[REDACTED]');
    expect(masked['lng']).toBe('[REDACTED]');
    expect(masked['speed']).toBe(13.5);
  });

  it('redacts lat/lng nested inside samples array', () => {
    const body = {
      samples: [
        { id: 'abc', lat: 35.6895, lng: 139.6917, speedMps: 10 },
        { id: 'def', lat: 35.69, lng: 139.7, speedMps: 12 },
      ],
    };

    const masked = maskObject(body) as { samples: Record<string, unknown>[] };

    for (const sample of masked.samples) {
      expect(sample['lat']).toBe('[REDACTED]');
      expect(sample['lng']).toBe('[REDACTED]');
    }
    expect(masked.samples[0]!['speedMps']).toBe(10);
  });

  it('replaces tok_* token patterns in string values', () => {
    const body = { message: 'token is tok_abc123xyz and should be hidden' };

    const masked = maskObject(body) as Record<string, unknown>;

    expect(masked['message']).toBe('token is [REDACTED] and should be hidden');
  });

  it('passes through non-PII fields unchanged', () => {
    const body = { status: 'ok', inserted: 5, duplicates: 0 };

    const masked = maskObject(body) as Record<string, unknown>;

    expect(masked['status']).toBe('ok');
    expect(masked['inserted']).toBe(5);
    expect(masked['duplicates']).toBe(0);
  });

  it('handles null and primitive values without throwing', () => {
    expect(maskObject(null)).toBeNull();
    expect(maskObject(42)).toBe(42);
    expect(maskObject(true)).toBe(true);
    expect(maskObject(undefined)).toBeUndefined();
  });
});
