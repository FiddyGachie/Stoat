import type {
  AgenticDigestFigure,
  AgenticIntentResult,
  CurrencyPoint,
} from "../../agenticTypes.js";

/** The digest figures a finding cites, in the order cited. Unknown keys are dropped. No arithmetic. */
export function citedFigures(
  cites: readonly string[],
  figures: readonly AgenticDigestFigure[],
): AgenticDigestFigure[] {
  const byKey = new Map(figures.map((f) => [f.key, f]));
  return cites.flatMap((k) => {
    const f = byKey.get(k);
    return f ? [f] : [];
  });
}

/** Why there is no narrative, in plain words. The digest is shown either way (R12.7). */
export function insightNoticeText(
  notice: string | null,
  serverText?: string,
): string {
  switch (notice) {
    case "EMPTY_DIGEST":
      return "There is no payment activity in this date range, so there is nothing to summarise.";
    case "LLM_NOT_CONFIGURED":
      return "No narrative is available because no model is configured. The figures below come straight from the ledger.";
    case "MODEL_TIMEOUT":
      return "No narrative is available because the model took too long. The figures below come straight from the ledger.";
    case "MODEL_BUDGET_EXCEEDED":
      return "No narrative is available because the model budget is used up. The figures below come straight from the ledger.";
    case "AGENT_OUTPUT_INVALID":
      return (
        serverText ||
        "No narrative is available because the model's answer did not pass checks. The figures below come straight from the ledger."
      );
    default:
      return "No narrative is available. The figures below come straight from the ledger.";
  }
}

/** Short label for a figure: `key` with underscores and dots as spaces. */
export const figureLabel = (key: string): string => key.replace(/[._]+/g, " ");

/** Chart points from an intent result. Values stay server strings; the currency column groups them. */
export function intentChartPoints(
  result: AgenticIntentResult,
): CurrencyPoint[] {
  const chart = result.chart;
  if (!chart) return [];
  return result.rows.map((r) => ({
    currency: chart.groupBy === "currency" ? String(r.currency ?? "") : "",
    label: String(r[chart.x] ?? ""),
    value: String(r[chart.y] ?? ""),
  }));
}

/** True when the chart's y column holds money, so values are shown with their currency. */
export function chartYIsMoney(result: AgenticIntentResult): boolean {
  const y = result.chart?.y;
  return !!y && result.columns.some((c) => c.field === y && c.type === "money");
}

/** Parameters as `name: value` pairs for display. */
export function paramEntries(
  params: Record<string, unknown> | null | undefined,
): Array<[string, string]> {
  return Object.entries(params ?? {}).map(([k, v]) => [
    k,
    typeof v === "string" ? v : JSON.stringify(v),
  ]);
}
