import React, { useState } from 'react';
import { useFetch } from '../hooks.js';
import { api } from '../api.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { ChartPanel } from '../components/ChartPanel.js';

export const EconomyWorkspace: React.FC = () => {
  const integrity = useFetch(() => api.integrity());
  const missions = useFetch(() => api.missions());
  const obligations = useFetch(() => api.obligations());
  const obByStatus = useFetch(() => api.aggregates.obligationsByStatus());
  const missionSpend = useFetch(() => api.aggregates.missionSpend());
  const policyDenials = useFetch(() => api.aggregates.policyDenials());

  const [statusFilter, setStatusFilter] = useState<string | undefined>();

  const healthy = integrity.status === 'ok' && integrity.data?.integrity_status === 'healthy';

  const obStats = obligations.status === 'ok'
    ? obligations.data.obligations.reduce<Record<string, number>>((acc, o: { status: string }) => {
        acc[o.status] = (acc[o.status] ?? 0) + 1;
        return acc;
      }, {})
    : {};

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ marginBottom: 20, fontSize: 16, fontWeight: 600 }}>Economy Overview</h2>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
        {[
          { label: 'Missions', value: missions.status === 'ok' ? missions.data.missions.length : '…' },
          { label: 'Obligations', value: obligations.status === 'ok' ? obligations.data.obligations.length : '…' },
          { label: 'Payable', value: obStats['payable'] ?? 0 },
          { label: 'Reserved', value: obStats['reserved_for_settlement'] ?? 0 },
          { label: 'Settled', value: obStats['settled'] ?? 0 },
        ].map(({ label, value }) => (
          <div key={label} style={{
            background: '#1e2235', border: '1px solid #2d3352', borderRadius: 8,
            padding: '12px 16px',
          }}>
            <p style={{ color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</p>
            <p style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>{String(value)}</p>
          </div>
        ))}

        <div style={{
          background: '#1e2235', border: `1px solid ${healthy ? '#22c55e44' : '#ef444444'}`,
          borderRadius: 8, padding: '12px 16px',
        }}>
          <p style={{ color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Integrity</p>
          <div style={{ marginTop: 4 }}>
            {integrity.status === 'ok'
              ? <StatusBadge label={healthy ? 'healthy' : 'violation'} variant={healthy ? 'ok' : 'error'} />
              : <span style={{ color: '#64748b', fontSize: 12 }}>…</span>}
          </div>
        </div>
      </div>

      {/* Charts row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 24 }}>
        <div style={{ background: '#1e2235', border: '1px solid #2d3352', borderRadius: 8 }}>
          <ChartPanel
            title="Obligations by Status"
            data={obByStatus.status === 'ok' ? obByStatus.data.data : []}
            loading={obByStatus.status === 'loading'}
            error={obByStatus.status === 'error' ? obByStatus.error : undefined}
            series={[{ type: 'pie', angleKey: 'count', calloutLabelKey: 'status', legendItemKey: 'status' }]}
            onSegmentClick={(v) => setStatusFilter(v)}
          />
        </div>

        <div style={{ background: '#1e2235', border: '1px solid #2d3352', borderRadius: 8 }}>
          <ChartPanel
            title="Mission Spend vs Budget"
            data={missionSpend.status === 'ok' ? missionSpend.data.data : []}
            loading={missionSpend.status === 'loading'}
            error={missionSpend.status === 'error' ? missionSpend.error : undefined}
            series={[
              { type: 'bar', xKey: 'title', yKey: 'budget', yName: 'Budget', fill: '#38bdf8' },
              { type: 'bar', xKey: 'title', yKey: 'reserved_budget', yName: 'Reserved', fill: '#a78bfa' },
            ]}
          />
        </div>

        <div style={{ background: '#1e2235', border: '1px solid #2d3352', borderRadius: 8 }}>
          <ChartPanel
            title="Policy Denials by Reason"
            data={policyDenials.status === 'ok' ? policyDenials.data.data.map((d: { reason_codes: unknown; count: number }) => ({
              reason: JSON.stringify(d.reason_codes).substring(0, 30),
              count: d.count,
            })) : []}
            loading={policyDenials.status === 'loading'}
            error={policyDenials.status === 'error' ? policyDenials.error : undefined}
            series={[{ type: 'bar', xKey: 'reason', yKey: 'count', fill: '#f59e0b' }]}
          />
        </div>
      </div>

      {statusFilter && (
        <p style={{ fontSize: 12, color: '#a78bfa', marginBottom: 8 }}>
          Filtered by status: <strong>{statusFilter}</strong>{' '}
          <button
            onClick={() => setStatusFilter(undefined)}
            style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 12 }}
          >
            ✕ clear
          </button>
        </p>
      )}
    </div>
  );
};
