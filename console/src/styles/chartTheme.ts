/**
 * AG Charts draws to canvas and cannot read CSS variables, so chart colours live here and
 * mirror the tokens in tokens.css. This is the ONLY .ts/.tsx file allowed to hold raw hex
 * colours (scripts/verify/ui.ts enforces that).
 */
export const CHART_COLORS = {
  primary: "#2754c5",
  success: "#15803d",
  danger: "#b91c1c",
  warning: "#b45309",
  info: "#0369a1",
  violet: "#6d28d9",
  cyan: "#0891b2",
  brandBlue: "#0070ba",
  purple: "#7c5cd8",
  text: "#0f172a",
  muted: "#556274",
  grid: "#d9e0ea",
} as const;

export const CHART_FILLS = [
  CHART_COLORS.primary,
  CHART_COLORS.success,
  CHART_COLORS.warning,
  CHART_COLORS.violet,
  CHART_COLORS.info,
  CHART_COLORS.danger,
];
