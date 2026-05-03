/**
 * Soft-close anti-snipe. Any bid extends `endsAt` to at least
 * `bidPlacedAt + 30s` — but never shortens it. ARCHITECTURE §15.
 *
 * The server-side SQL form is `GREATEST(ends_at, now() + interval '30s')`;
 * this is the JS twin used by tests and (optionally) by client previews.
 */
export const ANTI_SNIPE_EXTENSION_SECONDS = 30;

export function computeNewEndsAt(
  currentEndsAt: Date,
  bidPlacedAt: Date,
  extensionSeconds: number = ANTI_SNIPE_EXTENSION_SECONDS,
): Date {
  const proposed = new Date(bidPlacedAt.getTime() + extensionSeconds * 1000);
  return proposed > currentEndsAt ? proposed : currentEndsAt;
}
