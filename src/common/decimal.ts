import { Decimal } from 'decimal.js';

export function toDecimalString(val: string | number | Decimal, precision: number = 6): string {
  const d = new Decimal(val);
  return d.toFixed(precision);
}

export function validateAmount(val: string): boolean {
  return /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(val);
}

export function addDecimals(a: string | number | Decimal, b: string | number | Decimal, precision: number = 6): string {
  const da = new Decimal(a);
  const db = new Decimal(b);
  return da.plus(db).toFixed(precision);
}

export function equalsDecimals(a: string | number | Decimal, b: string | number | Decimal): boolean {
  return new Decimal(a).equals(new Decimal(b));
}
