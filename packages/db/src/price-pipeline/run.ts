import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load repo-root .env.local before any DB module evaluates.
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../../.env.local') });

async function main() {
  const { runPipeline, ensurePlatformUser, ensureSampleDrops } = await import(
    './run-pipeline'
  );
  const { queryClient } = await import('../client');

  const result = await runPipeline();
  await ensurePlatformUser();
  await ensureSampleDrops();

  console.log('\n=== pipeline summary ===');
  console.log(JSON.stringify({ ...result, changed: undefined }, null, 2));

  await queryClient.end();
}

main().catch((err) => {
  console.error('pipeline failed:', err);
  process.exit(1);
});
