import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// Load repo-root .env.local. drizzle-kit invokes this file with cwd = packages/db.
config({ path: '../../.env.local' });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL is required for drizzle-kit. It must be the Supabase pooler ' +
      'URL (port 6543) — the direct connection is IPv6-only and unreachable.',
  );
}

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  verbose: true,
  strict: true,
});
