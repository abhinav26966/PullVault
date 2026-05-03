import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL is required. It must be the Supabase pooler URL ' +
      '(port 6543, *.pooler.supabase.com). The direct connection on port 5432 ' +
      'is IPv6-only on the free tier and unreachable from many machines.',
  );
}

// PgBouncer transaction pooler does not support prepared statements.
// `prepare: false` is mandatory — without it, queries fail intermittently with
// cryptic "prepared statement does not exist" errors. Silent-failure trap.
// See ARCHITECTURE §16 and Supabase's official Drizzle guide.
export const queryClient = postgres(url, { prepare: false });

export const db = drizzle(queryClient, {
  schema,
  // Set DB_DEBUG=1 in .env.local to print every SQL statement Drizzle sends.
  // Off by default; the env toggle stays as a debug knob for future timing or
  // serialisation issues (Phase 10 used it to verify the anti-snipe SQL).
  logger: process.env.DB_DEBUG === '1',
});

export type DB = typeof db;
