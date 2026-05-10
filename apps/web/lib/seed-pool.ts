import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@pullvault/db';
import { SeedPoolEmptyError } from './errors';

/**
 * Seed-pool consumer — Part B §12.
 *
 * Inside the existing buy / lottery-mint transaction, atomically claim one
 * unused (commit, server_seed) pair from the pre-published pool. The build
 * plan's correctness invariant: the user can prove their commit was already
 * in `/api/audit/commits` before their purchase, so the server cannot have
 * crafted a seed for their specific cards.
 *
 * Two-step consume because of the `seed_pool.used_for_pack_id → packs.id`
 * foreign key. Postgres validates FKs at end-of-statement (immediate,
 * non-deferred), so we cannot stamp `used_for_pack_id` until the `packs` row
 * exists. We split the operation:
 *
 *   1. `consumeSeed(tx)` — UPDATE seed_pool SET used=true, used_at=now()
 *      WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING …
 *      Returns the `seedPoolId` so step 2 can target the same row, plus
 *      `commit` + `serverSeed` for the HMAC and the pack insert.
 *
 *   2. `attachSeedToPack(tx, seedPoolId, packId)` — backfills the FK after
 *      the packs row is in place.
 *
 * Concurrent calls each claim a different row (FOR UPDATE SKIP LOCKED), so
 * the two-step pattern stays race-safe. If the pool is empty, throw
 * `SeedPoolEmptyError`; the buy endpoint surfaces this as a 503 rather than
 * silently fabricating a seed — preserving the audit invariant matters more
 * than a single denied purchase.
 */

export { SeedPoolEmptyError };

export interface ConsumedSeed {
  readonly seedPoolId: string;
  readonly commit: string;
  readonly serverSeed: string;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function consumeSeed(tx: Tx): Promise<ConsumedSeed> {
  const result = await tx.execute<{
    id: string;
    commit: string;
    server_seed: string;
  }>(sql`
    UPDATE seed_pool
    SET used = true,
        used_at = now()
    WHERE id = (
      SELECT id FROM seed_pool
      WHERE used = false
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, commit, server_seed
  `);

  const row = result[0];
  if (!row) throw new SeedPoolEmptyError();
  return { seedPoolId: row.id, commit: row.commit, serverSeed: row.server_seed };
}

export async function attachSeedToPack(
  tx: Tx,
  seedPoolId: string,
  packId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE seed_pool
    SET used_for_pack_id = ${packId}::uuid
    WHERE id = ${seedPoolId}::uuid
  `);
}
