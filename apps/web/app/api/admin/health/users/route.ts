import { NextResponse } from 'next/server';
import { withErrors } from '@/lib/api-handler';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

// Filled in by B5/5.
export const GET = withErrors(async () => {
  await requireAuth();
  return NextResponse.json({ tab: 'users', status: 'placeholder' });
});
