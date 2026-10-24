import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { MemoryStore } from './store/memory-store.js';
import { MongoStore } from './store/mongo-store.js';
import type { Store } from './store/types.js';

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * Process entry point: validates the environment, connects the store, starts listening and closes
 * gracefully on SIGINT/SIGTERM (Cloud Run sends SIGTERM before stopping an instance).
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const store: Store =
    env.MONGO_URI === null
      ? new MemoryStore()
      : await MongoStore.connect({ uri: env.MONGO_URI, dbName: env.MONGO_DB_NAME });
  const app = await buildApp(env, { store });
  app.addHook('onClose', async () => {
    await store.close();
  });

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
