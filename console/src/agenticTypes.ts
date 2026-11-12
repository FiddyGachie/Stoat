// DOM-free types shared by the console and by tests that import pure helpers.
// Kept apart from api.ts (which uses import.meta.env and window) so the root tsconfig can check them.

export interface AgenticDigestFigure {
  key: string;
  value: string;
  currency?: string;
  kind: "amount" | "count" | "percent" | "days";
}

export interface AgenticIntentResult {
  intent: string;
  params: Record<string, unknown>;
  columns: Array<{
    field: string;
    type: "string" | "money" | "integer" | "timestamp";
  }>;
  chart?: {
    type: "bar" | "line" | "donut";
    x: string;
    y: string;
    groupBy?: "currency";
  };
  rows: Array<Record<string, unknown>>;
  row_count: number;
  truncated: boolean;
}

export interface CurrencyPoint {
  currency: string;
  label: string;
  /** Server decimal string, shown verbatim in the data table. */
  value: string;
}
