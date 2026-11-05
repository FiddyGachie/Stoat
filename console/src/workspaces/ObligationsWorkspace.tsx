import React from 'react';
import type { ColDef } from 'ag-grid-community';
import { useFetch } from '../hooks.js';
import { api } from '../api.js';
import { GridPanel } from '../components/GridPanel.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { ChartPanel } from '../components/ChartPanel.js';

const COLS: ColDef[] = [
  { field: 'id', headerName: 'ID', width: 80, valueFormatter: ({ value }) => value?.substring(0, 8) + '…' },
  { field: 'amount', headerName: 'Amount', width: 130,
    valueFormatter: ({ value, data }) =>
      value ? `${Number(value).toFixed(6)} ${(data as Record<string, string>)['currency'] ?? 'USD'}` : '',
    cellStyle: { color: '#22c55e' }},
  { field: 'currency', headerName: 'Currency', width: 80 },
  { field: 'status', headerName: 'Status', flex: 1,
    cellRenderer: ({ value }: { value: string }) => {
      const variant = value === 'payable' ? 'ok' : value === 'settled' ? 'info' : value === 'reserved_for_settlement' ? 'warning' : 'mocked';
      return <StatusBadge label={value} variant={variant} />;
    }},
  { field: 'agreement_id', headerName: 'Agreement', flex: 1,
    valueFormatter: ({ value }) => value?.substring(0, 8) + '…' },
  { field: 'accrued_at', headerName: 'Accrued', flex: 1,
    valueFormatter: ({ value }) => value ? new Date(value).toLocaleString() : '' },
];

export const ObligationsWorkspace: React.FC = () => {
  const { status, data, error } = useFetch(() => api.obligations());
  const obByStatus = useFetch(() => api.aggregates.obligationsByStatus());
  const rows = status === 'ok' ? data.obligations : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 16px', borderBottom: '1px solid #2d3352' }}>
        <ChartPanel
          title="Obligations by Status"
          data={obByStatus.status === 'ok' ? obByStatus.data.data : []}
          loading={obByStatus.status === 'loading'}
          error={obByStatus.status === 'error' ? obByStatus.error : undefined}
          series={[{ type: 'pie', angleKey: 'count', calloutLabelKey: 'status', legendItemKey: 'status', }]}
        />
      </div>
      <div style={{ flex: 1 }}>
        <GridPanel
          title="Obligations"
          rows={rows}
          cols={COLS}
          loading={status === 'loading'}
          error={status === 'error' ? error : undefined}
          getRowId={(p) => (p.data as { id: string }).id}
        />
      </div>
    </div>
  );
};
