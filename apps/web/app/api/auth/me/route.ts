import { NextResponse } from 'next/server';
import { withErrors } from '@/lib/api-handler';
import { requireAuth } from '@/lib/require-auth';

export const GET = withErrors(async () => {
  const user = await requireAuth();
  return NextResponse.json({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
  });
});
