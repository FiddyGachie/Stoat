import React from 'react';
import { useFetch } from '../hooks.js';
import { api } from '../api.js';
import { StatusBadge } from '../components/StatusBadge.js';

export const IntegrityWorkspace: React.FC = () => {
  const { status, data, error, reload } = useFetch(() => api.integrity());

  const metrics = (status === 'ok' && data) ? data.metrics : null;
  const healthy = status === 'ok' && data?.integrity_status === 'healthy';

  return (
    <div style={{ padding: 24, maxWidth: 800 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>Integrity Panel</h2>
        {status === 'ok' && (
          <StatusBadge
            label={healthy ? '✓ healthy' : '⚠ violation_detected'}
            variant={healthy ? 'ok' : 'error'}
          />
        )}
        <button
          onClick={reload}
          aria-label="Refresh integrity"
          style={{
            marginLeft: 'auto', background: '#252840', border: '1px solid #2d3352',
            color: '#94a3b8', borderRadius: 4, padding: '4px 10px', cursor: 'pointer',
          }}
        >
          Refresh
        </button>
      </div>

      {status === 'loading' && <p style={{ color: '#64748b' }}>Computing integrity…</p>}
      {status === 'error' && (
        <p role="alert" style={{ color: '#ef4444' }}>Error: {error}</p>
      )}

      {metrics && (
        <div
          role="table"
          aria-label="Integrity metrics"
          style={{ display: 'grid', gap: 1, background: '#2d3352', border: '1px solid #2d3352', borderRadius: 6 }}
        >
          {[
            ['Journal balance', metrics.debit_credit_balance?.every((b: { balanced: boolean }) => b.balanced) ? '✓ balanced' : '✗ imbalanced',
              metrics.debit_credit_balance?.every((b: { balanced: boolean }) => b.balanced)],
            ['Hash chain gaps', metrics.hash_chain_gaps, metrics.hash_chain_gaps === 0],
            ['Duplicate obligations', metrics.duplicate_obligations, metrics.duplicate_obligations === 0],
            ['Duplicate active reservations', metrics.duplicate_active_reservations, metrics.duplicate_active_reservations === 0],
            ['Orphan reservations', metrics.orphan_reservations, metrics.orphan_reservations === 0],
            ['Batch sum mismatches', metrics.batch_sum_mismatches, metrics.batch_sum_mismatches === 0],
            ['Unreconciled captures', metrics.unreconciled_captures, metrics.unreconciled_captures === 0],
            ['Unauthorized agreements', metrics.unauthorized_agreements, metrics.unauthorized_agreements === 0],
          ].map(([label, value, ok]) => (
            <div
              key={String(label)}
              role="row"
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '10px 16px', background: '#1a1d2e',
              }}
            >
              <span role="cell" style={{ color: '#94a3b8' }}>{String(label)}</span>
              <span
                role="cell"
                style={{ fontWeight: 600, color: ok ? '#22c55e' : '#ef4444' }}
                aria-label={`${String(label)}: ${String(value)}`}
              >
                {String(value)}
              </span>
            </div>
          ))}
        </div>
      )}

      {metrics?.debit_credit_balance?.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 8 }}>Journal balance by currency</h3>
          {metrics.debit_credit_balance.map((b: { currency: string; total_debit: string; total_credit: string; delta: string; balanced: boolean }) => (
            <div key={b.currency} style={{ display: 'flex', gap: 16, fontSize: 13, marginBottom: 4, color: b.balanced ? '#22c55e' : '#ef4444' }}>
              <span style={{ width: 60, fontWeight: 600 }}>{b.currency}</span>
              <span>Debit: {b.total_debit}</span>
              <span>Credit: {b.total_credit}</span>
              <span>Delta: {b.delta}</span>
            </div>
          ))}
        </div>
      )}

      {status === 'ok' && (
        <p style={{ marginTop: 12, fontSize: 11, color: '#475569' }}>
          Computed at: {new Date(data.computed_at).toLocaleString()}
        </p>
      )}
    </div>
  );
};
