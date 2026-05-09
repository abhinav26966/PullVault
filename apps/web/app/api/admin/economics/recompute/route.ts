import { NextResponse } from 'next/server';
import { z } from 'zod';
import { recomputeAllTiers } from '@pullvault/db';
import { withErrors } from '@/lib/api-handler';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const BodySchema = z
  .object({
    targetMargin: z.number().min(0).max(0.95).optional(),
    trigger: z.string().max(64).optional(),
  })
  .strict();

export const POST = withErrors(async (req) => {
  // Trial scope: any authenticated user can recompute, matching the
  // existing /admin/economics page convention. Production would gate by
  // an admin role.
  await requireAuth();
  let body: z.infer<typeof BodySchema> = {};
  try {
    const raw = await req.json();
    body = BodySchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) throw err;
    // Empty body is acceptable.
    body = {};
  }
  const result = await recomputeAllTiers({
    targetMargin: body.targetMargin,
    trigger: body.trigger ?? 'manual',
  });
  return NextResponse.json({
    targetMargin: result.targetMargin,
    rarityMeanCents: result.rarityMeanCents,
    outcomes: result.outcomes,
  });
});
