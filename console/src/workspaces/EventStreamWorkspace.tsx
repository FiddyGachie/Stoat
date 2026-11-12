import React, { useState } from 'react';
import type { ColDef } from 'ag-grid-community';
import { useFetch } from '../hooks.js';
import { api } from '../api.js';
import { GridPanel } from '../components/GridPanel.js';
import { ChartPanel } from '../components/ChartPanel.js';
import { CHART_COLORS } from '../styles/chartTheme.js';

const COLS: ColDef[] = [
  { field: 'sequence', headerName: 'Seq', width: 70 },
  { field: 'aggregate_type', headerName: 'Aggregate', flex: 1 },
  { field: 'aggregate_id', headerName: 'Agg ID', width: 90,
    valueFormatter: ({ value }) => value ? `${value.substring(0, 8)}…` : '' },
  { field: 'event_type', headerName: 'Event Type', flex: 2 },
  { field: 'actor_type', headerName: 'Actor', width: 80 },
  { field: 'actor_id', headerName: 'Actor ID', width: 90,
    valueFormatter: ({ value }) => value ? `${value.substring(0, 8)}…` : '' },
  { field: 'amount', headerName: 'Amount', width: 110,
    valueFormatter: ({ value, data }) =>
      value ? `${Number(value).toFixed(6)} ${(data as Record<string, string>)['currency'] ?? ''}` : '' },
  { field: 'previous_hash', headerName: 'Chain ✓', width: 80,
    cellRenderer: ({ data }: { data: Record<string, unknown> }) => {
      const hasChain = !data['previous_hash'] || typeof data['previous_hash'] === 'string';
      return <span style={{ color: hasChain ? 'var(--color-success)' : 'var(--color-danger)' }}>{hasChain ? '✓' : '✗'}</span>;
    }},
  { field: 'recorded_at', headerName: 'Recorded', flex: 1,
    valueFormatter: ({ value }) => value ? new Date(value).toLocaleString() : '' },
];

export const EventStreamWorkspace: React.FC = () => {
  const { status, data, error } = useFetch(() => api.events({ limit: '100' }));
  const volume = useFetch(() => api.aggregates.eventVolume());
  const [gridFilter, setGridFilter] = useState('');
  const rows = status === 'ok' ? data.events : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 'var(--space-4)', background: 'transparent', boxSizing: 'border-box', gap: 'var(--space-4)' }}>
      <div>
        <ChartPanel
          title="Event Activity Volume"
          data={volume.status === 'ok' ? volume.data.data : []}
          loading={volume.status === 'loading'}
          error={volume.status === 'error' ? volume.error : undefined}
          series={[{ type: 'bar', xKey: 'event_type', yKey: 'count', yName: 'Events', fill: CHART_COLORS.primary }]}
          onSegmentClick={(val) => setGridFilter(val)}
        />
      </div>
      <div style={{ flex: 1 }}>
        <GridPanel
          title="Event Stream"
          rows={rows}
          cols={COLS}
          loading={status === 'loading'}
          error={status === 'error' ? error : undefined}
          quickFilter={gridFilter}
          onQuickFilterChange={setGridFilter}
          getRowId={(p) => (p.data as { id: string }).id}
        />
      </div>
    </div>
  );
};
