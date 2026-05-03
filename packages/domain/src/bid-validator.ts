/** Min increment is the larger of $0.50 absolute or 5% of the baseline. */
const MIN_INCREMENT_CENTS = 50;
const MIN_INCREMENT_PERCENT = 0.05;

/** Fat-finger guard: reject bids over 100x baseline. */
const FAT_FINGER_MULTIPLIER = 100;

/**
 * Cents in, cents out. Used both client-side (to populate the bid input) and
 * server-side (to validate). Sharing this prevents drift between the two —
 * if it ever differed, users would see confusing rejections after typing
 * what looked like a valid bid. ARCHITECTURE §6.3.
 */
export function computeMinValidBid(
  currentBid: number | null,
  startingBid: number,
): number {
  if (currentBid === null) return startingBid;
  const fivePercent = Math.ceil(currentBid * MIN_INCREMENT_PERCENT);
  return currentBid + Math.max(MIN_INCREMENT_CENTS, fivePercent);
}

export type BidValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'TOO_LOW' | 'TOO_HIGH' };

export function validateBid(
  currentBid: number | null,
  startingBid: number,
  newBid: number,
): BidValidationResult {
  const min = computeMinValidBid(currentBid, startingBid);
  if (newBid < min) return { ok: false, reason: 'TOO_LOW' };
  const baseline = currentBid ?? startingBid;
  if (newBid > baseline * FAT_FINGER_MULTIPLIER) return { ok: false, reason: 'TOO_HIGH' };
  return { ok: true };
}
