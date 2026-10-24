import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * Process entry point: validates the environment, starts listening and closes gracefully on
 * SIGINT/SIGTERM (Cloud Run sends SIGTERM before stopping an instance).
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      app.close().then(
        () => process.exit(0),
        (error: unknown) => {
          app.log.error({ err: error }, 'shutdown failed');
          process.exit(1);
        }
      );
    });
  }

  await app.listen({ host: env.HOST, port: env.PORT });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Startup failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
