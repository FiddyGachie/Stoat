/**
 * Pure helpers for the Watchdog workspace. Money_Boundary: thresholds are detector limits,
 * never a payee, recipient, currency or payment state.
 */

export type Severity = "low" | "medium" | "high" | "critical";

/** Badge variant for an Alert severity. */
export function severityVariant(severity: unknown): "info" | "warning" | "error" {
  switch (severity) {
    case "critical":
    case "high":
      return "error";
    case "medium":
      return "warning";
    default:
      return "info";
  }
}

export interface ThresholdField {
  key: string;
  label: string;
  /** Inclusive bounds, as the server states them (decimal strings for money). */
  min: string;
  max: string;
  integer: boolean;
}

/** Mirrors the server's THRESHOLD_BOUNDS. The server still validates; these only guide the form. */
export const THRESHOLD_FIELDS: Record<string, ThresholdField[]> = {
  spend_spike: [
    { key: "multiplier", label: "Multiplier", min: "1.1", max: "100", integer: false },
    { key: "min_observations", label: "Minimum observations", min: "3", max: "60", integer: true },
  ],
  price_outlier: [
    { key: "multiplier", label: "Multiplier", min: "1.1", max: "100", integer: false },
    { key: "min_observations", label: "Minimum observations", min: "3", max: "200", integer: true },
  ],
  repeated_revision: [{ key: "max_events", label: "Maximum revisions", min: "1", max: "20", integer: true }],
  unusual_provider: [{ key: "min_price", label: "Minimum price", min: "0.01", max: "999999999.99", integer: false }],
  wallet_depleting: [{ key: "horizon_hours", label: "Horizon (hours)", min: "1", max: "168", integer: true }],
  reconciliation_exception: [{ key: "max_age_minutes", label: "Maximum age (minutes)", min: "5", max: "10080", integer: true }],
};

const NUMBER = /^\d+(\.\d+)?$/;

/** An error message for a typed value, or "" when it is a positive number inside the bounds. */
export function thresholdError(field: ThresholdField, text: string): string {
  const t = text.trim();
  const range = `between ${field.min} and ${field.max}`;
  if (!NUMBER.test(t)) return `Enter a positive number ${range}.`;
  if (field.integer && t.includes(".")) return `Enter a whole number ${range}.`;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n < Number(field.min) || n > Number(field.max)) {
    return `Enter a positive number ${range}.`;
  }
  return "";
}

/** The PUT body for one detector. Money values stay strings; others become numbers. */
export function buildThresholdBody(fields: ThresholdField[], values: Record<string, string>): { params: Record<string, number | string> } {
  const params: Record<string, number | string> = {};
  for (const f of fields) {
    const v = (values[f.key] ?? "").trim();
    params[f.key] = f.key === "min_price" ? v : Number(v);
  }
  return { params };
}

/** A hold can be released only while active and when a reason has been typed. */
export function canRelease(status: unknown, reason: string): boolean {
  return status === "active" && reason.trim().length > 0;
}

/** Evidence as sorted key/value pairs, shown before any model text. */
export function evidenceEntries(evidence: unknown): Array<[string, string]> {
  let value = evidence;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [["evidence", value as string]];
    }
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => [k, typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)]);
}
