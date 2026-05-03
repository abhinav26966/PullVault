import Decimal from 'decimal.js';

/**
 * All money in this system is integer cents on the wire and in storage.
 * decimal.js is used only at the boundary — never inside transactions and
 * never in arithmetic across rows. See ARCHITECTURE §11.
 */

export function toCents(dollars: string | number): number {
  return new Decimal(dollars).mul(100).round().toNumber();
}

export function fromCents(cents: number): string {
  return new Decimal(cents).div(100).toFixed(2);
}

export function formatUSD(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  return `${negative ? '-' : ''}$${fromCents(abs)}`;
}
