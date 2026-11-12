/**
 * Pure helpers for the wallet Activity grids and charts (R14.1 to R14.12).
 *
 * No React and no network here. Money stays a decimal string; `Number` is used only to plot a
 * chart (R14.3).
 */
import { compare, formatAmount } from "./money.js";

export interface AnalyticsColumn {
  name: string;
  type: "string" | "money" | "timestamp" | "integer";
}
export type AnalyticsRow = Record<string, string | null>;

export interface DatasetDef {
  id: string;
  label: string;
  /** Next action offered when the dataset has no rows. */
  empty: { text: string; action: string; target: string };
}

/** Datasets in display order. `id` is the server path segment. */
export const DATASETS: DatasetDef[] = [
  { id: "deposits", label: "Deposits", empty: { text: "No deposits yet.", action: "Add funds", target: "wallet-add-funds" } },
  { id: "reservations", label: "Reservations", empty: { text: "No reservations yet.", action: "Open Missions", target: "wallet-missions" } },
  { id: "charges", label: "Charges", empty: { text: "No charges yet.", action: "Open Missions", target: "wallet-missions" } },
  { id: "refunds", label: "Refunds", empty: { text: "No refunds yet.", action: "Open Missions", target: "wallet-missions" } },
  { id: "payouts", label: "Payouts", empty: { text: "No payouts yet.", action: "Open Missions", target: "wallet-missions" } },
  { id: "notifications", label: "Notifications", empty: { text: "No notifications yet.", action: "Add funds", target: "wallet-add-funds" } },
  { id: "reconciliation-exceptions", label: "Reconciliation exceptions", empty: { text: "No reconciliation exceptions.", action: "Open Business account", target: "#/business-account" } },
  { id: "ledger-lines", label: "Ledger lines", empty: { text: "No ledger lines yet.", action: "Add funds", target: "wallet-add-funds" } },
  { id: "statements", label: "Statements", empty: { text: "No statement lines yet.", action: "Add funds", target: "wallet-add-funds" } },
];

export const PAGE_SIZE = 500;
/** Row detail must appear within this time (R14.4). */
export const DETAIL_TIMEOUT_MS = 2_000;
/** A grid or chart request that takes longer than this is shown as an error (R14.10). */
export const ANALYTICS_TIMEOUT_MS = 10_000;

/** "created_at" becomes "Created at". */
export const columnLabel = (name: string): string => {
  const s = name.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Other pages are appended; a row already shown is not repeated. */
export function appendPage(current: AnalyticsRow[], next: AnalyticsRow[]): AnalyticsRow[] {
  const seen = new Set(current.map((r) => r.id));
  return [...current, ...next.filter((r) => !seen.has(r.id))];
}

/** Columns the person has hidden are not drawn. */
export function visibleColumns(cols: AnalyticsColumn[], hidden: ReadonlySet<string>): AnalyticsColumn[] {
  return cols.filter((c) => !hidden.has(c.name));
}

export interface PaypalId {
  label: string;
  value: string;
}

/** PayPal identifiers carried by a row, in column order. Empty when the row has none. */
export function paypalIds(row: AnalyticsRow): PaypalId[] {
  const out: PaypalId[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === "") continue;
    if (k === "paypal_environment") continue;
    if (k === "paypal_refund_ids") {
      for (const part of v.split(";")) if (part) out.push({ label: "PayPal refund ID", value: part });
    } else if (k.startsWith("paypal_") || k === "provider_batch_id" || k === "provider_item_id") {
      out.push({ label: columnLabel(k.replace(/^provider_/, "paypal_")), value: v });
    }
  }
  return out;
}

export type EventEntity = { entity_type: "wallet" | "deposit" | "mission"; entity_id: string };

/** The record whose event history belongs to a row, or null when the dataset has none. */
export function eventEntity(dataset: string, row: AnalyticsRow): EventEntity | null {
  if (dataset === "deposits" && row.id) return { entity_type: "deposit", entity_id: row.id };
  if (row.mission_id) return { entity_type: "mission", entity_id: row.mission_id };
  if (row.wallet_id) return { entity_type: "wallet", entity_id: row.wallet_id };
  return null;
}

/** Ledger lines that belong to a row: same transaction, or a reference naming the row. */
export function relatedLedger(dataset: string, row: AnalyticsRow, lines: AnalyticsRow[]): AnalyticsRow[] {
  if (dataset === "ledger-lines") {
    return lines.filter((l) => l.transaction_id === row.transaction_id);
  }
  if (dataset === "statements") {
    return lines.filter((l) => l.reference !== null && l.reference === row.reference);
  }
  if (!row.id) return [];
  return lines.filter((l) => l.reference !== null && l.reference.includes(row.id as string));
}

/** Cell text for a column: money as two decimals, empty as an en dash. */
export function cellText(col: AnalyticsColumn, v: string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "–";
  return col.type === "money" ? formatAmount(v) : v;
}

/** Sort for money columns compares decimals, never floats. */
export const moneyComparator = (a: string | null, b: string | null): number => compare(a, b);

/** Spreadsheet-safe filename for a downloaded CSV. */
export const csvFileName = (dataset: string): string => `wallet-${dataset}.csv`;

/* ── Charts ── */

export interface ChartDef {
  id: string;
  title: string;
  kind: "line" | "bar" | "donut";
  /** Columns of the data-table equivalent. */
  table: string[];
  emptyAction: { text: string; action: string; target: string };
}

export const CHARTS: ChartDef[] = [
  { id: "balance-over-time", title: "Wallet balance over time", kind: "line", table: ["date", "currency", "balance"], emptyAction: { text: "No balance history yet.", action: "Add funds", target: "wallet-add-funds" } },
  { id: "flows-per-day", title: "Deposits and refunds per day", kind: "bar", table: ["date", "currency", "deposits", "refunds"], emptyAction: { text: "No deposits or refunds yet.", action: "Add funds", target: "wallet-add-funds" } },
  { id: "charges-per-mission", title: "Charges per mission", kind: "bar", table: ["mission_title", "currency", "charged"], emptyAction: { text: "No charges yet.", action: "Open Missions", target: "wallet-missions" } },
  { id: "budget-utilization", title: "Budget utilization", kind: "bar", table: ["mission_title", "currency", "budget", "charged", "reserved", "utilization_percent"], emptyAction: { text: "No funded missions yet.", action: "Open Missions", target: "wallet-missions" } },
  { id: "deposit-status", title: "Deposit status", kind: "donut", table: ["status", "currency", "count", "amount"], emptyAction: { text: "No deposits yet.", action: "Add funds", target: "wallet-add-funds" } },
  { id: "reconciliation-differences", title: "Reconciliation differences", kind: "line", table: ["date", "currency", "exceptions", "net_difference", "absolute_difference"], emptyAction: { text: "No reconciliation differences.", action: "Open Business account", target: "#/business-account" } },
];

export type ChartPointRow = Record<string, string | null>;

export interface PivotSeries {
  xKey: string;
  yKey: string;
  yName: string;
}

/**
 * Rows keyed by `xKey`, one numeric column per (field, currency). Gives one series per currency so
 * amounts in different currencies are never plotted on the same line. Numbers are for plotting only.
 */
export function pivotByCurrency(
  points: ChartPointRow[],
  xKey: string,
  fields: { key: string; label: string }[],
): { data: Record<string, string | number>[]; series: PivotSeries[] } {
  const rows = new Map<string, Record<string, string | number>>();
  const seriesMap = new Map<string, PivotSeries>();
  for (const p of points) {
    const x = p[xKey] ?? "";
    const cur = p.currency ?? "n/a";
    let row = rows.get(x);
    if (!row) {
      row = { [xKey]: x };
      rows.set(x, row);
    }
    for (const f of fields) {
      const v = p[f.key];
      if (v === null || v === undefined) continue;
      const yKey = `${f.key}__${cur}`;
      row[yKey] = Number(v);
      if (!seriesMap.has(yKey)) seriesMap.set(yKey, { xKey, yKey, yName: `${f.label} (${cur})` });
    }
  }
  return { data: [...rows.values()], series: [...seriesMap.values()] };
}

/** Donut data: deposit counts by status. Counts are whole numbers, not money. */
export function statusCounts(points: ChartPointRow[]): { status: string; count: number }[] {
  const m = new Map<string, number>();
  for (const p of points) m.set(p.status ?? "unknown", (m.get(p.status ?? "unknown") ?? 0) + Number(p.count ?? 0));
  return [...m.entries()].map(([status, count]) => ({ status, count }));
}

/** Budget utilization as plottable rows. The percentage was computed by the server. */
export function utilizationRows(points: ChartPointRow[]): { mission_title: string; utilization_percent: number }[] {
  return points.map((p) => ({
    mission_title: p.mission_title ?? p.mission_id ?? "mission",
    utilization_percent: Number(p.utilization_percent ?? 0),
  }));
}
