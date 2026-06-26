export interface AppConfig {
  port: number;
  host: string;
  databaseUrl: string;
  adminApiKey: string;
  logLevel: string;
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

export function loadConfig(): AppConfig {
  const port = parseInt(optionalEnv('PORT', '3000'), 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`[config] PORT must be a valid port number (1-65535), got: ${process.env['PORT']}`);
    process.exit(1);
  }

  return {
    port,
    host: optionalEnv('HOST', '0.0.0.0'),
    databaseUrl: requireEnv('DATABASE_URL'),
    adminApiKey: requireEnv('ADMIN_API_KEY'),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
  };
}
