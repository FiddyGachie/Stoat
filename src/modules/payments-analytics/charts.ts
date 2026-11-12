/**
 * Chart series for `/v1/analytics/payments/charts/:chart`, derived only from the datasets.
 * One series group per currency; amounts stay Decimal_Amount strings and are never added
 * across currencies.
 */
import { Decimal } from "decimal.js";
import { StoatError } from "../../common/errors.js";
import type { DbClient } from "../../db/connection.js";
import {
  loadDataset,
  type DatasetMeta,
  type DatasetName,
  type DatasetRequest,
} from "./datasets.js";

export const CHART_NAMES = [
  "spend-by-day",
  "spend-by-mandate",
  "spend-by-agent",
  "spend-by-provider",
  "spend-by-category",
  "mandate-utilization",
  "alerts-by-day",
  "proposal-outcomes",
] as const;
export type ChartName = (typeof CHART_NAMES)[number];

export interface ChartPoint {
  x: string;
  y: string;
}

export interface ChartResult {
  meta: DatasetMeta;
  chart: string;
  type: "bar" | "line" | "donut";
  groups: { currency: string | null; points: ChartPoint[] }[];
}

export function isChartName(name: string): name is ChartName {
  return (CHART_NAMES as readonly string[]).includes(name);
}

const SPEND_KEY: Record<string, string> = {
  "spend-by-day": "day",
  "spend-by-mandate": "mandate_id",
  "spend-by-agent": "agent_id",
  "spend-by-provider": "provider_id",
  "spend-by-category": "category",
};

function sumBy(
  rows: Record<string, any>[],
  key: string,
  value: string,
): ChartPoint[] {
  const totals = new Map<string, Decimal>();
  for (const row of rows) {
    const x = row[key] === null || row[key] === undefined ? "none" : String(row[key]);
    totals.set(x, (totals.get(x) ?? new Decimal(0)).plus(row[value]));
  }
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([x, y]) => ({ x, y: y.toFixed() }));
}

function countBy(rows: Record<string, any>[], key: string): ChartPoint[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const x = String(row[key]);
    totals.set(x, (totals.get(x) ?? 0) + Number(row.count));
  }
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([x, y]) => ({ x, y: String(y) }));
}

export async function loadChart(
  chart: string,
  req: DatasetRequest,
  db?: DbClient,
): Promise<ChartResult> {
  if (!isChartName(chart)) {
    throw new StoatError("NOT_FOUND", "Unknown chart.", 404);
  }
  let dataset: DatasetName;
  let type: ChartResult["type"] = "bar";
  if (chart in SPEND_KEY) {
    dataset = "spend-facts";
    type = chart === "spend-by-day" ? "line" : chart === "spend-by-category" ? "donut" : "bar";
  } else if (chart === "mandate-utilization") dataset = "mandate-usage";
  else if (chart === "alerts-by-day") {
    dataset = "alerts";
    type = "line";
  } else {
    dataset = "proposals";
    type = "donut";
  }

  const data = await loadDataset(dataset, req, db);
  const groups = data.groups.map((g) => {
    const rows = g.rows as Record<string, any>[];
    let points: ChartPoint[];
    if (chart in SPEND_KEY) points = sumBy(rows, SPEND_KEY[chart]!, "charged_amount");
    else if (chart === "mandate-utilization")
      points = rows.map((r) => ({ x: r.mandate_id, y: r.usage }));
    else if (chart === "alerts-by-day") points = countBy(rows, "day");
    else points = countBy(rows, "status");
    return { currency: g.currency, points };
  });
  return { meta: data.meta, chart, type, groups };
}
