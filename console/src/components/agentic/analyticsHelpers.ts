/**
 * Pure helpers for the Payments Analytics workspace. No React, no money arithmetic: amounts are
 * server decimal strings and are only ever passed through. Property tests import this file.
 */

/** A grid panel shows at most this many rows (R11.6, R11.13). */
export const ROW_LIMIT = 10_000;

export interface Filters {
  /** UTC dates, YYYY-MM-DD. */
  from: string;
  to: string;
  currency: string;
  agent: string;
  mandate: string;
  provider: string;
}

/** What a chart element or grid row can narrow the other panels by. */
export type Dimension = "mandate" | "agent" | "provider" | "category" | "day";

export interface Selection {
  dimension: Dimension;
  value: string;
  /** The panel the selection came from. That panel is not narrowed by its own selection. */
  source: string;
  /** Title of the source panel, for the chip label. */
  sourceLabel?: string;
}

export interface Snapshot {
  filters: Filters;
  selections: Selection[];
}

export interface AnalyticsState extends Snapshot {
  /** State captured when the first selection was made; Clear restores it. */
  saved: Snapshot | null;
}

export type AnalyticsAction =
  | { type: "set_filters"; filters: Partial<Filters> }
  | { type: "select"; selection: Selection }
  | { type: "clear" };

const DAY_MS = 86_400_000;

/** The last 30 UTC days ending today. Calendar arithmetic on dates only. */
export function defaultRange(now: Date = new Date()): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS).toISOString().slice(0, 10);
  return { from, to };
}

export function initialState(now: Date = new Date()): AnalyticsState {
  const { from, to } = defaultRange(now);
  return {
    filters: { from, to, currency: "", agent: "", mandate: "", provider: "" },
    selections: [],
    saved: null,
  };
}

/**
 * One reducer for filters and cross-filter selections. The first selection saves the state it
 * came from; Clear restores that state exactly. A new selection on a dimension replaces the old
 * one for that dimension.
 */
export function analyticsReducer(state: AnalyticsState, action: AnalyticsAction): AnalyticsState {
  switch (action.type) {
    case "set_filters":
      return { ...state, filters: { ...state.filters, ...action.filters } };
    case "select": {
      const saved = state.saved ?? { filters: state.filters, selections: state.selections };
      const others = state.selections.filter((s) => s.dimension !== action.selection.dimension);
      return { ...state, saved, selections: [...others, action.selection] };
    }
    case "clear":
      if (state.saved) return { filters: state.saved.filters, selections: state.saved.selections, saved: null };
      return { ...state, selections: [] };
  }
}

const DIMENSION_NAME: Record<Dimension, string> = {
  mandate: "Mandate",
  agent: "Agent",
  provider: "Provider",
  category: "Category",
  day: "UTC day",
};

/** A labelled item per active selection (R11.4). */
export function selectionChips(selections: readonly Selection[]): Array<{ key: string; label: string }> {
  return selections.map((s) => ({
    key: s.dimension,
    label: `${DIMENSION_NAME[s.dimension]}: ${s.value}${s.sourceLabel ? ` (selected in ${s.sourceLabel})` : ""}`,
  }));
}

/** Filters as one panel sees them: the bar filters plus every selection that did not come from it. */
export interface EffectiveFilters extends Filters {
  category: string;
}

export function effectiveFilters(state: Snapshot, panelId: string): EffectiveFilters {
  const eff: EffectiveFilters = { ...state.filters, category: "" };
  for (const s of state.selections) {
    if (s.source === panelId) continue;
    if (s.dimension === "day") {
      eff.from = s.value;
      eff.to = s.value;
    } else eff[s.dimension] = s.value;
  }
  return eff;
}

/** Query parameters for one panel. Empty values are omitted. */
export function queryParams(eff: EffectiveFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(eff)) if (v) out[k] = v;
  return out;
}

/** Every active filter as `Name: value`, in a fixed order. The date range is always active. */
export function activeFilterLabels(eff: EffectiveFilters): string[] {
  const out = [`Date range: ${eff.from || "unset"} to ${eff.to || "unset"}`];
  if (eff.currency) out.push(`Currency: ${eff.currency}`);
  if (eff.agent) out.push(`Agent: ${eff.agent}`);
  if (eff.mandate) out.push(`Mandate: ${eff.mandate}`);
  if (eff.provider) out.push(`Provider: ${eff.provider}`);
  if (eff.category) out.push(`Category: ${eff.category}`);
  return out;
}

/** The empty-state text: names each active filter and shows 0 for the total (R11.8). */
export function emptyStateText(eff: EffectiveFilters): { message: string; total: string } {
  return {
    message: `No data for ${activeFilterLabels(eff).join("; ")}.`,
    total: "Total: 0",
  };
}

/** Column of a row that holds each filterable dimension, for one panel. */
export type FieldMap = Partial<Record<"currency" | "agent" | "mandate" | "provider" | "category", string>>;

/** Rows that match every active filter this panel has a field for. Exact string match, no maths. */
export function applyRowFilters<T extends Record<string, unknown>>(
  rows: readonly T[],
  eff: EffectiveFilters,
  fields: FieldMap,
): T[] {
  const checks = (Object.keys(fields) as Array<keyof FieldMap>)
    .filter((k) => eff[k])
    .map((k) => [fields[k] as string, eff[k]] as const);
  if (checks.length === 0) return [...rows];
  return rows.filter((r) => checks.every(([field, want]) => String(r[field] ?? "") === want));
}

/** Active filters this panel cannot narrow, so it can say so instead of silently ignoring them. */
export function unappliedFilters(eff: EffectiveFilters, fields: FieldMap): string[] {
  const names: Array<[keyof FieldMap, string]> = [
    ["currency", "Currency"],
    ["agent", "Agent"],
    ["mandate", "Mandate"],
    ["provider", "Provider"],
    ["category", "Category"],
  ];
  return names.filter(([k]) => eff[k] && !fields[k]).map(([, n]) => n);
}

export interface Truncated<T> {
  rows: T[];
  truncated: boolean;
  total: number;
}

/**
 * First `limit` rows. `serverTotal` is the row count the server reported; the total is never
 * smaller than the rows received. Truncated when rows were cut here or by the server.
 */
export function truncateRows<T>(
  rows: readonly T[],
  serverTotal?: number,
  serverTruncated = false,
  limit: number = ROW_LIMIT,
): Truncated<T> {
  const total = Math.max(rows.length, typeof serverTotal === "number" && Number.isFinite(serverTotal) ? serverTotal : 0);
  return {
    rows: rows.length > limit ? rows.slice(0, limit) : [...rows],
    truncated: rows.length > limit || serverTruncated || total > limit,
    total,
  };
}

export function truncationNotice(total: number, limit: number = ROW_LIMIT): string {
  return `Showing the first ${limit.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} rows. The display is truncated.`;
}

/** `sandbox` or `live` as the server returned it; anything else, or nothing, is `unknown` (R11.12). */
export function environmentLabel(value: unknown): string {
  return value === "sandbox" || value === "live" ? value : "unknown";
}

/** A fee as text. A fee PayPal did not report is "unknown", never 0 (R10.6). */
export function feeText(amount: string | null | undefined, state: string | null | undefined, currency: string): string {
  if (amount === null || amount === undefined || amount === "" || state === "unknown") return "unknown";
  return state === "partial" ? `${amount} ${currency} (some fees unknown)` : `${amount} ${currency}`;
}

/** "CODE: message" so a panel can show the Stoat error code. */
export function errorWithCode(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? `${code}: ${message}` : message;
}

/** The error code at the start of an `errorWithCode` string, or `UNKNOWN`. */
export function errorCode(text: string): string {
  const m = /^([A-Z][A-Z0-9_]+):/.exec(text);
  return m ? m[1]! : "UNKNOWN";
}

/** Chart points kept after the currency filter and, for the chart's own dimension, its filter. */
export function filterChartGroups<G extends { currency: string | null; points: Array<{ x: string; y: string }> }>(
  groups: readonly G[],
  currency: string,
  ownValue: string,
): G[] {
  return groups
    .filter((g) => !currency || g.currency === currency)
    .map((g) => ({ ...g, points: ownValue ? g.points.filter((p) => p.x === ownValue) : g.points }))
    .filter((g) => g.points.length > 0);
}
