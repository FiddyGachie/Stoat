/**
 * Dataset registry for `/v1/analytics/payments/:dataset`. Every dataset runs through
 * `readOnlyTransaction`, so it can write nothing and is cancelled after `ANALYTICS_TIMEOUT_MS`.
 * The response is `{ meta, groups: [{ currency, rows }] }`; nothing is summed across currencies.
 */
import { readOnlyTransaction, type DbClient } from "../../db/connection.js";
import { StoatError } from "../../common/errors.js";
import { analyticsTimeoutMs } from "../agentic/agentic-config.js";
import {
  alertCounts,
  holdCounts,
  mandateUsage,
  paypalFlows,
  proposalCounts,
  spendFacts,
  validateDateRange,
  type AnalyticsScope,
  type FactResult,
} from "./read-models.js";

export const DATASET_NAMES = [
  "spend-facts",
  "mandate-usage",
  "alerts",
  "holds",
  "proposals",
  "paypal-flows",
] as const;
export type DatasetName = (typeof DATASET_NAMES)[number];

export type PaypalEnvironment = "sandbox" | "live" | "unknown";

export interface DatasetMeta {
  dataset: string;
  from: string;
  to: string;
  generated_at: string;
  paypal_environment: PaypalEnvironment;
  row_count_total: number;
  truncated: boolean;
}

export interface DatasetGroup<R = Record<string, unknown>> {
  currency: string | null;
  rows: R[];
}

export interface DatasetResult<R = Record<string, unknown>> {
  meta: DatasetMeta;
  groups: DatasetGroup<R>[];
}

export interface DatasetRequest {
  scope: AnalyticsScope;
  from?: unknown;
  to?: unknown;
  paypalEnvironment?: PaypalEnvironment;
  now?: Date;
  /** Optional mandate status filter for `mandate-usage`. */
  status?: string;
}

export function isDatasetName(name: string): name is DatasetName {
  return (DATASET_NAMES as readonly string[]).includes(name);
}

function groupByCurrency<R extends { currency?: string }>(
  rows: R[],
): DatasetGroup<R>[] {
  const map = new Map<string, R[]>();
  for (const row of rows) {
    const key = row.currency as string;
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return [...map.entries()].map(([currency, list]) => ({
    currency,
    rows: list,
  }));
}

export async function loadDataset(
  name: DatasetName,
  req: DatasetRequest,
  db?: DbClient,
): Promise<DatasetResult> {
  const now = req.now ?? new Date();
  // Mandate usage is a point-in-time view, so a range is only validated when supplied.
  const today = now.toISOString().slice(0, 10);
  const range =
    name === "mandate-usage" && req.from === undefined && req.to === undefined
      ? { from: today, to: today }
      : validateDateRange(req.from, req.to);

  const run = async (client: DbClient): Promise<FactResult<any>> => {
    switch (name) {
      case "spend-facts":
        return spendFacts(client, req.scope, range);
      case "mandate-usage":
        return mandateUsage(client, req.scope, now, { status: req.status });
      case "alerts":
        return alertCounts(client, req.scope, range);
      case "holds":
        return holdCounts(client, req.scope, range);
      case "proposals":
        return proposalCounts(client, req.scope, range);
      case "paypal-flows":
        return paypalFlows(client, req.scope, range);
      default:
        throw new StoatError("NOT_FOUND", "Unknown dataset.", 404);
    }
  };

  const result = db
    ? await run(db)
    : await readOnlyTransaction(run, { timeoutMs: analyticsTimeoutMs() });

  const hasCurrency = ["spend-facts", "mandate-usage", "paypal-flows"].includes(
    name,
  );
  return {
    meta: {
      dataset: name,
      from: range.from,
      to: range.to,
      generated_at: now.toISOString(),
      paypal_environment: req.paypalEnvironment ?? "unknown",
      row_count_total: result.rowCountTotal,
      truncated: result.truncated,
    },
    groups: hasCurrency
      ? groupByCurrency(result.rows)
      : [{ currency: null, rows: result.rows }],
  };
}
