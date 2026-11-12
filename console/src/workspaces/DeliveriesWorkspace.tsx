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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 24, background: 'transparent', boxSizing: 'border-box' }}>
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
        <div style={{ padding: 16, background: 'rgba(255,255,255,0.72)', borderTop: '1px solid rgba(0,0,0,0.07)', backdropFilter: 'blur(18px)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600 }}>Verification Checks</h3>
            {!expanded['verdict'] && <StatusBadge label="pending" variant="info" />}
            <button
              onClick={() => setExpanded(null)}
              aria-label="Close verification checks"
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}
            >
              ✕
            </button>
          </div>

          {expanded['checks'] ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {(expanded['checks'] as Record<string, unknown>[]).map((c, i) => (
                <div key={i} style={{
                  background: 'rgba(255,255,255,0.80)', border: `1px solid ${c['passed'] ? 'var(--color-success-tint)' : 'var(--color-danger-tint)'}`,
                  borderRadius: 4, padding: '6px 10px', fontSize: 11,
                }}>
                  <span style={{ color: c['passed'] ? 'var(--color-success)' : 'var(--color-danger)' }}>
                    {c['passed'] ? '✓' : '✗'}
                  </span>{' '}
                  <span style={{ color: 'var(--text-secondary)' }}>{String(c['check'])}</span>
                  {typeof c['message'] === 'string' && c['message'] !== '' && <span style={{ color: 'var(--color-danger)', marginLeft: 4 }}>{String(c['message'])}</span>}
                </div>
              ))}
            </div>
          ) : (
            <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>No verification checks available for this delivery.</p>
          )}

          {Array.isArray(expanded['reasons']) && (expanded['reasons'] as string[]).length > 0 && (
            <div style={{ marginTop: 8 }}>
              <h4 style={{ fontSize: 12, color: 'var(--color-warning)', marginBottom: 4 }}>Rejection reasons</h4>
              {(expanded['reasons'] as string[]).map((r, i) => (
                <p key={i} style={{ fontSize: 12, color: 'var(--color-warning)' }}>• {r}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};




