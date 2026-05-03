/**
 * Fees are stored as basis points (1 bp = 0.01%). Math.ceil ensures the
 * platform never shorts itself on rounding — the buyer/seller pays the
 * fractional cent in our favor.
 */
const TRADE_FEE_BPS = 300; // 3.00%
const AUCTION_FEE_BPS = 500; // 5.00%
const BPS_DIVISOR = 10_000;

export function calculateTradeFee(saleCents: number): number {
  if (saleCents < 0) throw new Error('saleCents must be non-negative');
  return Math.ceil((saleCents * TRADE_FEE_BPS) / BPS_DIVISOR);
}

export function calculateAuctionFee(winningBidCents: number): number {
  if (winningBidCents < 0) throw new Error('winningBidCents must be non-negative');
  return Math.ceil((winningBidCents * AUCTION_FEE_BPS) / BPS_DIVISOR);
}
