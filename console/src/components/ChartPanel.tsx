import React from "react";
import { AgCharts } from "ag-charts-react";
import {
  AreaSeriesModule,
  BarSeriesModule,
  CartesianChartModule,
  CategoryAxisModule,
  DonutSeriesModule,
  LegendModule,
  LineSeriesModule,
  ModuleRegistry,
  NumberAxisModule,
  PieSeriesModule,
  PolarChartModule,
} from "ag-charts-community";
import { BarChart3, TriangleAlert } from "lucide-react";
import { CHART_COLORS, CHART_FILLS } from "../styles/chartTheme.js";
import { EmptyState, Icon, Loading } from "./ui.js";

// AG Charts 14 renders nothing until its modules are registered (like AG Grid in GridPanel).
// Register the series types used across the console: bar, pie, line, donut, area.
ModuleRegistry.registerModules([
  CartesianChartModule,
  PolarChartModule,
  BarSeriesModule,
  PieSeriesModule,
  LineSeriesModule,
  DonutSeriesModule,
  AreaSeriesModule,
  CategoryAxisModule,
  NumberAxisModule,
  LegendModule,
]);

/** A chart that fails to render shows a message in its card instead of taking the page down. */
class ChartBoundary extends React.Component<{ title: string; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(`[ChartPanel] "${this.props.title}" could not render:`, error);
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="notice notice-error" role="alert">
          <Icon icon={TriangleAlert} />
          <span>This chart could not be drawn. The table below still has the data.</span>
        </div>
      );
    }
    return this.props.children;
  }
}

interface ChartPanelProps {
  title: string;
  data: unknown[];
  series: unknown[];
  loading?: boolean;
  error?: string;
  onSegmentClick?: (value: string) => void;
}

/** A chart presented as a glass card. Charts are explanatory; the tables remain the record. */
export const ChartPanel: React.FC<ChartPanelProps> = ({ title, data, series, loading, error, onSegmentClick }) => {
  if (error) {
    return (
      <section className="card chart-card" aria-label={title}>
        <h2 className="card-title">{title}</h2>
        <div className="notice notice-error" role="alert">
          <Icon icon={TriangleAlert} />
          <span>Chart data could not be loaded.</span>
        </div>
      </section>
    );
  }
  if (loading) {
    return (
      <section className="card chart-card" aria-label={title}>
        <h2 className="card-title">{title}</h2>
        <Loading label="Loading chart…" />
      </section>
    );
  }
  if (!data.length) {
    return (
      <section className="card chart-card" aria-label={title}>
        <h2 className="card-title">{title}</h2>
        <EmptyState icon={BarChart3} title="No data yet">This chart fills in as activity is recorded.</EmptyState>
      </section>
    );
  }

  const options: Record<string, unknown> = {
    data,
    series,
    background: { visible: false },
    theme: { palette: { fills: CHART_FILLS, strokes: CHART_FILLS } },
    title: { text: title, color: CHART_COLORS.text, fontSize: 14, fontWeight: "bold" },
    legend: { item: { label: { color: CHART_COLORS.muted } } },
  };
  if (onSegmentClick) {
    options.listeners = {
      seriesNodeClick: (e: unknown) => {
        const ev = e as { datum: Record<string, unknown> };
        const key = Object.values(ev.datum ?? {})[0];
        if (typeof key === "string") onSegmentClick(key);
      },
    };
  }
  return (
    <section className="card chart-card" aria-label={title}>
      <ChartBoundary title={title}>
        <AgCharts options={options as Parameters<typeof AgCharts>[0]["options"]} />
      </ChartBoundary>
    </section>
  );
};
