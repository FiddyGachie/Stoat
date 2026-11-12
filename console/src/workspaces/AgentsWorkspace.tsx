import React, { useState } from 'react';
import type { ColDef } from 'ag-grid-community';
import { useFetch } from '../hooks.js';
import { api } from '../api.js';
import { GridPanel } from '../components/GridPanel.js';
import { StatusBadge } from '../components/StatusBadge.js';

const AGENT_COLS: ColDef[] = [
  { field: 'id', headerName: 'ID', width: 80, valueFormatter: ({ value }) => value?.substring(0, 8) + '…' },
  { field: 'name', headerName: 'Name', flex: 2 },
  { field: 'role', headerName: 'Role', flex: 1 },
  { field: 'status', headerName: 'Status', flex: 1,
    cellRenderer: ({ value }: { value: string }) => <StatusBadge label={value} variant={value === 'active' ? 'ok' : 'error'} /> },
  { field: 'created_at', headerName: 'Created', flex: 1,
    valueFormatter: ({ value }) => value ? new Date(value).toLocaleDateString() : '' },
];

const RUN_COLS: ColDef[] = [
  { field: 'id', headerName: 'Run ID', width: 80, valueFormatter: ({ value }) => value?.substring(0, 8) + '…' },
  { field: 'role', headerName: 'Role', width: 100 },
  { field: 'model', headerName: 'Model', flex: 2 },
  { field: 'steps_count', headerName: 'Steps', width: 80 },
  { field: 'cost_usd', headerName: 'Cost (USD)', width: 100,
    valueFormatter: ({ value }) => value != null ? `$${Number(value).toFixed(4)} USD` : '' },
  { field: 'status', headerName: 'Status', width: 120,
    cellRenderer: ({ value }: { value: string }) => (
      <StatusBadge
        label={value}
        variant={value === 'completed' ? 'ok' : value === 'running' ? 'live' : value === 'failed_closed' ? 'error' : 'info'}
      />
    )},
  { field: 'started_at', headerName: 'Started', flex: 1,
    valueFormatter: ({ value }) => value ? new Date(value).toLocaleString() : '' },
];

export const AgentsWorkspace: React.FC = () => {
  const agents = useFetch(() => api.agents());
  const runs = useFetch(() => api.agentRuns());
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const trace = useFetch(() => selectedRun ? api.agentRunTrace(selectedRun) : Promise.resolve(null), [selectedRun]);

  const isReplayed = (run: Record<string, unknown>) =>
    (run as { terminal_reason?: string })?.terminal_reason?.includes('replay');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 0, padding: 24, background: 'transparent', boxSizing: 'border-box' }}>
      <div style={{ flex: '0 0 35%', borderBottom: '1px solid rgba(0,0,0,0.07)' }}>
        <GridPanel
          title="Agents"
          rows={agents.status === 'ok' ? agents.data.agents : []}
          cols={AGENT_COLS}
          loading={agents.status === 'loading'}
          error={agents.status === 'error' ? agents.error : undefined}
          getRowId={(p) => (p.data as { id: string }).id}
        />
      </div>

      <div style={{ flex: '0 0 35%', borderBottom: '1px solid rgba(0,0,0,0.07)' }}>
        <GridPanel
          title="Agent Runs"
          rows={runs.status === 'ok' ? runs.data.runs : []}
          cols={RUN_COLS}
          loading={runs.status === 'loading'}
          error={runs.status === 'error' ? runs.error : undefined}
          onRowClick={(row) => setSelectedRun((row as { id: string }).id)}
          getRowId={(p) => (p.data as { id: string }).id}
        />
      </div>

      {selectedRun && (
        <div style={{ flex: 1, padding: 16, overflow: 'auto', background: 'rgba(255,255,255,0.72)', borderTop: '1px solid rgba(0,0,0,0.07)', backdropFilter: 'blur(18px)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600 }}>Trace: {selectedRun.substring(0, 12)}…</h3>
            {trace.status === 'ok' && trace.data?.run && isReplayed(trace.data.run as unknown as Record<string, unknown>) && (
              <StatusBadge label="replayed agent trace" variant="replayed" />
            )}
            <button
              onClick={() => setSelectedRun(null)}
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}
            >
              Close
            </button>
          </div>

          {trace.status === 'loading' && <p style={{ color: 'var(--text-muted)' }}>Loading trace…</p>}
          {trace.status === 'error' && <p style={{ color: 'var(--color-danger)' }}>{trace.error}</p>}
          {trace.status === 'ok' && trace.data && (
            <>
              {trace.data.steps?.length === 0 && (
                <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>No steps recorded for this run.</p>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(trace.data.steps ?? []).map((step: Record<string, unknown>, i: number) => (
                  <div key={i} style={{ background: 'rgba(255,255,255,0.80)', border: '1px solid rgba(0,0,0,0.08)', borderRadius: 6, padding: '8px 12px', fontSize: 12 }}>
                    <span style={{ color: 'var(--text-muted)' }}>#{Number(step['step_number'])}</span>{' '}
                    <strong style={{ color: 'var(--color-info)' }}>{String(step['tool_name'] ?? '')}</strong>{' '}
                    <StatusBadge label={String(step['authorization_result'] ?? '')} variant={step['authorization_result'] === 'allowed' ? 'ok' : 'error'} />
                    {typeof step['error_code'] === 'string' && step['error_code'] !== '' && <span style={{ color: 'var(--color-danger)', marginLeft: 8 }}>{String(step['error_code'])}</span>}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};



