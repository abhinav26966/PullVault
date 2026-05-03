import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, users, wallets, walletLedger } from '@pullvault/db';
import { withErrors } from '@/lib/api-handler';
import { hashPassword, signSessionToken, setSessionCookie } from '@/lib/auth';
import { EmailTakenError, DisplayNameTakenError } from '@/lib/errors';

const SIGNUP_BONUS_CENTS = 100_000; // $1,000.00

const Body = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  displayName: z.string().trim().min(2).max(40),
});

export const POST = withErrors(async (req) => {
  const body = Body.parse(await req.json());
  const passwordHash = await hashPassword(body.password);

  let userId: string;
  try {
    userId = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          email: body.email,
          passwordHash,
          displayName: body.displayName,
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

  const token = signSessionToken(userId);
  setSessionCookie(token);
  return NextResponse.json(
    { id: userId, email: body.email, displayName: body.displayName },
    { status: 201 },
  );
});
