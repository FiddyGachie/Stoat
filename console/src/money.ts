/**
 * Decimal money helpers for the console (R15.1, R15.15).
 *
 * Amounts travel as decimal strings. Nothing here uses JavaScript `number` arithmetic, so a sum of
 * 0.10 and 0.20 is exactly 0.30. Display only: the server stays the authority on every figure.
 */
import { Decimal } from "decimal.js";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** Up to 12 integer digits and at most two decimal places. */
const AMOUNT_RE = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;

const toDecimal = (v: string | number | null | undefined): Decimal => {
  if (v === null || v === undefined || v === "") return new D(0);
  try {
    return new D(v);
  } catch {
    return new D(0);
  }
};

/** True when `v` is a positive amount with at most two decimal places. */
export function isValidAmount(v: string): boolean {
  const t = v.trim();
  return AMOUNT_RE.test(t) && new D(t).gt(0);
}

/** Default per-Deposit maximum (R2.2). The server stays the authority. */
export const MAX_DEPOSIT_AMOUNT = "10000.00";

/**
 * Client-side check for an Add funds amount (R15.5). Returns a field error message, or null when
 * the amount may be sent. Covers empty, zero, negative, not a decimal, too many fractional digits
 * and above the maximum.
 */
export function validateDepositAmount(
  raw: string,
  max: string = MAX_DEPOSIT_AMOUNT,
): string | null {
  const t = raw.trim();
  if (t === "") return "Enter an amount.";
  if (!/^-?\d+(?:\.\d*)?$|^-?\.\d+$/.test(t))
    return "Enter a number such as 25.00.";
  if (t.startsWith("-")) return "The amount must be greater than 0.";
  if (!/^\d+(?:\.\d{0,2})?$|^\.\d{1,2}$/.test(t))
    return "Use at most 2 decimal places.";
  const d = new D(t);
  if (d.lte(0)) return "The amount must be greater than 0.";
  if (d.gt(new D(max)))
    return `The most you can add at once is ${formatAmount(max)}.`;
  return null;
}

/** Format as a fixed two-place decimal string. Invalid input becomes `0.00`. */
export function formatAmount(v: string | null | undefined): string {
  return toDecimal(v).toFixed(2, Decimal.ROUND_HALF_UP);
}

export function add(...values: Array<string | null | undefined>): string {
  return values
    .reduce<Decimal>((acc, v) => acc.plus(toDecimal(v)), new D(0))
    .toFixed(2);
}

export function subtract(
  a: string | null | undefined,
  b: string | null | undefined,
): string {
  return toDecimal(a).minus(toDecimal(b)).toFixed(2);
}

/** Negative when a is less than b, zero when equal, positive otherwise. */
export function compare(
  a: string | null | undefined,
  b: string | null | undefined,
): -1 | 0 | 1 {
  return toDecimal(a).comparedTo(toDecimal(b)) as -1 | 0 | 1;
}

export const isPositive = (v: string | null | undefined): boolean =>
  toDecimal(v).gt(0);
export const isZero = (v: string | null | undefined): boolean =>
  toDecimal(v).isZero();

/** What is missing to cover `budget` from `available`: `0.00` when nothing is missing. */
export function shortfall(
  budget: string | null | undefined,
  available: string | null | undefined,
): string {
  const d = toDecimal(budget).minus(toDecimal(available));
  return d.gt(0) ? d.toFixed(2) : "0.00";
}

/** Amount with its currency code, for example `12.50 USD`. */
export const formatMoney = (
  v: string | null | undefined,
  currency: string,
): string => `${formatAmount(v)} ${currency}`;
