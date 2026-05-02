import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load repo-root .env.local. Must run before importing the client (which
// reads process.env.DATABASE_URL at module-evaluation time).
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../../.env.local') });

async function main() {
  // Dynamic import so client.ts evaluates after dotenv.config() has run.
  const { queryClient } = await import('../client');
  const rows = await queryClient`SELECT 1 AS one`;
  console.log('DB smoke OK:', rows[0]);

  // Spot-check that the schema applied: list tables in public.
  const tables = await queryClient<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  console.log(
    `tables (${tables.length}):`,
    tables.map((t) => t.table_name).join(', '),
  );

  await queryClient.end();
}

main().catch((err) => {
  console.error('DB smoke test failed:', err);
  process.exit(1);
});
