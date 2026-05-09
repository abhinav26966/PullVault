import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env.local') });

/**
 * Reviewer test: "100 simultaneous requests, does the rate limiter hold?"
 *
 * Fires CONCURRENT requests in parallel against the same key with limit=N.
 * Asserts exactly N succeed and (CONCURRENT - N) are blocked. If the
 * sliding-window Lua weren't atomic, you'd see allowed > limit.
 *
 * Run: pnpm -F @pullvault/web rate-limit-stress
 */

const CONCURRENT = 100;
const LIMIT = 5;
const WINDOW_MS = 60_000;

async function main() {
  const { check } = await import('../lib/rate-limit/index');

  // Unique scope per run so prior runs' zset entries don't leak into this one.
  const scopeId = `stress-${randomUUID()}`;

  const start = Date.now();
  const results = await Promise.all(
    Array.from({ length: CONCURRENT }, () =>
      check({ scope: 'user', scopeId, endpoint: 'stress-test', limit: LIMIT, windowMs: WINDOW_MS }),
    ),
  );
  const elapsed = Date.now() - start;

  const allowed = results.filter((r) => r.allowed).length;
  const blocked = results.filter((r) => !r.allowed).length;

  const expectAllowed = LIMIT;
  const expectBlocked = CONCURRENT - LIMIT;

  const ok = allowed === expectAllowed && blocked === expectBlocked;
  console.log(
    `[rate-limit-stress] concurrent=${CONCURRENT} limit=${LIMIT} window=${WINDOW_MS}ms`,
  );
  console.log(
    `[rate-limit-stress] allowed=${allowed} (expect ${expectAllowed}) blocked=${blocked} (expect ${expectBlocked}) elapsed=${elapsed}ms`,
  );
  console.log(`[rate-limit-stress] ${ok ? 'PASS' : 'FAIL'}`);

  // Spot-check a few retry_after values are sane (>0, <window).
  const sampleBlocked = results.filter((r) => !r.allowed).slice(0, 3);
  for (const r of sampleBlocked) {
    console.log(`  blocked retry_after_ms=${r.retryAfterMs} (range 0..${WINDOW_MS})`);
  }

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
