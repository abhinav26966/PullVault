import 'server-only';
import { cards, db } from '@pullvault/db';
import type { PoolCard } from '@pullvault/domain';

/**
 * Card pool is read-mostly (only the price pipeline mutates it, and only
 * prices, not the catalog). Cache once per process so the buy hot-path
 * doesn't re-query 500 rows on every request.
 *
 * Concurrent first-call requests share the in-flight Promise rather than
 * triggering parallel SELECTs.
 */
let cached: PoolCard[] | null = null;
let loading: Promise<PoolCard[]> | null = null;

export async function loadCardPool(): Promise<PoolCard[]> {
  if (cached) return cached;
  if (loading) return loading;
  loading = (async () => {
    const rows = await db.select({ id: cards.id, rarity: cards.rarity }).from(cards);
    cached = rows;
    loading = null;
    return rows;
  })();
  return loading;
}

/** For tests / dev: invalidate the cache so the next call re-reads. */
export function resetCardPool(): void {
  cached = null;
  loading = null;
}
