import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

/**
 * Sliding-window-log rate limiter — Part B §10.
 *
 * Lua-on-Redis (atomic). 100 concurrent calls against the same key see a
 * serialised state: exactly `limit` succeed, the rest get retry_after_ms.
 * No GET-then-SET race window — the script ZREMRANGEBYSCORE / ZCARD / ZADD
 * inside a single EVAL.
 *
 * Key shape uses an ioredis-cluster hash tag (`{...}`) so future cluster
 * mode keeps the same key on the same shard:
 *   rl:{user:<userId>}:<endpoint>
 *   rl:{ip:<ip>}:<endpoint>
 */

// Lua source embedded so Next.js bundling doesn't have to ship the .lua file.
// The .lua file at sliding-window.lua is the source of truth for review; this
// constant must mirror it byte-for-byte (a CI smoke would catch drift).
const SLIDING_WINDOW_LUA = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)

local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window + 1000)
  return {1, limit - count - 1}
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry = window
if #oldest >= 2 then
  retry = (tonumber(oldest[2]) + window) - now
  if retry < 0 then retry = 0 end
end
return {0, retry}
`.trim();

declare global {
  // eslint-disable-next-line no-var
  var __pullvault_rl_client: Redis | undefined;
  // eslint-disable-next-line no-var
  var __pullvault_rl_sha: string | undefined;
}

function getClient(): Redis {
  if (!globalThis.__pullvault_rl_client) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL is required');
    const c = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
    c.on('error', (err) => console.error('[rate-limit]', err));
    globalThis.__pullvault_rl_client = c;
  }
  return globalThis.__pullvault_rl_client;
}

async function getScriptSha(client: Redis): Promise<string> {
  if (globalThis.__pullvault_rl_sha) return globalThis.__pullvault_rl_sha;
  const sha = (await client.script('LOAD', SLIDING_WINDOW_LUA)) as string;
  globalThis.__pullvault_rl_sha = sha;
  return sha;
}

export type Scope = 'user' | 'ip';

export interface RateLimitOptions {
  readonly scope: Scope;
  readonly scopeId: string;
  readonly endpoint: string;
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
  readonly key: string;
}

function buildKey(opts: RateLimitOptions): string {
  // Hash tag wraps the (scope:id) so cluster mode keeps the key on one shard.
  return `rl:{${opts.scope}:${opts.scopeId}}:${opts.endpoint}`;
}

export async function check(opts: RateLimitOptions): Promise<RateLimitResult> {
  const client = getClient();
  const key = buildKey(opts);
  const now = Date.now();
  const member = `${now}-${randomUUID()}`;

  let res: [number, number];
  try {
    const sha = await getScriptSha(client);
    res = (await client.evalsha(
      sha,
      1,
      key,
      now.toString(),
      opts.windowMs.toString(),
      opts.limit.toString(),
      member,
    )) as [number, number];
  } catch (err) {
    // NOSCRIPT — Redis evicted the cached script. Reload and retry once.
    if (err instanceof Error && /NOSCRIPT/.test(err.message)) {
      globalThis.__pullvault_rl_sha = undefined;
      const sha = await getScriptSha(client);
      res = (await client.evalsha(
        sha,
        1,
        key,
        now.toString(),
        opts.windowMs.toString(),
        opts.limit.toString(),
        member,
      )) as [number, number];
    } else {
      throw err;
    }
  }

  const [allowedFlag, secondVal] = res;
  return {
    allowed: allowedFlag === 1,
    remaining: allowedFlag === 1 ? Number(secondVal) : 0,
    retryAfterMs: allowedFlag === 0 ? Number(secondVal) : 0,
    key,
  };
}
