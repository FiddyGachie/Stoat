import React from 'react';
import type { ColDef } from 'ag-grid-community';
import { useFetch } from '../hooks.js';
import { api } from '../api.js';
import { GridPanel } from '../components/GridPanel.js';
import { StatusBadge } from '../components/StatusBadge.js';

// Missions feed the quotes/agreements view since we fetch agreements from the missions list
const MISSION_COLS: ColDef[] = [
  { field: 'id', headerName: 'ID', width: 80, valueFormatter: ({ value }) => value?.substring(0, 8) + '…' },
  { field: 'title', headerName: 'Title', flex: 2 },
  { field: 'budget', headerName: 'Budget', width: 130,
    valueFormatter: ({ value, data }) =>
      value ? `${Number(value).toFixed(6)} ${(data as Record<string, string>)['currency'] ?? 'USD'}` : '',
    cellStyle: { color: '#22c55e' }},
  { field: 'reserved_budget', headerName: 'Reserved', width: 130,
    valueFormatter: ({ value, data }) =>
      value ? `${Number(value).toFixed(6)} ${(data as Record<string, string>)['currency'] ?? 'USD'}` : '',
    cellStyle: { color: '#f59e0b' }},
  { field: 'status', headerName: 'Status', width: 100,
    cellRenderer: ({ value }: { value: string }) =>
      <StatusBadge label={value} variant={value === 'created' ? 'live' : 'info'} /> },
  { field: 'deadline', headerName: 'Deadline', flex: 1,
    valueFormatter: ({ value }) => value ? new Date(value).toLocaleDateString() : '' },
];

export const QuotesAgreementsWorkspace: React.FC = () => {
  const { status, data, error } = useFetch(() => api.missions());
  const rows = status === 'ok' ? data.missions : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <GridPanel
        title="Missions, Quotes & Agreements"
        rows={rows}
        cols={MISSION_COLS}
        loading={status === 'loading'}
        error={status === 'error' ? error : undefined}
        getRowId={(p) => (p.data as { id: string }).id}
        badge={<StatusBadge label="immutable once accepted" variant="seeded" />}
      />
      <div style={{ padding: '8px 16px', background: '#1a1d2e', borderTop: '1px solid #2d3352', fontSize: 12, color: '#64748b' }}>
        Accepted agreement terms are immutable. Changes require a new agreement.
        Policy decision ID is recorded on every accepted agreement (visible in Events stream).
      </div>
    </div>
  );
};
