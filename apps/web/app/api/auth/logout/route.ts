import { NextResponse } from 'next/server';
import { withErrors } from '@/lib/api-handler';
import { clearSessionCookie } from '@/lib/auth';

export const POST = withErrors(async () => {
  clearSessionCookie();
  return NextResponse.json({ ok: true });
});
