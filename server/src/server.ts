import { loadConfig } from './config';
import { buildApp } from './app';

const SHUTDOWN_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildApp(config);

  const shutdown = (signal: string) => {
    app.log.info({ signal }, 'Received shutdown signal, draining connections...');

    const forceExit = setTimeout(() => {
      app.log.error('Graceful shutdown timed out after 30s, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    // Ensure the timeout does not prevent the process from exiting normally
    forceExit.unref();

    app.close().then(
      () => {
        app.log.info('Server closed gracefully');
        process.exit(0);
      },
      (err: unknown) => {
        app.log.error({ err }, 'Error during graceful shutdown');
        process.exit(1);
      }
    );
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Unhandled error during startup', err);
  process.exit(1);
});
