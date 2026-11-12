import React, { useState } from 'react';
import type { ColDef } from 'ag-grid-community';
import { useFetch } from '../hooks.js';
import { api } from '../api.js';
import { GridPanel } from '../components/GridPanel.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { ChartPanel } from '../components/ChartPanel.js';
import { CHART_COLORS } from '../styles/chartTheme.js';

// Missions feed the quotes/agreements view since we fetch agreements from the missions list
const MISSION_COLS: ColDef[] = [
  { field: 'id', headerName: 'ID', width: 80, valueFormatter: ({ value }) => value ? `${value.substring(0, 8)}…` : '' },
  { field: 'title', headerName: 'Title', flex: 2 },
  { field: 'budget', headerName: 'Budget', width: 130,
    valueFormatter: ({ value, data }) =>
      value ? `${Number(value).toFixed(6)} ${(data as Record<string, string>)['currency'] ?? 'USD'}` : '',
    cellStyle: { color: 'var(--color-success)' }},
  { field: 'reserved_budget', headerName: 'Reserved', width: 130,
    valueFormatter: ({ value, data }) =>
      value ? `${Number(value).toFixed(6)} ${(data as Record<string, string>)['currency'] ?? 'USD'}` : '',
    cellStyle: { color: 'var(--color-warning)' }},
  { field: 'status', headerName: 'Status', width: 100,
    cellRenderer: ({ value }: { value: string }) =>
      <StatusBadge label={value} variant={value === 'created' ? 'live' : 'info'} /> },
  { field: 'deadline', headerName: 'Deadline', flex: 1,
    valueFormatter: ({ value }) => value ? new Date(value).toLocaleDateString() : '' },
];

export const QuotesAgreementsWorkspace: React.FC = () => {
  const { status, data, error } = useFetch(() => api.missions());
  const spend = useFetch(() => api.aggregates.missionSpend());
  const [gridFilter, setGridFilter] = useState('');
  const rows = status === 'ok' ? data.missions : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 'var(--space-4)', background: 'transparent', boxSizing: 'border-box', gap: 'var(--space-4)' }}>
      <div>
        <ChartPanel
          title="Mission Spend vs Budget"
          data={spend.status === 'ok' ? spend.data.data : []}
          loading={spend.status === 'loading'}
          error={spend.status === 'error' ? spend.error : undefined}
          series={[
            { type: 'bar', xKey: 'title', yKey: 'budget', yName: 'Budget', fill: CHART_COLORS.primary },
            { type: 'bar', xKey: 'title', yKey: 'reserved_budget', yName: 'Reserved', fill: CHART_COLORS.violet },
          ]}
          onSegmentClick={(val) => setGridFilter(val)}
        />
      </div>
      <div style={{ flex: 1 }}>
        <GridPanel
          title="Missions, Quotes & Agreements"
          rows={rows}
          cols={MISSION_COLS}
          loading={status === 'loading'}
          error={status === 'error' ? error : undefined}
          quickFilter={gridFilter}
          onQuickFilterChange={setGridFilter}
          getRowId={(p) => (p.data as { id: string }).id}
          badge={<StatusBadge label="immutable once accepted" variant="seeded" />}
        />
      </div>
      <div style={{ padding: '8px 16px', background: 'var(--glass-bg)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', fontSize: 12, color: 'var(--text-muted)', backdropFilter: 'var(--glass-blur)' }}>
        Accepted agreement terms are immutable. Changes require a new agreement.
        Policy decision ID is recorded on every accepted agreement (visible in Events stream).
      </div>
    </div>
  );
};
