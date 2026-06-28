export interface AppConfig {
  port: number;
  host: string;
  databaseUrl: string;
  adminApiKey: string;
  logLevel: string;
  maxInflightRequests: number;
  requestTimeoutMs: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[config] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

function parsePositiveInt(envName: string, raw: string, defaultValue: number): number {
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 0) {
    console.warn(
      `[config] ${envName} is not a valid non-negative integer ("${raw}"), using default ${defaultValue}`
    );
    return defaultValue;
  }
  return parsed;
}

export function loadConfig(): AppConfig {
  const port = parseInt(optionalEnv('PORT', '3000'), 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(
      `[config] PORT must be a valid port number (1-65535), got: ${process.env['PORT']}`
    );
    process.exit(1);
  }

  const maxInflightRequests = parsePositiveInt(
    'MAX_INFLIGHT_REQUESTS',
    optionalEnv('MAX_INFLIGHT_REQUESTS', '200'),
    200
  );

  // 29 s — comfortably within the client's 30 s read timeout (§7).
  const requestTimeoutMs = parsePositiveInt(
    'REQUEST_TIMEOUT_MS',
    optionalEnv('REQUEST_TIMEOUT_MS', '29000'),
    29_000
  );

  return {
    port,
    host: optionalEnv('HOST', '0.0.0.0'),
    databaseUrl: requireEnv('DATABASE_URL'),
    adminApiKey: requireEnv('ADMIN_API_KEY'),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
    maxInflightRequests,
    requestTimeoutMs,
  };
}
