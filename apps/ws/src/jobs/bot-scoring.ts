import { eq, sql } from 'drizzle-orm';
import cron, { type ScheduledTask } from 'node-cron';
import { db, packs, users } from '@pullvault/db';
import Redis from 'ioredis';

/**
 * Bot-scoring cron — Part B §10.
 *
 * Walks every user every 5 minutes and computes a 0..100 bot_score from a
 * weighted sum of signals. Decoration only — never auto-blocks; surfaced in
 * the B5 fraud tab.
 *
 * Signals implemented in B2:
 *   3. Fast first-buy            — signup → first PACK_PURCHASE < 60s    +25
 *   6. Zero-interaction signals  — bot:sig:{userId} list mostly zero      +20
 *   8. UA diversity per IP       — same signup_ip ≥ 4 distinct UA hashes  +15
 *
 * Signals deferred (no infrastructure dependency in B2):
 *   1. Inter-arrival std dev      — requires per-request log not yet built
 *   2. Headless UA pattern        — would need raw UA stored, only hash today
 *   4. Lottery-participation count — counter not instrumented in B2
 *   5. Timezone-consistency        — needs GeoIP signup_ip → expected tz
 *
 * Signal #7 (cross-account client_seed identicality) is wired below. The
 * cron's branch exists, a column-existence guard short-circuits in dev
 * environments without the B4 migration applied, and the cross-user
 * collision query runs in production where `packs.client_seed` is present.
 */

const SCORE_FAST_FIRST_BUY = 25;
const SCORE_NO_INTERACTION = 20;
const SCORE_UA_DIVERSITY = 15;
const SCORE_CLIENT_SEED_DUPLICATE = 25; // signal #7

const FAST_FIRST_BUY_MS = 60_000;
const UA_DIVERSITY_THRESHOLD = 4;
const NO_INTERACTION_RATIO = 0.5;

let redisClient: Redis | null = null;
function getRedis(): Redis {
  if (redisClient) return redisClient;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required');
  redisClient = new Redis(url, { maxRetriesPerRequest: 3 });
  redisClient.on('error', (err) => console.error('[bot-scoring redis]', err));
  return redisClient;
}

async function readInteractionStats(userId: string): Promise<{
  total: number;
  zeroBoth: number;
}> {
  const r = getRedis();
  const k = `bot:sig:{${userId}}`;
  const entries = await r.lrange(k, 0, -1);
  let zeroBoth = 0;
  for (const e of entries) {
    try {
      const obj = JSON.parse(e) as { mouseEvents?: number; keyEvents?: number };
      if (obj.mouseEvents === 0 && obj.keyEvents === 0) zeroBoth++;
    } catch {
      // skip malformed entries
    }
  }
  return { total: entries.length, zeroBoth };
}

/**
 * Signal #7 — returns SCORE_CLIENT_SEED_DUPLICATE for any user whose
 * `packs.client_seed` matches a pack owned by a different user. Random
 * 32-byte client seeds never collide (1 in 2^256); only deliberate reuse
 * across accounts trips this signal, which is exactly the abuse pattern
 * (one human running two accounts, copy-pasting their seed). The
 * column-existence guard keeps the cron working in dev environments
 * where B4 hasn't migrated yet.
 */
async function scoreClientSeedDuplicate(userId: string): Promise<number> {
  // Detect column existence at runtime via information_schema. Cheap; cached
  // implicitly by Postgres. When B4 lands, the branch flips automatically and
  // the cross-user collision check runs.
  const result = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'packs' AND column_name = 'client_seed'
    ) AS exists
  `);
  // postgres-js returns rows as an iterable / array on result.
  const rows = (result as unknown as { rows?: { exists: boolean }[] }).rows ??
    (result as unknown as { exists: boolean }[]);
  const exists = Array.isArray(rows) ? rows[0]?.exists : false;
  if (!exists) return 0;

  // Trial-scale implementation: one EXISTS-in-EXISTS per scored user (N+1).
  // At production scale, materialize the colliding-seeds set once per cron tick
  // and do array-membership lookup per user. Not worth doing at current pack volume.
  const collision = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM packs p1
      WHERE p1.owner_id = ${userId}::uuid
        AND p1.client_seed IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM packs p2
          WHERE p2.owner_id <> p1.owner_id
            AND p2.client_seed = p1.client_seed
        )
    ) AS has_collision
  `);
  const cRows = (collision as unknown as { rows?: { has_collision: boolean }[] }).rows ??
    (collision as unknown as { has_collision: boolean }[]);
  return Array.isArray(cRows) && cRows[0]?.has_collision
    ? SCORE_CLIENT_SEED_DUPLICATE
    : 0;
}

async function scoreOnce(): Promise<void> {
  const allUsers = await db
    .select({
      id: users.id,
      createdAt: users.createdAt,
      signupIp: users.signupIp,
      signupUaHash: users.signupUaHash,
    })
    .from(users);

  // Pre-compute UA-diversity-per-IP table.
  const uaByIp = new Map<string, Set<string>>();
  for (const u of allUsers) {
    if (!u.signupIp || !u.signupUaHash) continue;
    let set = uaByIp.get(u.signupIp);
    if (!set) {
      set = new Set();
      uaByIp.set(u.signupIp, set);
    }
    set.add(u.signupUaHash);
  }

  let updated = 0;
  for (const u of allUsers) {
    let score = 0;

    // Signal 3 — fast first-buy.
    const [firstPack] = await db
      .select({ purchasedAt: packs.purchasedAt })
      .from(packs)
      .where(eq(packs.ownerId, u.id))
      .orderBy(packs.purchasedAt)
      .limit(1);
    if (firstPack) {
      const delta = firstPack.purchasedAt.getTime() - u.createdAt.getTime();
      if (delta < FAST_FIRST_BUY_MS) score += SCORE_FAST_FIRST_BUY;
    }

    // Signal 6 — zero-interaction ratio over the last N buys.
    try {
      const sig = await readInteractionStats(u.id);
      if (sig.total >= 3 && sig.zeroBoth / sig.total >= NO_INTERACTION_RATIO) {
        score += SCORE_NO_INTERACTION;
      }
    } catch (err) {
      console.error('[bot-scoring] interaction read failed', err);
    }

    // Signal 7 — cross-account client_seed collision.
    score += await scoreClientSeedDuplicate(u.id);

    // Signal 8 — UA diversity per IP.
    if (u.signupIp) {
      const distinct = uaByIp.get(u.signupIp)?.size ?? 0;
      if (distinct >= UA_DIVERSITY_THRESHOLD) score += SCORE_UA_DIVERSITY;
    }

    // Clamp 0..100 just in case more signals are added later.
    score = Math.max(0, Math.min(100, score));

    await db.update(users).set({ botScore: score }).where(eq(users.id, u.id));
    if (score > 0) updated++;
  }
  console.log(`[bot-scoring] scored ${allUsers.length} users, ${updated} non-zero`);
}

export function scheduleBotScoring(): ScheduledTask {
  return cron.schedule('*/5 * * * *', async () => {
    try {
      await scoreOnce();
    } catch (err) {
      console.error('[bot-scoring] tick failed', err);
    }
  });
}

export async function runBotScoringNow(): Promise<void> {
  await scoreOnce();
}
