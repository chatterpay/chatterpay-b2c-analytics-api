import { readFile, writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

const OUTPUT = new URL('../openapi/openapi.yaml', import.meta.url);

/**
 * Writes `openapi/openapi.yaml` from the route schemas. With `--check` it writes nothing and exits
 * with status 1 when the committed file differs from the generated one.
 */
async function main(): Promise<void> {
  const app = await buildApp(loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
  await app.ready();
  const generated = app.swagger({ yaml: true });
  await app.close();

  if (process.argv.includes('--check')) {
    const committed = await readFile(OUTPUT, 'utf8').catch(() => '');
    if (committed !== generated) {
      process.stderr.write('openapi/openapi.yaml is out of date; run `yarn openapi`\n');
      process.exitCode = 1;
    }
    return;
  }
  await writeFile(OUTPUT, generated, 'utf8');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
