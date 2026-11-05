import React from 'react';
import type { ColDef } from 'ag-grid-community';
import { useFetch } from '../hooks.js';
import { api } from '../api.js';
import { GridPanel } from '../components/GridPanel.js';
import { StatusBadge } from '../components/StatusBadge.js';

const DECISION_COLS: ColDef[] = [
  { field: 'result', headerName: 'Result', width: 80,
    cellRenderer: ({ value }: { value: string }) =>
      <StatusBadge label={value} variant={value === 'allow' ? 'ok' : 'error'} /> },
  { field: 'action', headerName: 'Action', flex: 1 },
  { field: 'resource_type', headerName: 'Resource', flex: 1 },
  { field: 'actor_id', headerName: 'Actor', width: 90,
    valueFormatter: ({ value }) => value?.substring(0, 8) + '…' },
  { field: 'reason_codes', headerName: 'Reason Codes', flex: 2,
    valueFormatter: ({ value }) =>
      Array.isArray(value) ? value.join(', ') : JSON.stringify(value) },
  { field: 'evaluated_at', headerName: 'Evaluated', flex: 1,
    valueFormatter: ({ value }) => value ? new Date(value).toLocaleString() : '' },
];

const HOLD_COLS: ColDef[] = [
  { field: 'id', headerName: 'ID', width: 80, valueFormatter: ({ value }) => value?.substring(0, 8) + '…' },
  { field: 'status', headerName: 'Status', width: 90,
    cellRenderer: ({ value }: { value: string }) =>
      <StatusBadge label={value} variant={value === 'active' ? 'error' : 'mocked'} /> },
  { field: 'scope_type', headerName: 'Scope', width: 90 },
  { field: 'reason', headerName: 'Reason', flex: 2 },
  { field: 'placed_by', headerName: 'Placed By', flex: 1,
    valueFormatter: ({ value }) => value?.substring(0, 8) + '…' },
  { field: 'placed_at', headerName: 'Placed', flex: 1,
    valueFormatter: ({ value }) => value ? new Date(value).toLocaleString() : '' },
];

export const PolicyWorkspace: React.FC = () => {
  const decisions = useFetch(() => api.policyDecisions({ limit: '100' }));
  const holds = useFetch(() => api.holds({ limit: '100' }));

  const decisionRows = decisions.status === 'ok' ? decisions.data.decisions : [];
  const holdRows = holds.status === 'ok' ? holds.data.holds : [];
  const activeHolds = holdRows.filter((h: Record<string, unknown>) => h['status'] === 'active');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 0 }}>
      <div style={{ flex: 1, borderBottom: '1px solid #2d3352' }}>
        <GridPanel
          title="Policy Decisions"
          rows={decisionRows}
          cols={DECISION_COLS}
          loading={decisions.status === 'loading'}
          error={decisions.status === 'error' ? decisions.error : undefined}
          badge={
            <StatusBadge
              label={`${decisionRows.filter((d: Record<string, unknown>) => d['result'] === 'deny').length} denials`}
              variant="warning"
            />
          }
          getRowId={(p) => (p.data as { id: string }).id}
        />
      </div>

      <div style={{ flex: 1 }}>
        <GridPanel
          title="Holds"
          rows={holdRows}
          cols={HOLD_COLS}
          loading={holds.status === 'loading'}
          error={holds.status === 'error' ? holds.error : undefined}
          badge={activeHolds.length > 0
            ? <StatusBadge label={`${activeHolds.length} active`} variant="error" />
            : <StatusBadge label="none active" variant="ok" />}
          getRowId={(p) => (p.data as { id: string }).id}
        />
      </div>
    </div>
  );
};
