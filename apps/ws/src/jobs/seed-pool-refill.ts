import { randomBytes, createHash } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import cron, { type ScheduledTask } from 'node-cron';
import { db, seedPool } from '@pullvault/db';

/**
 * Seed-pool refill — Part B §12.
 *
 * Maintains the (commit, server_seed) pre-publication ledger that backs
 * provably-fair pack openings. Boot fires `runOnce()` synchronously so the
 * pool is healthy before the first pack purchase; the hourly cron keeps it
 * topped up as the buy path drains it.
 *
 * Why pre-publication: a user buying at time T can compare their assigned
 * commit against the public `/api/audit/commits` snapshot from any earlier
 * timestamp. If the commit was already there, the server cannot have
 * crafted the seed for their specific cards — the seed was committed to
 * before the server knew which user would draw it.
 *
 * Determinism / commit format:
 *
 * - `server_seed` is 32 cryptographic random bytes, hex-encoded (64 chars).
 *   The 32-byte width matches the SHA-256 input domain.
 * - `commit` is the lowercase hex SHA-256 of the server_seed string's UTF-8
 *   bytes. Critically this matches what the verify page computes via
 *   `crypto.subtle.digest('SHA-256', new TextEncoder().encode(serverSeed))`.
 *   If we hashed the decoded raw bytes instead the browser side would
 *   disagree and every verify would land on the SHA256 mismatch step. The
 *   sampler module's `sha256Hex` enforces the same encoding.
 */

const TARGET_POOL_SIZE = Number(process.env.SEED_POOL_TARGET ?? 100);
const BATCH_LIMIT = 50; // keep one tick's INSERT short
const HOURLY_CRON = '0 * * * *';

function generateSeed(): string {
  return randomBytes(32).toString('hex');
}

function hashSeed(serverSeed: string): string {
  // Encode the hex string as UTF-8, hash, return lowercase hex. Matches
  // sampler.sha256Hex on the verify page byte-for-byte.
  return createHash('sha256').update(serverSeed, 'utf8').digest('hex');
}

async function unusedCount(): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(seedPool)
    .where(eq(seedPool.used, false));
  return Number(row?.value ?? 0);
}

async function runOnce(): Promise<void> {
  const have = await unusedCount();
  const need = Math.max(0, TARGET_POOL_SIZE - have);
  if (need === 0) {
    console.log(`[seed-pool-refill] tick: ${have} unused (target ${TARGET_POOL_SIZE}) — healthy`);
    return;
  }

  const toInsert = Math.min(need, BATCH_LIMIT);
  const rows: { commit: string; serverSeed: string }[] = [];
  const seen = new Set<string>();
  while (rows.length < toInsert) {
    const seed = generateSeed();
    const commit = hashSeed(seed);
    if (seen.has(commit)) continue; // 1-in-2^256 — defensive
    seen.add(commit);
    rows.push({ commit, serverSeed: seed });
  }

  await db.insert(seedPool).values(rows);
  console.log(
    `[seed-pool-refill] inserted ${rows.length} (had ${have}, target ${TARGET_POOL_SIZE}); next tick will catch any remaining ${need - rows.length}`,
  );
}

export function scheduleSeedPoolRefill(): ScheduledTask {
  return cron.schedule(HOURLY_CRON, async () => {
    try {
      await runOnce();
    } catch (err) {
      console.error('[seed-pool-refill] tick failed', err);
    }
  });
}

export async function runSeedPoolRefillNow(): Promise<void> {
  await runOnce();
}
