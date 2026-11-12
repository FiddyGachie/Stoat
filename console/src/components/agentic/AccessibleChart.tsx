import React from "react";
import { ChartPanel } from "../ChartPanel.js";
import { groupByCurrency } from "./helpers.js";
import { Money } from "./Money.js";

import type { CurrencyPoint } from "../../agenticTypes.js";
export type { CurrencyPoint };

interface Props {
  title: string;
  points: readonly CurrencyPoint[];
  /** Series type for every chart. Defaults to bar. */
  type?: "bar" | "line" | "area";
  loading?: boolean;
  error?: string;
  onSegmentClick?: (value: string) => void;
}

/**
 * One ChartPanel per currency (amounts in different currencies are never plotted together), each
 * followed by a <details> table listing every plotted label and value.
 */
export const AccessibleChart: React.FC<Props> = ({ title, points, type = "bar", loading, error, onSegmentClick }) => {
  const groups = groupByCurrency(points);
  if (loading || error || groups.length === 0) {
    return <ChartPanel title={title} data={[]} series={[]} loading={loading} error={error} />;
  }
  return (
    <div className="accessible-chart">
      {groups.map((g) => {
        const chartTitle = groups.length > 1 ? `${title} (${g.currency})` : title;
        // The chart plots numbers; the table beside it keeps the exact server strings.
        const data = g.rows.map((r) => ({ label: r.label, value: Number(r.value) }));
        const series = [{ type, xKey: "label", yKey: "value", yName: g.currency }];
        return (
          <div key={g.currency}>
            <ChartPanel title={chartTitle} data={data} series={series} onSegmentClick={onSegmentClick} />
            <details className="chart-data">
              <summary>Data table for {chartTitle}</summary>
              <table>
                <caption className="sr-only">{chartTitle}</caption>
                <thead>
                  <tr>
                    <th scope="col">Label</th>
                    <th scope="col">Value ({g.currency})</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r, i) => (
                    <tr key={`${r.label}-${i}`}>
                      <th scope="row">{r.label}</th>
                      <td><Money amount={r.value} currency={g.currency} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </div>
        );
      })}
    </div>
  );
};
