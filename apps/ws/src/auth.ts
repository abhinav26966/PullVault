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

export function authenticate(socket: Socket): { userId: string } | null {
  const token = parseCookie(socket.handshake.headers.cookie, COOKIE_NAME);
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, jwtSecret()) as { sub?: unknown };
    if (typeof decoded.sub !== 'string') return null;
    return { userId: decoded.sub };
  } catch {
    return null;
  }
}
