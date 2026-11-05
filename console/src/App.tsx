import React, { useState, useEffect } from 'react';
import { EconomyWorkspace } from './workspaces/EconomyWorkspace.js';
import { AgentsWorkspace } from './workspaces/AgentsWorkspace.js';
import { ExchangeWorkspace } from './workspaces/ExchangeWorkspace.js';
import { QuotesAgreementsWorkspace } from './workspaces/QuotesAgreementsWorkspace.js';
import { EventStreamWorkspace } from './workspaces/EventStreamWorkspace.js';
import { DeliveriesWorkspace } from './workspaces/DeliveriesWorkspace.js';
import { ObligationsWorkspace } from './workspaces/ObligationsWorkspace.js';
import { SettlementWorkspace } from './workspaces/SettlementWorkspace.js';
import { PolicyWorkspace } from './workspaces/PolicyWorkspace.js';
import { IntegrityWorkspace } from './workspaces/IntegrityWorkspace.js';
import { api, setToken } from './api.js';
import { StatusBadge } from './components/StatusBadge.js';

type Workspace =
  | 'economy' | 'agents' | 'exchange' | 'quotes' | 'events'
  | 'deliveries' | 'obligations' | 'settlement' | 'policy' | 'integrity';

const NAV_ITEMS: { id: Workspace; label: string }[] = [
  { id: 'economy', label: 'Economy' },
  { id: 'agents', label: 'Agents' },
  { id: 'exchange', label: 'Exchange' },
  { id: 'quotes', label: 'Quotes & Agreements' },
  { id: 'events', label: 'Event Stream' },
  { id: 'deliveries', label: 'Deliveries' },
  { id: 'obligations', label: 'Obligations' },
  { id: 'settlement', label: 'Settlement' },
  { id: 'policy', label: 'Policy & Trust' },
  { id: 'integrity', label: 'Integrity' },
];

const LLM_MODE = import.meta.env.VITE_LLM_MODE as string | undefined;
const IS_MOCKED_PAYPAL = import.meta.env.VITE_PAYPAL_SIMULATED === 'true';

function TokenForm({ onSave }: { onSave: (t: string) => void }) {
  const [val, setVal] = useState('');
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100vh', gap: 16,
    }}>
      <h1 style={{ fontSize: 20, fontWeight: 700 }}>Stoat Operator Console</h1>
      <p style={{ color: '#64748b', maxWidth: 400, textAlign: 'center' }}>
        Enter your bearer token (e.g. <code>user:YOUR_USER_ID</code> or <code>agent:YOUR_AGENT_ID</code>)
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          aria-label="Bearer token"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && val && onSave(val)}
          placeholder="user:..."
          style={{
            width: 340, padding: '8px 12px', borderRadius: 4,
            background: '#1e2235', border: '1px solid #2d3352', color: '#e2e8f0',
          }}
        />
        <button
          onClick={() => val && onSave(val)}
          style={{
            padding: '8px 16px', background: '#3b82f6', border: 'none', borderRadius: 4,
            color: '#fff', cursor: 'pointer', fontWeight: 600,
          }}
        >
          Connect
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [token, setTokenState] = useState(() => localStorage.getItem('stoat_token') ?? '');
  const [active, setActive] = useState<Workspace>('economy');
  const [apiStatus, setApiStatus] = useState<'unknown' | 'ok' | 'error'>('unknown');

  useEffect(() => {
    if (!token) return;
    api.health()
      .then(() => setApiStatus('ok'))
      .catch(() => setApiStatus('error'));
  }, [token]);

  if (!token) {
    return <TokenForm onSave={(t) => { setToken(t); setTokenState(t); }} />;
  }

  if (apiStatus === 'error') {
    return (
      <div style={{ padding: 32 }} role="alert">
        <h2 style={{ color: '#ef4444' }}>API Unreachable</h2>
        <p style={{ color: '#94a3b8', marginTop: 8 }}>
          Could not connect to the Stoat API. Make sure the server is running on port 3000.
        </p>
        <button
          onClick={() => { api.health().then(() => setApiStatus('ok')).catch(() => setApiStatus('error')); }}
          style={{
            marginTop: 16, padding: '8px 16px', background: '#3b82f6', border: 'none',
            borderRadius: 4, color: '#fff', cursor: 'pointer',
          }}
        >
          Retry
        </button>
        <button
          onClick={() => { setToken(''); setTokenState(''); localStorage.removeItem('stoat_token'); }}
          style={{
            marginTop: 16, marginLeft: 8, padding: '8px 16px', background: '#1e2235',
            border: '1px solid #2d3352', borderRadius: 4, color: '#94a3b8', cursor: 'pointer',
          }}
        >
          Change Token
        </button>
      </div>
    );
  }

  const WORKSPACE_MAP: Record<Workspace, React.ReactNode> = {
    economy: <EconomyWorkspace />,
    agents: <AgentsWorkspace />,
    exchange: <ExchangeWorkspace />,
    quotes: <QuotesAgreementsWorkspace />,
    events: <EventStreamWorkspace />,
    deliveries: <DeliveriesWorkspace />,
    obligations: <ObligationsWorkspace />,
    settlement: <SettlementWorkspace />,
    policy: <PolicyWorkspace />,
    integrity: <IntegrityWorkspace />,
  };

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* Sidebar navigation */}
      <nav
        aria-label="Workspace navigation"
        style={{
          width: 200, background: '#13152a', borderRight: '1px solid #2d3352',
          display: 'flex', flexDirection: 'column', overflow: 'auto',
        }}
      >
        <div style={{ padding: '16px 12px', borderBottom: '1px solid #2d3352' }}>
          <h1 style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>🦦 Stoat Console</h1>
          <p style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>v2.0.0 · Operator</p>
        </div>

        {/* Status honesty labels */}
        <div style={{ padding: '8px 12px', borderBottom: '1px solid #2d3352', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {LLM_MODE === 'replay' && <StatusBadge label="replay mode" variant="replayed" />}
          {LLM_MODE === 'live' && <StatusBadge label="live mode" variant="live" />}
          {LLM_MODE === 'record' && <StatusBadge label="record mode" variant="seeded" />}
          {IS_MOCKED_PAYPAL && <StatusBadge label="mocked paypal" variant="mocked" />}
          <StatusBadge label="seeded data" variant="seeded" />
        </div>

        {NAV_ITEMS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setActive(id)}
            aria-current={active === id ? 'page' : undefined}
            style={{
              padding: '10px 16px',
              background: active === id ? '#252840' : 'transparent',
              border: 'none',
              borderLeft: active === id ? '3px solid #3b82f6' : '3px solid transparent',
              color: active === id ? '#e2e8f0' : '#64748b',
              textAlign: 'left',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: active === id ? 600 : 400,
              transition: 'background 0.1s',
            }}
          >
            {label}
          </button>
        ))}

        <div style={{ marginTop: 'auto', padding: '8px 12px', borderTop: '1px solid #2d3352' }}>
          <button
            onClick={() => { setToken(''); setTokenState(''); localStorage.removeItem('stoat_token'); }}
            style={{
              width: '100%', padding: '6px 0', background: 'none',
              border: '1px solid #2d3352', borderRadius: 4,
              color: '#475569', cursor: 'pointer', fontSize: 11,
            }}
          >
            Change Token
          </button>
        </div>
      </nav>

      {/* Main workspace */}
      <main
        role="main"
        aria-label={`${NAV_ITEMS.find((n) => n.id === active)?.label} workspace`}
        style={{ flex: 1, overflow: 'auto', background: '#0f1117' }}
      >
        {WORKSPACE_MAP[active]}
      </main>
    </div>
  );
}
