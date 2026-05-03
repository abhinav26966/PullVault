import { describe, expect, it } from 'vitest';
import { formatUSD, fromCents, toCents } from '../money';

describe('toCents', () => {
  it.each([
    ['0', 0],
    ['0.00', 0],
    ['0.01', 1],
    ['0.99', 99],
    ['1', 100],
    ['1.00', 100],
    ['4.99', 499],
    ['14.99', 1499],
    ['49.99', 4999],
    ['1000', 100_000],
    ['12345.67', 1_234_567],
  ])('"%s" → %i', (input, expected) => {
    expect(toCents(input)).toBe(expected);
  });

  it('accepts numeric input', () => {
    expect(toCents(4.99)).toBe(499);
    expect(toCents(0.01)).toBe(1);
  });

  it('rounds at the half-cent boundary (half-up)', () => {
    // decimal.js .round() defaults to ROUND_HALF_UP (away from zero on .5),
    // matching JS Math.round on positives. Consistent with the price pipeline.
    expect(toCents('0.005')).toBe(1);
    expect(toCents('0.015')).toBe(2);
    expect(toCents('0.014')).toBe(1);
  });
});

describe('fromCents', () => {
  it.each([
    [0, '0.00'],
    [1, '0.01'],
    [99, '0.99'],
    [100, '1.00'],
    [499, '4.99'],
    [123_456_789, '1234567.89'],
  ])('%i → "%s"', (input, expected) => {
    expect(fromCents(input)).toBe(expected);
  });
});

describe('formatUSD', () => {
  it('formats positive values with $ prefix', () => {
    expect(formatUSD(499)).toBe('$4.99');
    expect(formatUSD(0)).toBe('$0.00');
    expect(formatUSD(100_000)).toBe('$1000.00');
  });

  it('formats negatives with leading minus', () => {
    expect(formatUSD(-100)).toBe('-$1.00');
    expect(formatUSD(-1)).toBe('-$0.01');
  });
});
