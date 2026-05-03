import 'server-only';
import type { User } from '@pullvault/db';
import { getSessionUser } from './auth';
import { UnauthorizedError } from './errors';

export async function requireAuth(): Promise<User> {
  const user = await getSessionUser();
  if (!user) throw new UnauthorizedError();
  return user;
}
