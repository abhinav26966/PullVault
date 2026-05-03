import { describe, expect, it } from 'vitest';
import { computeMinValidBid, validateBid } from '../bid-validator';

describe('computeMinValidBid', () => {
  it('first bid (currentBid null) must equal startingBid', () => {
    expect(computeMinValidBid(null, 500)).toBe(500);
    expect(computeMinValidBid(null, 1)).toBe(1);
  });

  it('uses 50¢ floor when 5% would be smaller', () => {
    // Current $5: 5% = 25¢, floor wins → +50¢ = $5.50.
    expect(computeMinValidBid(500, 100)).toBe(550);
    // Current $9.99: 5% = 50¢ (49.95 → ceil 50¢) → tie, +50¢ = $10.49.
    expect(computeMinValidBid(999, 100)).toBe(999 + 50);
  });

  it('uses 5% when it exceeds 50¢', () => {
    // Current $20: 5% = $1 → +$1 = $21.
    expect(computeMinValidBid(2000, 100)).toBe(2100);
    // Current $100: 5% = $5 → +$5 = $105.
    expect(computeMinValidBid(10_000, 100)).toBe(10_500);
  });

  it('5% rounds up so the platform never accepts a fractional-cent shortfall', () => {
    // Current $19.99: 5% = 99.95¢ → ceil 100¢. min = 1999 + 100 = 2099.
    expect(computeMinValidBid(1999, 100)).toBe(2099);
  });
});

describe('validateBid', () => {
  it('accepts a bid exactly at the minimum', () => {
    expect(validateBid(2000, 100, 2100)).toEqual({ ok: true });
  });

  it('rejects one cent below the minimum as TOO_LOW', () => {
    expect(validateBid(2000, 100, 2099)).toEqual({ ok: false, reason: 'TOO_LOW' });
  });

  it('rejects bids below the starting bid for the first bid', () => {
    expect(validateBid(null, 500, 499)).toEqual({ ok: false, reason: 'TOO_LOW' });
    expect(validateBid(null, 500, 500)).toEqual({ ok: true });
  });

  it('flags 100x-baseline as TOO_HIGH (fat-finger guard)', () => {
    // Baseline 1000 cents ($10). 100x = 100,000 ($1,000). 100,001 = TOO_HIGH.
    expect(validateBid(1000, 100, 100_000)).toEqual({ ok: true });
    expect(validateBid(1000, 100, 100_001)).toEqual({ ok: false, reason: 'TOO_HIGH' });
  });

  it('uses startingBid as baseline for fat-finger when no current bid', () => {
    expect(validateBid(null, 500, 50_000)).toEqual({ ok: true });
    expect(validateBid(null, 500, 50_001)).toEqual({ ok: false, reason: 'TOO_HIGH' });
  });
});
