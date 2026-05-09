import { NextResponse } from 'next/server';
import { db, rateLimitAudit } from '@pullvault/db';
import { getSessionUser } from '@/lib/auth';
import { getClientIp } from '@/lib/request-headers';
import { check, type Scope } from './index';

/**
 * withRateLimit — wraps a route handler with sliding-window-log enforcement.
 *
 * Two independent budgets per endpoint: per-user and per-IP. Either one
 * blocking returns 429. Per-user is skipped if the request is unauthed
 * (the per-IP cap is what stops anonymous floods); the inner handler
 * still does its own requireAuth() for actual authorisation.
 *
 * Audit: every block writes one rate_limit_audit row (best-effort — audit
 * failure never affects the user response).
 *
 * Composition: nest withErrors OUTSIDE withRateLimit so unhandled errors
 * inside the limiter still map to a JSON 5xx instead of leaking.
 */

type Params = Record<string, string>;

type Handler<P extends Params = Params> = (
  req: Request,
  ctx: { params: P },
) => Promise<Response>;

export interface RateLimitBudget {
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitConfig {
  /** Stable identifier for the audit row, e.g. 'buy_drop'. */
  readonly endpoint: string;
  readonly user?: RateLimitBudget;
  readonly ip?: RateLimitBudget;
}

function build429(retryAfterMs: number): Response {
  return NextResponse.json(
    { error: 'RATE_LIMITED', retryAfterMs },
    {
      status: 429,
      headers: { 'Retry-After': Math.max(1, Math.ceil(retryAfterMs / 1000)).toString() },
    },
  );
}

async function writeAudit(scope: Scope, scopeId: string, endpoint: string): Promise<void> {
  try {
    await db.insert(rateLimitAudit).values({ scope, scopeId, endpoint });
  } catch (err) {
    // Audit is observability, not correctness — never fail the user request.
    console.error('[rate-limit] audit insert failed', err);
  }
}

export function withRateLimit<P extends Params = Params>(
  cfg: RateLimitConfig,
  handler: Handler<P>,
): Handler<P> {
  return async (req, ctx) => {
    const ip = getClientIp(req);
    const sessionUser = await getSessionUser();
    const userId = sessionUser?.id ?? null;

    if (cfg.ip && ip) {
      const r = await check({
        scope: 'ip',
        scopeId: ip,
        endpoint: cfg.endpoint,
        limit: cfg.ip.limit,
        windowMs: cfg.ip.windowMs,
      });
      if (!r.allowed) {
        await writeAudit('ip', ip, cfg.endpoint);
        return build429(r.retryAfterMs);
      }
    }

    if (cfg.user && userId) {
      const r = await check({
        scope: 'user',
        scopeId: userId,
        endpoint: cfg.endpoint,
        limit: cfg.user.limit,
        windowMs: cfg.user.windowMs,
      });
      if (!r.allowed) {
        await writeAudit('user', userId, cfg.endpoint);
        return build429(r.retryAfterMs);
      }
    }

    return handler(req, ctx);
  };
}
