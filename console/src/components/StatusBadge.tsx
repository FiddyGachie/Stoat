import React from "react";

type Variant = "live" | "replayed" | "seeded" | "mocked" | "ok" | "error" | "warning" | "info";

/** Variant to CSS modifier. Colours come from tokens via .badge-* in layout.css. */
const CLASS: Record<Variant, string> = {
  live: "badge-success",
  ok: "badge-success",
  replayed: "badge-violet",
  seeded: "badge-warning",
  warning: "badge-warning",
  mocked: "badge-neutral",
  error: "badge-danger",
  info: "badge-info",
};

export const StatusBadge: React.FC<{ label: string; variant?: Variant }> = ({ label, variant = "info" }) => (
  <span className={`badge badge-dot ${CLASS[variant]}`} aria-label={`Status: ${label}`}>
    {label}
  </span>
);
