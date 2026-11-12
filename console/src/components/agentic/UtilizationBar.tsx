import React from "react";
import { utilization } from "./helpers.js";

interface Props {
  /** Server decimal strings. */
  used: string;
  cap: string;
  currency: string;
  /** Accessible name, for example "Total usage". */
  label?: string;
}

/** A progress bar for spend against a cap, labelled like `120.00 / 500.00 USD`. */
export const UtilizationBar: React.FC<Props> = ({ used, cap, currency, label }) => {
  const fraction = utilization(used, cap);
  const pct = Math.round(fraction * 100);
  const text = `${used} / ${cap} ${currency}`;
  return (
    <div className="utilization">
      <div
        className="utilization-track"
        role="progressbar"
        aria-label={label ?? "Utilization"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={text}
      >
        <div className="utilization-fill" style={{ width: `${fraction * 100}%` }} />
      </div>
      <span className="utilization-label">{text}</span>
    </div>
  );
};
