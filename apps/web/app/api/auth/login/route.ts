import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, users } from '@pullvault/db';
import { withErrors } from '@/lib/api-handler';
import { verifyPassword, signSessionToken, setSessionCookie } from '@/lib/auth';
import { InvalidCredentialsError } from '@/lib/errors';

const Body = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export const POST = withErrors(async (req) => {
  const body = Body.parse(await req.json());

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, body.email))
    .limit(1);

  if (!user) throw new InvalidCredentialsError();

  const ok = await verifyPassword(body.password, user.passwordHash);
  if (!ok) throw new InvalidCredentialsError();

  const token = signSessionToken(user.id);
  setSessionCookie(token);

  return NextResponse.json({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
  });
});
