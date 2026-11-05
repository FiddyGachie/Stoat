import React from 'react';
import { AgCharts } from 'ag-charts-react';

interface ChartPanelProps {
  title: string;
  data: unknown[];
  series: unknown[];
  loading?: boolean;
  error?: string;
  onSegmentClick?: (value: string) => void;
}

export const ChartPanel: React.FC<ChartPanelProps> = ({
  title, data, series, loading, error, onSegmentClick,
}) => {
  if (error) {
    return (
      <div style={{ padding: 16 }} role="alert">
        <h3 style={{ color: '#ef4444', marginBottom: 4 }}>{title}</h3>
        <p style={{ color: '#ef4444', fontSize: 12 }}>Error loading chart data.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <h3 style={{ marginBottom: 4 }}>{title}</h3>
        <p style={{ color: '#64748b', fontSize: 12 }}>Loading…</p>
      </div>
    );
  }

  if (!data.length) {
    return (
      <div style={{ padding: 16 }}>
        <h3 style={{ marginBottom: 4 }}>{title}</h3>
        <p style={{ color: '#64748b', fontSize: 12 }}>No data.</p>
      </div>
    );
  }

  const options: Record<string, unknown> = {
    data,
    series,
    background: { fill: '#1a1d2e' },
    title: { text: title, color: '#e2e8f0', fontSize: 13 },
    legend: { item: { label: { color: '#94a3b8' } } },
  };

  if (onSegmentClick) {
    options.listeners = {
      seriesNodeClick: (e: unknown) => {
        const ev = e as { datum: Record<string, unknown> };
        const key = Object.values(ev.datum ?? {})[0];
        if (typeof key === 'string') onSegmentClick(key);
      },
    };
  }

  return (
    <div style={{ padding: 8 }}>
      <AgCharts options={options as Parameters<typeof AgCharts>[0]['options']} />
    </div>
  );
};
