import React from 'react';
import type { ColDef } from 'ag-grid-community';
import { useFetch } from '../hooks.js';
import { api } from '../api.js';
import { GridPanel } from '../components/GridPanel.js';
import { StatusBadge } from '../components/StatusBadge.js';

const COLS: ColDef[] = [
  { field: 'id', headerName: 'ID', width: 80, valueFormatter: ({ value }) => value?.substring(0, 8) + '…' },
  { field: 'name', headerName: 'Name', flex: 2 },
  { field: 'category', headerName: 'Category', flex: 1 },
  { field: 'unit_price', headerName: 'Price', width: 120,
    valueFormatter: ({ value, data }) => `${Number(value).toFixed(6)} ${(data as Record<string, string>)['currency'] ?? 'USD'}`,
    cellStyle: { color: '#22c55e' } },
  { field: 'currency', headerName: 'Currency', width: 80 },
  { field: 'pricing_model', headerName: 'Pricing', flex: 1 },
  { field: 'status', headerName: 'Status', width: 100,
    cellRenderer: ({ value }: { value: string }) =>
      <StatusBadge label={value} variant={value === 'active' ? 'ok' : 'mocked'} /> },
];

export const ExchangeWorkspace: React.FC = () => {
  const { status, data, error } = useFetch(() => api.services());
  const rows = status === 'ok' ? data.services : [];

  return (
    <GridPanel
      title="Exchange — Service Registry"
      rows={rows}
      cols={COLS}
      loading={status === 'loading'}
      error={status === 'error' ? error : undefined}
      getRowId={(p) => (p.data as { id: string }).id}
    />
  );
};
