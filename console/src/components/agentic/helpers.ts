/**
 * Pure helpers for the agentic shared components. No React here, so tests can import them directly.
 */
import { Decimal } from "decimal.js";

/** Column fields that would expose a payout destination. The Console never shows these (R11.5). */
export const FORBIDDEN_COLUMN_FIELD = /recipient|payee|email/i;

/** The field names of a column list, including nested column groups. */
function fieldsOf(cols: ReadonlyArray<{ field?: unknown; children?: unknown }>): string[] {
  const out: string[] = [];
  for (const c of cols) {
    if (typeof c.field === "string") out.push(c.field);
    if (Array.isArray(c.children)) out.push(...fieldsOf(c.children));
  }
  return out;
}

/** Field names that match the forbidden pattern. */
export function forbiddenColumnFields(cols: ReadonlyArray<{ field?: unknown; children?: unknown }>): string[] {
  return fieldsOf(cols).filter((f) => FORBIDDEN_COLUMN_FIELD.test(f));
}

const isDevBuild = (): boolean => {
  const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  return env?.DEV === true;
};

/** Throws in development when a column field matches /recipient|payee|email/i. No-op in production. */
export function assertNoPayeeColumns(
  cols: ReadonlyArray<{ field?: unknown; children?: unknown }>,
  dev: boolean = isDevBuild(),
): void {
  if (!dev) return;
  const bad = forbiddenColumnFields(cols);
  if (bad.length > 0) {
    throw new Error(`VirtualGridPanel: column field(s) ${bad.join(", ")} match /recipient|payee|email/i and may not be shown`);
  }
}

/**
 * Fraction of a cap that is used, as clamp(used / cap, 0, 1). A missing, invalid or non-positive
 * cap gives 0. Inputs are server decimal strings.
 */
export function utilization(used: string | null | undefined, cap: string | null | undefined): number {
  try {
    if (used === null || used === undefined || used === "" || cap === null || cap === undefined || cap === "") return 0;
    const c = new Decimal(cap);
    if (!c.isFinite() || c.lte(0)) return 0;
    const u = new Decimal(used);
    if (!u.isFinite()) return 0;
    const r = u.div(c);
    if (r.lte(0)) return 0;
    if (r.gte(1)) return 1;
    return r.toNumber();
  } catch {
    return 0;
  }
}

/** One plotted point. `value` is the server's decimal string and is shown verbatim in the table. */
export interface ChartPoint {
  label: string;
  value: string;
}

/** Group points by currency, keeping the order each currency first appears. */
export function groupByCurrency<T extends { currency: string }>(rows: readonly T[]): Array<{ currency: string; rows: T[] }> {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const list = map.get(r.currency);
    if (list) list.push(r);
    else map.set(r.currency, [r]);
  }
  return [...map.entries()].map(([currency, list]) => ({ currency, rows: list }));
}
