import React from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-alpine.css';

interface Props {
  title: string;
  rows: unknown[];
  cols: ColDef[];
  loading?: boolean;
  error?: string;
  onRowClick?: (row: unknown) => void;
  badge?: React.ReactNode;
  getRowId?: (params: { data: unknown }) => string;
}

export const GridPanel: React.FC<Props> = ({
  title, rows, cols, loading, error, onRowClick, badge, getRowId,
}) => {
  if (error) {
    return (
      <div style={{ padding: 24 }} role="alert" aria-live="polite">
        <h2 style={{ color: '#ef4444', marginBottom: 8 }}>{title}</h2>
        <p style={{ color: '#ef4444' }}>Error: {error}</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid #2d3352',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0' }}>{title}</h2>
        {badge}
        {loading && (
          <span
            aria-label="Loading data"
            style={{ color: '#64748b', fontSize: 12 }}
          >
            ⟳ loading…
          </span>
        )}
        <span style={{ color: '#475569', fontSize: 12, marginLeft: 'auto' }}>
          {rows.length} row{rows.length !== 1 ? 's' : ''}
        </span>
      </div>

      {rows.length === 0 && !loading ? (
        <div
          role="status"
          aria-label="No data available"
          style={{ padding: 32, textAlign: 'center', color: '#475569' }}
        >
          No records found.
        </div>
      ) : (
        <div className="ag-theme-alpine-dark" style={{ flex: 1 }}>
          <AgGridReact
            rowData={rows as Record<string, unknown>[]}
            columnDefs={cols}
            getRowId={getRowId ?? ((p: { data: unknown }) => (p.data as Record<string, unknown>)['id'] as string)}
            onRowClicked={onRowClick ? (e) => onRowClick(e.data) : undefined}
            pagination={true}
            paginationPageSize={25}
            paginationPageSizeSelector={[10, 25, 50, 100]}
            defaultColDef={{ sortable: true, filter: true, resizable: true, flex: 1 }}
            suppressCellFocus={false}
            enableCellTextSelection={true}
            domLayout="autoHeight"
          />
        </div>
      )}
    </div>
  );
};
