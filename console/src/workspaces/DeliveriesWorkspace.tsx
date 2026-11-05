import React, { useState } from 'react';
import type { ColDef } from 'ag-grid-community';
import { useFetch } from '../hooks.js';
import { api } from '../api.js';
import { GridPanel } from '../components/GridPanel.js';
import { StatusBadge } from '../components/StatusBadge.js';

const COLS: ColDef[] = [
  { field: 'id', headerName: 'ID', width: 80, valueFormatter: ({ value }) => value?.substring(0, 8) + '…' },
  { field: 'agreement_id', headerName: 'Agreement', width: 100,
    valueFormatter: ({ value }) => value?.substring(0, 8) + '…' },
  { field: 'revision_number', headerName: 'Rev', width: 60 },
  { field: 'verdict', headerName: 'Verdict', flex: 1,
    cellRenderer: ({ value }: { value: string }) => {
      const v = value ?? 'pending';
      const variant = v === 'verified' ? 'ok' : v === 'rejected' ? 'error' : v === 'needs_review' ? 'warning' : 'info';
      return <StatusBadge label={v} variant={variant} />;
    }},
  { field: 'status', headerName: 'Status', flex: 1,
    cellRenderer: ({ value }: { value: string }) => {
      const v = value ?? 'pending';
      return <StatusBadge label={v} variant={v === 'verified' ? 'ok' : v === 'rejected' ? 'error' : 'info'} />;
    }},
  { field: 'created_at', headerName: 'Submitted', flex: 1,
    valueFormatter: ({ value }) => value ? new Date(value).toLocaleString() : '' },
];

export const DeliveriesWorkspace: React.FC = () => {
  const { status, data, error } = useFetch(() => api.deliveries({ limit: '100' }));
  const [expanded, setExpanded] = useState<Record<string, unknown> | null>(null);
  const rows = status === 'ok' ? data.deliveries : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1 }}>
        <GridPanel
          title="Deliveries"
          rows={rows}
          cols={COLS}
          loading={status === 'loading'}
          error={status === 'error' ? error : undefined}
          onRowClick={(row) => setExpanded(row as Record<string, unknown>)}
          getRowId={(p) => (p.data as { id: string }).id}
        />
      </div>

      {expanded && (
        <div style={{ padding: 16, background: '#151726', borderTop: '1px solid #2d3352' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600 }}>Verification Checks</h3>
            {!expanded['verdict'] && <StatusBadge label="pending" variant="info" />}
            <button
              onClick={() => setExpanded(null)}
              aria-label="Close verification checks"
              style={{ marginLeft: 'auto', background: 'none', border: '1px solid #2d3352', color: '#64748b', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}
            >
              ✕
            </button>
          </div>

          {expanded['checks'] ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {(expanded['checks'] as Record<string, unknown>[]).map((c, i) => (
                <div key={i} style={{
                  background: '#1e2235', border: `1px solid ${c['passed'] ? '#22c55e33' : '#ef444433'}`,
                  borderRadius: 4, padding: '6px 10px', fontSize: 11,
                }}>
                  <span style={{ color: c['passed'] ? '#22c55e' : '#ef4444' }}>
                    {c['passed'] ? '✓' : '✗'}
                  </span>{' '}
                  <span style={{ color: '#94a3b8' }}>{String(c['check'])}</span>
                  {c['message'] && <span style={{ color: '#ef4444', marginLeft: 4 }}>{String(c['message'])}</span>}
                </div>
              ))}
            </div>
          ) : (
            <p style={{ color: '#64748b', fontSize: 12 }}>No verification checks available for this delivery.</p>
          )}

          {expanded['reasons'] && (expanded['reasons'] as string[]).length > 0 && (
            <div style={{ marginTop: 8 }}>
              <h4 style={{ fontSize: 12, color: '#f59e0b', marginBottom: 4 }}>Rejection reasons</h4>
              {(expanded['reasons'] as string[]).map((r, i) => (
                <p key={i} style={{ fontSize: 12, color: '#f59e0b' }}>• {r}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
