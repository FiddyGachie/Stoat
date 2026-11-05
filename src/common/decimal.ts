import { Decimal } from 'decimal.js';

export function toDecimalString(val: string | number | Decimal, precision: number = 6): string {
  const d = new Decimal(val);
  return d.toFixed(precision);
}

export function parseDecimal(val: string | number | Decimal): Decimal {
  try {
    const d = new Decimal(val);
    if (!d.isFinite()) {
      throw new Error('Not finite');
    }
    return d;
  } catch {
    throw new Error(`Invalid decimal value: ${val}`);
  }
}

export function validateAmount(val: string): boolean {
  return /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(val);
}

export function addDecimals(a: string | number | Decimal, b: string | number | Decimal, precision: number = 6): string {
  const da = new Decimal(a);
  const db = new Decimal(b);
  return da.plus(db).toFixed(precision);
}

export function subDecimals(a: string | number | Decimal, b: string | number | Decimal, precision: number = 6): string {
  const da = new Decimal(a);
  const db = new Decimal(b);
  return da.minus(db).toFixed(precision);
}

export function mulDecimals(a: string | number | Decimal, b: string | number | Decimal, precision: number = 6): string {
  const da = new Decimal(a);
  const db = new Decimal(b);
  return da.times(db).toFixed(precision);
}

export function equalsDecimals(a: string | number | Decimal, b: string | number | Decimal): boolean {
  return new Decimal(a).equals(new Decimal(b));
}
