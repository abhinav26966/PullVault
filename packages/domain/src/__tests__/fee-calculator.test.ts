import { describe, expect, it } from 'vitest';
import { calculateAuctionFee, calculateTradeFee } from '../fee-calculator';

describe('calculateTradeFee — 3% with ceil-rounding', () => {
  it.each([
    [0, 0],
    [100, 3],
    [500, 15],
    [501, 16], // 501 * 3% = 15.03 → ceil 16
    [999, 30],
    [1000, 30],
    [1499, 45],
    [10_000, 300],
  ])('saleCents=%i → fee=%i', (sale, expected) => {
    expect(calculateTradeFee(sale)).toBe(expected);
  });

  it('rounds toward the platform (never undercuts)', () => {
    // 333 * 3% = 9.99 → ceil 10. Buyer/seller eats the fractional cent.
    expect(calculateTradeFee(333)).toBe(10);
  });

  it('rejects negative input', () => {
    expect(() => calculateTradeFee(-1)).toThrow();
  });
});

describe('calculateAuctionFee — 5% with ceil-rounding', () => {
  it.each([
    [0, 0],
    [100, 5],
    [101, 6], // 101 * 5% = 5.05 → ceil 6
    [500, 25],
    [1000, 50],
    [9999, 500],
    [10_000, 500],
  ])('winningBidCents=%i → fee=%i', (bid, expected) => {
    expect(calculateAuctionFee(bid)).toBe(expected);
  });

  it('rejects negative input', () => {
    expect(() => calculateAuctionFee(-1)).toThrow();
  });
});
