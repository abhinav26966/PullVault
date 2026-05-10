import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@pullvault/db';

/**
 * Seed-pool consumer — Part B §12.
 *
 * Inside the existing buy / lottery-mint transaction, atomically claim one
 * unused (commit, server_seed) pair from the pre-published pool. The build
 * plan's correctness invariant: the user can prove their commit was already
 * in `/api/audit/commits` before their purchase, so the server cannot have
 * crafted a seed for their specific cards.
 *
 * SQL semantics:
 *
 * - `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` lets concurrent buy
 *   transactions each claim a different row without blocking on each other.
 *   The `seed_pool_unused_idx` partial index drives the inner SELECT.
 * - The outer UPDATE ... RETURNING flips `used`, stamps `used_for_pack_id`
 *   and `used_at`, and hands the seed back in one round-trip.
 * - We pass the freshly-generated `packId` because the buy route generates
 *   the pack UUID in JS *before* the pack insert (so the HMAC payload
 *   `client_seed:pack_id:i` and the `packs.id` value agree without needing a
 *   second UPDATE round-trip).
 *
 * If the pool is empty, throw `SeedPoolEmptyError`. The WS refill cron
 * targets ≥ 100 unused entries; an empty pool means the cron is wedged. The
 * buy endpoint surfaces this as a 503 rather than silently fabricating a
 * seed — keeping the audit invariant intact is more important than the
 * single denied purchase.
 */

export class SeedPoolEmptyError extends Error {
  constructor() {
    super(
      'seed_pool exhausted — refill cron may be down. Buy denied to preserve provably-fair invariant.',
    );
    this.name = 'SeedPoolEmptyError';
  }
}

export interface ConsumedSeed {
  readonly commit: string;
  readonly serverSeed: string;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function consumeSeed(tx: Tx, packId: string): Promise<ConsumedSeed> {
  const result = await tx.execute<{ commit: string; server_seed: string }>(sql`
    UPDATE seed_pool
    SET used = true,
        used_for_pack_id = ${packId}::uuid,
        used_at = now()
    WHERE id = (
      SELECT id FROM seed_pool
      WHERE used = false
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING commit, server_seed
  `);

  const row = result[0];
  if (!row) throw new SeedPoolEmptyError();
  return { commit: row.commit, serverSeed: row.server_seed };
}
