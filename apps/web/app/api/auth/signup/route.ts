import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db, users, wallets, walletLedger } from '@pullvault/db';
import { withErrors } from '@/lib/api-handler';
import { hashPassword, signSessionToken, setSessionCookie } from '@/lib/auth';
import { EmailTakenError, DisplayNameTakenError } from '@/lib/errors';
import { withRateLimit } from '@/lib/rate-limit/middleware';
import {
  getClientIp,
  getClientTimezoneName,
  tzNameToOffsetMinutes,
} from '@/lib/request-headers';

const MULTI_ACCOUNT_THRESHOLD = 2; // 3rd+ account from the same IP raises the flag.

function hashUserAgent(ua: string | null): string | null {
  if (!ua) return null;
  return createHash('sha256').update(ua).digest('hex');
}

const SIGNUP_BONUS_CENTS = 100_000; // $1,000.00

const Body = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  displayName: z.string().trim().min(2).max(40),
});

export const POST = withErrors(
  withRateLimit(
    {
      endpoint: 'signup',
      // Anonymous endpoint — only the IP budget applies. 3 signups per IP per
      // hour throttles signup-cluster bots without affecting one-off humans.
      ip: { limit: 3, windowMs: 3_600_000 },
    },
    async (req) => {
  const body = Body.parse(await req.json());
  const passwordHash = await hashPassword(body.password);

  // Part B §10 anti-bot signals captured at signup. All three are best-effort:
  // null on local non-proxied dev or when Vercel's headers are absent.
  const signupIp = getClientIp(req);
  const signupUaHash = hashUserAgent(req.headers.get('user-agent'));
  const signupTzOffset = tzNameToOffsetMinutes(getClientTimezoneName(req));

  let userId: string;
  try {
    userId = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          email: body.email,
          passwordHash,
          displayName: body.displayName,
          signupIp,
          signupUaHash,
          signupTzOffset,
        })
        .returning({ id: users.id });
      if (!u) throw new Error('User insert returned no row');

      await tx.insert(wallets).values({
        userId: u.id,
        balanceAvailable: SIGNUP_BONUS_CENTS,
        balanceHeld: 0,
      });

      await tx.insert(walletLedger).values({
        userId: u.id,
        type: 'SIGNUP_BONUS',
        amount: SIGNUP_BONUS_CENTS,
      });

      return u.id;
    });
  } catch (err: unknown) {
    const code = (err as { code?: string; cause?: { code?: string } }).code
      ?? (err as { cause?: { code?: string } }).cause?.code;
    const constraint =
      (err as { constraint_name?: string }).constraint_name
      ?? (err as { cause?: { constraint_name?: string } }).cause?.constraint_name
      ?? '';
    if (code === '23505') {
      if (constraint.includes('email')) throw new EmailTakenError();
      if (constraint.includes('display_name')) throw new DisplayNameTakenError();
    }
    throw err;
  }

  // Multi-account flag — if N+ existing users already share this signup_ip,
  // mark the new user as flagged. Detection only; never auto-blocks. Best-
  // effort: a query failure here must not block a successful signup.
  if (signupIp) {
    try {
      const others = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.signupIp, signupIp), ne(users.id, userId)))
        .limit(MULTI_ACCOUNT_THRESHOLD + 1);
      if (others.length >= MULTI_ACCOUNT_THRESHOLD) {
        await db
          .update(users)
          .set({ flagMultiAccount: true })
          .where(eq(users.id, userId));
      }
    } catch (err) {
      console.error('[signup] multi-account check failed', err);
    }
  }

  const token = signSessionToken(userId);
  setSessionCookie(token);
  return NextResponse.json(
    { id: userId, email: body.email, displayName: body.displayName },
    { status: 201 },
  );
    },
  ),
);
