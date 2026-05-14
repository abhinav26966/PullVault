import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';

/**
 * Lottery intent store — Part B §10.
 *
 * During a drop's fairness window (default 5s after starts_at), every
 * /api/drops/[id]/buy intent gets enqueued into a Redis sorted set with a
 * cryptographically random score. The lottery-resolver cron later drains
 * the set in score order — first user popped gets first inventory unit,
 * regardless of who hit the endpoint first. Levels the playing field
 * against the fastest HTTP client.
 *
 * Cluster-safety: the key uses `{dropId}` as a hash tag so the entire
 * sorted set lives on one shard (ZPOPMIN is single-key, must be co-located).
 *
 * Crash-safety: ZPOPMIN is atomic and destructive, so a worker crash
 * mid-drain never re-pops the same intent. Combined with the cron's
 * `lottery_resolved` flag, a partial drain resumes from the next pending
 * intent on the next tick.
 */

declare global {
  // eslint-disable-next-line no-var
  var __pullvault_lottery_redis: Redis | undefined;
}

function getClient(): Redis {
  if (!globalThis.__pullvault_lottery_redis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL is required');
    const c = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
    c.on('error', (err) => console.error('[lottery]', err));
    globalThis.__pullvault_lottery_redis = c;
  }
  return globalThis.__pullvault_lottery_redis;
}

function lotteryKey(dropId: string): string {
  return `drop:{${dropId}}:lottery`;
}

function signatureKey(userId: string): string {
  return `bot:sig:{${userId}}`;
}

/** Random score in [0, 2^48). 6 bytes, collision-free at trial scale. */
function secureRandomScore(): number {
  return randomBytes(6).readUIntBE(0, 6);
}

export interface EnqueueResult {
  readonly score: number;
  readonly position: number; // 1-indexed
}

/**
 * Enqueue a buy intent. Idempotent per (dropId, userId): a duplicate from the
 * same user gets ignored (NX) so spamming the endpoint inside the window
 * does not improve odds.
 */
export async function enqueueIntent(
  dropId: string,
  userId: string,
  fairnessWindowMs: number,
): Promise<EnqueueResult> {
  const client = getClient();
  const k = lotteryKey(dropId);
  const score = secureRandomScore();
  // NX: only insert if userId is not already a member.
  await client.zadd(k, 'NX', score.toString(), userId);
  // PEXPIRE keeps the queue tidy if the resolver cron fails repeatedly.
  // ARCHITECTURE §11 explicitly allows pre-window clicks (they enqueue with
  // no priority advantage). For starts_at = NOW + N seconds workflows, the
  // entry must survive ~N seconds before the resolver drains. The previous
  // `fairnessWindowMs * 4 = 20s` was too tight for any N > 15s — entries
  // expired before the resolver fired. Generous TTL (10 minutes) covers any
  // reasonable pre-window pattern while still bounding stale-entry lifetime
  // if the cron is genuinely broken.
  await client.pexpire(k, Math.max(fairnessWindowMs * 4, 10 * 60 * 1000));
  const position = await client.zcount(k, '-inf', score.toString());
  return { score, position };
}

export interface PoppedIntent {
  readonly userId: string;
  readonly score: number;
}

/** ZPOPMIN — atomic, destructive. Returns null when the set is empty. */
export async function popNextIntent(dropId: string): Promise<PoppedIntent | null> {
  const r = await getClient().zpopmin(lotteryKey(dropId), 1);
  if (!r || r.length < 2) return null;
  return { userId: r[0]!, score: Number(r[1]) };
}

/**
 * Restore a popped intent — used by the cron's rowcount=0 safety net per
 * BUILD_PLAN B2 §"Lottery cron — explicit ZPOPMIN-then-update ordering."
 */
export async function returnIntent(
  dropId: string,
  userId: string,
  score: number,
): Promise<void> {
  await getClient().zadd(lotteryKey(dropId), score.toString(), userId);
}

/** Drain everything still in the queue. Caller broadcasts lottery_lost to each. */
export async function drainRemaining(dropId: string): Promise<string[]> {
  const client = getClient();
  const k = lotteryKey(dropId);
  const members: string[] = [];
  for (;;) {
    const r = await client.zpopmin(k, 100);
    if (!r || r.length === 0) break;
    for (let i = 0; i < r.length; i += 2) members.push(r[i]!);
  }
  return members;
}

/** Current queue size, no destructive read. */
export async function queueSize(dropId: string): Promise<number> {
  return getClient().zcard(lotteryKey(dropId));
}

export interface InteractionSignature {
  readonly mouseEvents: number;
  readonly keyEvents: number;
}

/**
 * Record an interaction signature for behavioural scoring. Capped 100 entries
 * per user, 7-day TTL. Bot-scoring cron reads `bot:sig:{userId}` and computes
 * "zero-mouse AND zero-key" frequency as a signal.
 */
export async function pushInteractionSignature(
  userId: string,
  sig: InteractionSignature,
): Promise<void> {
  const client = getClient();
  const k = signatureKey(userId);
  const payload = JSON.stringify({ ...sig, ts: Date.now() });
  await client.lpush(k, payload);
  await client.ltrim(k, 0, 99);
  await client.pexpire(k, 7 * 24 * 3_600 * 1_000);
}
