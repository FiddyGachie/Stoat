import { describe, expect, it } from "vitest";
import {
  chartYIsMoney,
  citedFigures,
  insightNoticeText,
  intentChartPoints,
} from "../console/src/components/agentic/insightHelpers.js";
import type { AgenticIntentResult } from "../console/src/agenticTypes.js";

const figures = [
  {
    key: "total.charged",
    value: "12.50",
    currency: "USD",
    kind: "amount" as const,
  },
  { key: "range.days", value: "30", kind: "days" as const },
];

describe("insight helpers", () => {
  it("returns cited figures in cited order and drops unknown keys", () => {
    expect(
      citedFigures(["range.days", "nope", "total.charged"], figures).map(
        (f) => f.key,
      ),
    ).toEqual(["range.days", "total.charged"]);
  });

  it("explains the missing narrative for each notice", () => {
    expect(insightNoticeText("LLM_NOT_CONFIGURED")).toMatch(
      /no model is configured/,
    );
    expect(insightNoticeText("EMPTY_DIGEST")).toMatch(/no payment activity/);
    expect(insightNoticeText("AGENT_OUTPUT_INVALID", "custom")).toBe("custom");
  });

  it("builds chart points with server strings and groups by currency", () => {
    const result: AgenticIntentResult = {
      intent: "x",
      params: {},
      columns: [
        { field: "day", type: "string" },
        { field: "amount", type: "money" },
        { field: "currency", type: "string" },
      ],
      chart: { type: "bar", x: "day", y: "amount", groupBy: "currency" },
      rows: [{ day: "2025-01-01", amount: "1.10", currency: "USD" }],
      row_count: 1,
      truncated: false,
    };
    expect(intentChartPoints(result)).toEqual([
      { currency: "USD", label: "2025-01-01", value: "1.10" },
    ]);
    expect(chartYIsMoney(result)).toBe(true);
  });
});
