/**
 * Mission Budget Wallet: pure money helpers.
 *
 * No I/O, no database, no clock (callers pass `now`). Amounts cross every
 * boundary as decimal strings and are computed with decimal.js, never with
 * binary floating point. Property tests target this file.
 */
import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';

// Isolated Decimal constructor: generous precision, no global config mutation.
const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_DOWN });

export type DecimalLike = string | Decimal;

export const MAX_FRACTION_DIGITS = 6;
export const MAX_AMOUNT = '999999999.999999';
const AMOUNT_RE = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;
const MAX_AMOUNT_D = new D(MAX_AMOUNT);

/** PayPal minor units per currency (digits after the decimal point). */
const MINOR_UNITS: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  JPY: 0,
};

const dec = (v: DecimalLike): Decimal => (typeof v === 'string' ? new D(v) : new D(v));

// ---------------------------------------------------------------------------
// Parsing and formatting
// ---------------------------------------------------------------------------

export type MoneyErrorReason =
  | 'NOT_A_STRING'
  | 'MALFORMED'
  | 'TOO_MANY_FRACTION_DIGITS'
  | 'EXCEEDS_MAXIMUM'
  | 'NOT_POSITIVE'
  | 'EXCEEDS_MINOR_UNITS';

export type MoneyParse =
  | { ok: true; value: string; decimal: Decimal }
  | { ok: false; reason: MoneyErrorReason };

export interface ParseMoneyOptions {
  /** Require the amount to be greater than zero (default false: zero allowed). */
  positive?: boolean;
  /** Currency whose PayPal minor units cap the fraction digits (when headed to PayPal). */
  currency?: string;
}

/**
 * Accepts exactly: a non-negative decimal string, at most six fractional digits,
 * at most 999,999,999.999999, optionally > 0 and within the currency's minor units.
 * Numbers, whitespace, signs, exponents and locale separators are all rejected.
 */
export function parseMoney(input: unknown, opts: ParseMoneyOptions = {}): MoneyParse {
  if (typeof input !== 'string') return { ok: false, reason: 'NOT_A_STRING' };
  if (!AMOUNT_RE.test(input)) {
    // Distinguish the "too many digits" case for a clearer error.
    if (/^(0|[1-9][0-9]*)\.[0-9]{7,}$/.test(input)) {
      return { ok: false, reason: 'TOO_MANY_FRACTION_DIGITS' };
    }
    return { ok: false, reason: 'MALFORMED' };
  }
  const d = new D(input);
  if (d.gt(MAX_AMOUNT_D)) return { ok: false, reason: 'EXCEEDS_MAXIMUM' };
  if (opts.positive && !d.gt(0)) return { ok: false, reason: 'NOT_POSITIVE' };
  if (opts.currency !== undefined) {
    const digits = minorUnits(opts.currency);
    if (d.decimalPlaces() > digits) return { ok: false, reason: 'EXCEEDS_MINOR_UNITS' };
  }
  return { ok: true, value: formatMoney(d), decimal: d };
}

/**
 * Canonical string: no exponent, no trailing zeros. `minFractionDigits` pads for display
 * (for example 2 for USD). `parseMoney(formatMoney(x))` equals `x` numerically.
 */
export function formatMoney(value: DecimalLike, minFractionDigits = 0): string {
  const d = dec(value);
  const digits = Math.min(MAX_FRACTION_DIGITS, Math.max(0, minFractionDigits));
  const plain = d.toFixed(); // never exponent notation
  if (digits === 0) return plain;
  const places = Math.max(d.decimalPlaces(), digits);
  return d.toFixed(places);
}

/** Number of PayPal minor-unit digits for a currency. Unknown currencies are an error. */
export function minorUnits(currency: string): number {
  const digits = MINOR_UNITS[String(currency).toUpperCase()];
  if (digits === undefined) throw new RangeError(`Unsupported currency: ${currency}`);
  return digits;
}

/** Round DOWN to the currency's minor units (or an explicit digit count). */
export function roundDownToMinorUnits(amount: DecimalLike, currencyOrDigits: string | number): string {
  const digits = typeof currencyOrDigits === 'number' ? currencyOrDigits : minorUnits(currencyOrDigits);
  return dec(amount).toDecimalPlaces(digits, Decimal.ROUND_DOWN).toFixed();
}

/** Exact sum of decimal strings. */
export function sumMoney(values: readonly DecimalLike[]): string {
  return values.reduce<Decimal>((acc, v) => acc.plus(dec(v)), new D(0)).toFixed();
}

// ---------------------------------------------------------------------------
// Balances and mission funding
// ---------------------------------------------------------------------------

/** Available_Balance = Wallet_Balance - active Reservations - Pending_Refund. */
export function computeAvailable(
  balance: DecimalLike,
  activeReservations: readonly DecimalLike[],
  pendingRefunds: readonly DecimalLike[] = [],
): string {
  return dec(balance).minus(sumMoney(activeReservations)).minus(sumMoney(pendingRefunds)).toFixed();
}

export interface UnreservedFundingInput {
  budget: DecimalLike;
  charges: DecimalLike;
  activeReservations: DecimalLike;
  available: DecimalLike;
}

/**
 * Reachable funding: min(Mission_Budget - Charges - active Reservations, Available_Balance).
 * Not floored, so callers can tell "exactly zero" from "overdrawn". Use `floorAtZero` for display.
 */
export function unreservedFunding(input: UnreservedFundingInput): string {
  const headroom = dec(input.budget).minus(dec(input.charges)).minus(dec(input.activeReservations));
  return D.min(headroom, dec(input.available)).toFixed();
}

export function floorAtZero(value: DecimalLike): string {
  return D.max(dec(value), 0).toFixed();
}

/**
 * True when reachable funding is above zero and at most `thresholdPct` percent of the budget.
 */
export function lowBalanceReached(funding: DecimalLike, budget: DecimalLike, thresholdPct: number | string): boolean {
  const f = dec(funding);
  const b = dec(budget);
  if (!f.gt(0) || !b.gt(0)) return false;
  return f.lte(b.times(new D(thresholdPct)).div(100));
}

export type MissionFundingStateName = 'active' | 'depleted' | 'awaiting_decision' | 'closed';

export interface MissionFundingInput {
  budget: DecimalLike;
  charges: DecimalLike;
  activeReservations: DecimalLike;
  available: DecimalLike;
  completed: boolean;
  remainder: DecimalLike;
  /** Keep decision recorded, or every refund item completed. */
  decisionFinal?: boolean;
  unresolvedLowBalance: boolean;
  thresholdPct: number | string;
}

export interface MissionFundingResult {
  state: MissionFundingStateName;
  funding: string;
  /** Create one low_balance notification. */
  requestLowBalance: boolean;
  /** Resolve the open low_balance notification. */
  resolveLowBalance: boolean;
  /** max(0, Mission_Budget - Available_Balance) */
  shortfall: string;
}

export function missionFundingState(input: MissionFundingInput): MissionFundingResult {
  const funding = unreservedFunding(input);
  const fundingD = new D(funding);
  const low = lowBalanceReached(funding, input.budget, input.thresholdPct);
  const shortfall = floorAtZero(dec(input.budget).minus(dec(input.available)));

  let state: MissionFundingStateName;
  if (input.completed) {
    state = input.decisionFinal || !dec(input.remainder).gt(0) ? 'closed' : 'awaiting_decision';
  } else {
    state = fundingD.lte(0) ? 'depleted' : 'active';
  }

  return {
    state,
    funding,
    requestLowBalance: !input.completed && low && !input.unresolvedLowBalance,
    // Resolved once funding rises above the threshold (also when the mission is over).
    resolveLowBalance: input.unresolvedLowBalance && (input.completed || (fundingD.gt(0) && !low)),
    shortfall,
  };
}

// ---------------------------------------------------------------------------
// Refund planning
// ---------------------------------------------------------------------------

export interface RefundCapture {
  depositId: string;
  captureId: string;
  capturedAt: Date;
  /** Captured amount not yet refunded (decimal string). */
  unrefunded: string;
}

export interface RefundPlanItem {
  depositId: string;
  captureId: string;
  amount: string;
}

export type RefundPlan =
  | { ok: true; items: RefundPlanItem[] }
  | {
      ok: false;
      code: 'REFUND_EXCEEDS_CAPTURES' | 'INVALID_AMOUNT';
      items: [];
      details: { requested: string; eligible: string; excluded_for_age: string };
    };

const DAY_MS = 86_400_000;

/**
 * Greedy oldest-first allocation over captures inside the refund window.
 * Success: item amounts sum to `amount` exactly and no item exceeds its capture's unrefunded amount.
 * Not enough eligible capacity: REFUND_EXCEEDS_CAPTURES with no items.
 */
export function planRefund(
  captures: readonly RefundCapture[],
  amount: DecimalLike,
  now: Date,
  windowDays: number,
): RefundPlan {
  const requested = dec(amount);
  const cutoff = now.getTime() - windowDays * DAY_MS;

  let eligibleTotal = new D(0);
  let excludedForAge = new D(0);
  const eligible: RefundCapture[] = [];
  for (const c of captures) {
    const open = new D(c.unrefunded);
    if (!open.gt(0)) continue;
    if (c.capturedAt.getTime() < cutoff) {
      excludedForAge = excludedForAge.plus(open);
      continue;
    }
    eligible.push(c);
    eligibleTotal = eligibleTotal.plus(open);
  }

  const details = {
    requested: requested.toFixed(),
    eligible: eligibleTotal.toFixed(),
    excluded_for_age: excludedForAge.toFixed(),
  };

  if (!requested.gt(0)) return { ok: false, code: 'INVALID_AMOUNT', items: [], details };
  if (requested.gt(eligibleTotal)) return { ok: false, code: 'REFUND_EXCEEDS_CAPTURES', items: [], details };

  eligible.sort((a, b) => {
    const dt = a.capturedAt.getTime() - b.capturedAt.getTime();
    if (dt !== 0) return dt;
    return a.depositId < b.depositId ? -1 : a.depositId > b.depositId ? 1 : 0;
  });

  const items: RefundPlanItem[] = [];
  let remaining = requested;
  for (const c of eligible) {
    if (!remaining.gt(0)) break;
    const take = D.min(remaining, new D(c.unrefunded));
    items.push({ depositId: c.depositId, captureId: c.captureId, amount: take.toFixed() });
    remaining = remaining.minus(take);
  }
  return { ok: true, items };
}

// ---------------------------------------------------------------------------
// Deterministic request IDs
// ---------------------------------------------------------------------------

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** 'wallet-dep-' + first 32 hex of sha256(tenant:owner:idempotencyKey) (R2.9). */
export function deriveDepositRequestId(tenantId: string, ownerUserId: string, idempotencyKey: string): string {
  return `wallet-dep-${sha256Hex(`${tenantId}:${ownerUserId}:${idempotencyKey}`).slice(0, 32)}`;
}

/** 'wallet-rfd-' + first 32 hex of sha256(groupId:captureId) (R8.6). */
export function deriveRefundRequestId(groupId: string, captureId: string): string {
  return `wallet-rfd-${sha256Hex(`${groupId}:${captureId}`).slice(0, 32)}`;
}

/** Hash stored with a deposit to detect Idempotency-Key reuse with different parameters. */
export function depositRequestHash(amount: string, currency: string, missionId: string | null | undefined): string {
  return sha256Hex(`${amount}|${currency}|${missionId ?? ''}`);
}

export type RequestIdInput =
  | { kind: 'deposit'; tenantId: string; ownerUserId: string; idempotencyKey: string }
  | { kind: 'refund'; groupId: string; captureId: string };

export function deriveRequestId(input: RequestIdInput): string {
  return input.kind === 'deposit'
    ? deriveDepositRequestId(input.tenantId, input.ownerUserId, input.idempotencyKey)
    : deriveRefundRequestId(input.groupId, input.captureId);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Neutralizes spreadsheet formula injection: a cell whose first character is
 * '=', '+', '-' or '@' is prefixed with a single quote (R14.5).
 */
export function csvSafeCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

/** RFC 4180 quoting for a cell already made safe with `csvSafeCell`. */
export function csvEscape(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}
