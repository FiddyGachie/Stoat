import React, { useState } from 'react';
import type { ColDef } from 'ag-grid-community';
import { useFetch } from '../hooks.js';
import { api } from '../api.js';
import { GridPanel } from '../components/GridPanel.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { ChartPanel } from '../components/ChartPanel.js';

const BATCH_COLS: ColDef[] = [
  { field: 'id', headerName: 'Batch ID', width: 90, valueFormatter: ({ value }) => value?.substring(0, 8) + '…' },
  { field: 'total_amount', headerName: 'Total', width: 130,
    valueFormatter: ({ value, data }) =>
      value ? `${Number(value).toFixed(6)} ${(data as Record<string, string>)['currency'] ?? 'USD'}` : '',
    cellStyle: { color: '#22c55e' }},
  { field: 'currency', headerName: 'Currency', width: 80 },
  { field: 'status', headerName: 'Status', flex: 1,
    cellRenderer: ({ value }: { value: string }) => {
      const variant = value === 'confirmed' ? 'ok' : value === 'rejected' || value === 'failed' ? 'error'
        : value === 'reconciliation_required' ? 'warning'
        : value === 'approved' ? 'live' : 'info';
      // Show honest payment status — never say "reconciled" unless it is
      const display = value === 'submitted' ? 'capture_pending' : value;
      return <StatusBadge label={display} variant={variant} />;
    }},
  { field: 'approved_by', headerName: 'Approved By', flex: 1,
    valueFormatter: ({ value }) => value?.substring(0, 8) + '…' ?? 'n/a' },
  { field: 'created_at', headerName: 'Created', flex: 1,
    valueFormatter: ({ value }) => value ? new Date(value).toLocaleDateString() : '' },
];

export const SettlementWorkspace: React.FC = () => {
  const batches = useFetch(() => api.settlementBatches());
  const reconciliation = useFetch(() => api.reconciliation());
  const captureChart = useFetch(() => api.aggregates.captureReconciliation());
  const [selected, setSelected] = useState<string | null>(null);
  const batchDetail = useFetch(
    () => selected ? api.settlementBatch(selected) : Promise.resolve(null),
    [selected]
  );

  const rows = batches.status === 'ok' ? batches.data.batches : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 16px', borderBottom: '1px solid #2d3352' }}>
        <ChartPanel
          title="Capture & Reconciliation Outcomes"
          data={captureChart.status === 'ok' ? captureChart.data.data : []}
          loading={captureChart.status === 'loading'}
          error={captureChart.status === 'error' ? captureChart.error : undefined}
          series={[{ type: 'pie', angleKey: 'count', calloutLabelKey: 'verdict', legendItemKey: 'verdict' }]}
        />
      </div>

      <div style={{ flex: 1, borderBottom: '1px solid #2d3352' }}>
        <GridPanel
          title="Settlement Batches"
          rows={rows}
          cols={BATCH_COLS}
          loading={batches.status === 'loading'}
          error={batches.status === 'error' ? batches.error : undefined}
          onRowClick={(row) => setSelected((row as { id: string }).id)}
          getRowId={(p) => (p.data as { id: string }).id}
        />
      </div>

      {selected && batchDetail.status === 'ok' && batchDetail.data && (
        <div style={{ padding: 16, background: '#151726', maxHeight: 200, overflow: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600 }}>Batch items & reconciliation</h3>
            <button
              onClick={() => setSelected(null)}
              style={{ marginLeft: 'auto', background: 'none', border: '1px solid #2d3352', color: '#64748b', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}
            >✕</button>
          </div>

          {/* Batch items */}
          {(batchDetail.data.items ?? []).map((item: Record<string, unknown>) => (
            <div key={String(item['id'])} style={{ fontSize: 12, color: '#94a3b8', marginBottom: 2 }}>
              Obligation: {String(item['obligation_id']).substring(0, 12)}…
              — <span style={{ color: '#22c55e' }}>{Number(item['amount']).toFixed(6)} USD</span>
            </div>
          ))}

          {/* Reconciliation records for this batch */}
          {reconciliation.status === 'ok' && (() => {
            const rec = reconciliation.data.records.find(
              (r: Record<string, unknown>) => r['batch_id'] === selected
            );
            if (!rec) return <p style={{ fontSize: 12, color: '#f59e0b', marginTop: 8 }}>No reconciliation record — payment status: unknown or pending.</p>;
            return (
              <div style={{ marginTop: 8, fontSize: 12 }}>
                <StatusBadge
                  label={`reconciliation: ${String(rec['verdict'])}`}
                  variant={rec['verdict'] === 'matched' ? 'ok' : rec['verdict'] === 'mismatch' ? 'error' : 'warning'}
                />
                <span style={{ marginLeft: 8, color: '#64748b' }}>
                  expected {Number(rec['expected_amount']).toFixed(6)} {String(rec['expected_currency'])} /
                  actual {Number(rec['actual_amount']).toFixed(6)} {String(rec['actual_currency'])}
                </span>
                <p style={{ marginTop: 4, color: '#94a3b8', fontStyle: 'italic' }}>
                  Note: PayPal Sandbox capture is buyer-to-merchant. Provider payable obligations remain internal ledger items.
                </p>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
};
