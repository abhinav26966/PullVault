import jwt from 'jsonwebtoken';
import type { Socket } from 'socket.io';

const COOKIE_NAME = 'pv_session';

function jwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is required');
  return s;
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/**
 * Authenticate a Socket.IO connection. Two paths:
 *
 *   1. Handshake auth payload (preferred, cross-domain prod): client passes
 *      `io(url, { auth: { token } })`. Vercel web fetches the JWT from a
 *      same-origin endpoint (/api/auth/ws-token) and forwards it here.
 *      Cookies do NOT cross unrelated origins (Vercel ≠ Railway) regardless
 *      of SameSite, so this is the only reliable path for the split deploy.
 *
 *   2. Cookie (fallback, same-origin dev convenience): if the connection
 *      shares an origin with the web app, the httpOnly pv_session cookie
 *      rides the upgrade headers. Useful when running both apps on
 *      localhost during development.
 *
 * Standard pattern documented at https://socket.io/docs/v4/middlewares/.
 */
export function authenticate(socket: Socket): { userId: string } | null {
  const authPayload = socket.handshake.auth as { token?: unknown } | undefined;
  let token: string | undefined =
    typeof authPayload?.token === 'string' ? authPayload.token : undefined;

  if (!token) {
    token = parseCookie(socket.handshake.headers.cookie, COOKIE_NAME);
  }

  if (!token) return null;
  try {
    const decoded = jwt.verify(token, jwtSecret()) as { sub?: unknown };
    if (typeof decoded.sub !== 'string') return null;
    return { userId: decoded.sub };
  } catch {
    return null;
  }
}
