import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { withErrors } from '@/lib/api-handler';
import { UnauthorizedError } from '@/lib/errors';
import { verifySessionToken } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const COOKIE_NAME = 'pv_session';

/**
 * Hand the active session JWT back to the browser so the Socket.IO client
 * can pass it via `io(url, { auth: { token } })`. Cookie-based auth on a
 * cross-domain WS upgrade (Vercel web ↔ Railway ws) is not reliable across
 * browsers — the cookie is scoped to the web origin and never travels to
 * the WS origin even with SameSite=None. Standard Socket.IO pattern (see
 * https://socket.io/docs/v4/middlewares/) is to put the token in the
 * handshake auth payload, which we then validate in apps/ws/src/auth.ts.
 *
 * Same JWT, same secret, same TTL. Slight security trade-off vs the pure
 * httpOnly-cookie model (XSS could now read the token from JS memory) —
 * acceptable given the alternative is no live updates in the deployed split.
 */
export const GET = withErrors(async () => {
  const token = cookies().get(COOKIE_NAME)?.value;
  if (!token) throw new UnauthorizedError();
  const session = verifySessionToken(token);
  if (!session) throw new UnauthorizedError();
  return NextResponse.json({ token });
});
