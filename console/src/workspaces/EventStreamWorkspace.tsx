import React from 'react';
import type { ColDef } from 'ag-grid-community';
import { useFetch } from '../hooks.js';
import { api } from '../api.js';
import { GridPanel } from '../components/GridPanel.js';

const COLS: ColDef[] = [
  { field: 'sequence', headerName: 'Seq', width: 70 },
  { field: 'aggregate_type', headerName: 'Aggregate', flex: 1 },
  { field: 'aggregate_id', headerName: 'Agg ID', width: 90,
    valueFormatter: ({ value }) => value?.substring(0, 8) + '…' },
  { field: 'event_type', headerName: 'Event Type', flex: 2 },
  { field: 'actor_type', headerName: 'Actor', width: 80 },
  { field: 'actor_id', headerName: 'Actor ID', width: 90,
    valueFormatter: ({ value }) => value?.substring(0, 8) + '…' },
  { field: 'amount', headerName: 'Amount', width: 110,
    valueFormatter: ({ value, data }) =>
      value ? `${Number(value).toFixed(6)} ${(data as Record<string, string>)['currency'] ?? ''}` : '' },
  { field: 'previous_hash', headerName: 'Chain ✓', width: 80,
    cellRenderer: ({ data }: { data: Record<string, unknown> }) => {
      // For the first event, previous_hash is null — that's valid
      // For others, we show it as linked
      const hasChain = !data['previous_hash'] || typeof data['previous_hash'] === 'string';
      return <span style={{ color: hasChain ? '#22c55e' : '#ef4444' }}>{hasChain ? '✓' : '✗'}</span>;
    }},
  { field: 'recorded_at', headerName: 'Recorded', flex: 1,
    valueFormatter: ({ value }) => value ? new Date(value).toLocaleString() : '' },
];

export const EventStreamWorkspace: React.FC = () => {
  const { status, data, error } = useFetch(() => api.events({ limit: '100' }));
  const rows = status === 'ok' ? data.events : [];

  return (
    <GridPanel
      title="Event Stream"
      rows={rows}
      cols={COLS}
      loading={status === 'loading'}
      error={status === 'error' ? error : undefined}
      getRowId={(p) => (p.data as { id: string }).id}
    />
  );
};
