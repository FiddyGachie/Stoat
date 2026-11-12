/**
 * PaymentsDashboard — unified payments hub for users and agents.
 *
 * Panels:
 *   1. Account Status Bar — PayPal connection, environment badge, capability status
 *   2. KPI Row — funds held, debited, missions active, awaiting decision
 *   3. Charts Row — budget lifecycle (bar) + 30-day spend trend (area) + utilization donut
 *   4. Mission Spend Setter — set/update the spending budget for a mission
 *   5. Budget Grid — AG Grid of all budgets (sortable, filterable, selectable)
 *   6. Selected Budget Panel — balances, top-up, refund request, debit stream
 *   7. AI Assistant — Fireworks AI chat panel for natural-language payments queries
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle, BadgeCheck, Bot, CircleDollarSign, Banknote,
  CreditCard, HandCoins, MessageSquare, PiggyBank,
  PlusCircle, RefreshCcw, Send, ShieldCheck, Wallet,
  TrendingUp, TriangleAlert, Zap,
} from 'lucide-react';
import type { ColDef } from 'ag-grid-community';
import { GridPanel } from '../components/GridPanel.js';
import { ChartPanel } from '../components/ChartPanel.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { Card, EmptyState, Icon } from '../components/ui.js';
import { useFetch } from '../hooks.js';
import { api } from '../api.js';
import { useLiveRefresh } from '../live.js';

type Row = Record<string, any>;
type Variant = 'ok' | 'error' | 'warning' | 'info' | 'mocked' | 'live' | 'replayed';

// ── Helpers ────────────────────────────────────────────────────────────────────
const short = (v?: string | null) => (v ? `${v.slice(0, 8)}…` : '—');
const fmt = (v: string | number | undefined | null, cur = 'USD') =>
  v != null && v !== '' ? `${Number(v).toFixed(2)} ${cur}` : '—';
function sv(s: string): Variant {
  if (['active', 'retained', 'completed'].includes(s)) return 'ok';
  if (['depleted', 'failed'].includes(s)) return 'error';
  if (s === 'awaiting_decision') return 'warning';
  if (s === 'pending_approval') return 'mocked';
  if (s === 'refunded') return 'info';
  return 'info';
}
const sl = (s: string) => s.replace(/_/g, ' ');

// ── AG Grid column definitions ─────────────────────────────────────────────────
const budgetCols: ColDef[] = [
  { field: 'id', headerName: 'ID', width: 110, valueFormatter: ({ value }) => short(value) },
  { field: 'amount', headerName: 'Approved', width: 115,
    valueFormatter: ({ value, data }) => fmt(value, data?.currency) },
  { field: 'balance', headerName: 'Remaining', width: 115,
    valueFormatter: ({ value, data }) => fmt(value, data?.currency),
    cellStyle: ({ value, data }: { value: any; data: any }) => ({
      color: (Number(value) <= 0 ? 'var(--color-danger)' : Number(value) < Number(data?.amount) * 0.1 ? 'var(--color-warning)' : 'var(--color-success)') as string,
      fontWeight: '600' as string,
    }) },
  { field: 'utilization_pct', headerName: 'Used %', width: 90,
    valueFormatter: ({ value }) => `${Number(value ?? 0).toFixed(1)}%`,
    cellRenderer: ({ value }: { value: number }) => {
      const pct = Number(value ?? 0);
      const c = pct >= 90 ? 'var(--color-danger)' : pct >= 70 ? 'var(--color-warning)' : 'var(--color-primary)';
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div style={{ flex: 1, background: 'var(--border-subtle)', borderRadius: 3, height: 7 }}>
            <div style={{ width: `${Math.min(pct, 100)}%`, background: c, borderRadius: 3, height: 7 }} />
          </div>
          <span style={{ minWidth: 40, fontSize: 11, color: c }}>{pct.toFixed(1)}%</span>
        </div>
      );
    } },
  { field: 'status', headerName: 'Status', width: 155,
    cellRenderer: ({ value }: { value: string }) =>
      <StatusBadge label={sl(value)} variant={sv(value)} /> },
  { field: 'currency', headerName: 'Cur', width: 60 },
  { field: 'mission_id', headerName: 'Mission', width: 110,
    valueFormatter: ({ value }) => short(value) },
  { field: 'paypal_environment', headerName: 'Env', width: 80,
    cellRenderer: ({ value }: { value: string }) =>
      value ? <StatusBadge label={value} variant={value === 'live' ? 'ok' : 'info'} /> : <span>—</span> },
  { field: 'activated_at', headerName: 'Activated', width: 140,
    valueFormatter: ({ value }) => value ? new Date(value).toLocaleString() : '—' },
  { field: 'created_at', headerName: 'Created', width: 140,
    valueFormatter: ({ value }) => new Date(value).toLocaleString() },
];

const debitCols: ColDef[] = [
  { field: 'created_at', headerName: 'Time', width: 145,
    valueFormatter: ({ value }) => new Date(value).toLocaleString() },
  { field: 'amount', headerName: 'Debited', width: 105,
    valueFormatter: ({ value, data }) => fmt(value, data?.currency) },
  { field: 'balance_after', headerName: 'After', width: 110,
    valueFormatter: ({ value, data }) => fmt(value, data?.currency),
    cellStyle: ({ value }: { value: any }) => ({ color: (Number(value) === 0 ? 'var(--color-danger)' : 'var(--text-primary)') as string }) },
  { field: 'reason', headerName: 'Reason', flex: 1, minWidth: 120 },
  { field: 'actor_type', headerName: 'Actor', width: 90,
    cellRenderer: ({ value }: { value: string }) =>
      <StatusBadge label={value} variant={value === 'agent' ? 'live' : 'info'} /> },
];

// ── Small UI pieces ────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, icon, accent = 'var(--color-primary)' }: {
  label: string; value: string; sub?: string; icon: typeof Banknote; accent?: string;
}) {
  return (
    <div style={{ background: 'var(--surface-muted)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
      <div style={{ background: `${accent}22`, borderRadius: 8, padding: 9, flexShrink: 0 }}>
        <Icon icon={icon} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 21, fontWeight: 700, lineHeight: 1.2, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sub}</div>}
      </div>
    </div>
  );
}

// ── Account Status Bar ─────────────────────────────────────────────────────────
function AccountStatusBar() {
  const ppStatus = useFetch(() => api.paypalStatus());
  const health = useFetch(() => api.health());

  const pp = ppStatus.status === 'ok' ? ppStatus.data : null;
  const llm = health.status === 'ok' ? health.data.llm : null;

  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', padding: '10px 14px', background: 'var(--surface-muted)', border: '1px solid var(--border-subtle)', borderRadius: 10, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon icon={CreditCard} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>PayPal</span>
        {ppStatus.status === 'loading' && <StatusBadge label="checking…" variant="info" />}
        {pp && !pp.configured && <StatusBadge label="not connected" variant="error" />}
        {pp?.configured && <StatusBadge label={`${pp.environment ?? ''} connected`} variant={pp.environment === 'live' ? 'ok' : 'info'} />}
        {pp?.configured && <StatusBadge label={pp.payouts.enabled ? 'payouts enabled' : 'payouts off'} variant={pp.payouts.enabled ? 'ok' : 'warning'} />}
      </div>
      <div style={{ width: 1, height: 20, background: 'var(--border-subtle)' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon icon={Bot} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>AI</span>
        {llm && <StatusBadge label={`${llm.provider} · ${llm.mode}`} variant={llm.mode === 'live' || llm.mode === 'record' ? 'live' : 'replayed'} />}
        {llm && !llm.key_configured && <StatusBadge label="no API key" variant="warning" />}
        {llm?.model && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{llm.model.split('/').pop()}</span>}
      </div>
      {pp && !pp.configured && (
        <>
          <div style={{ width: 1, height: 20, background: 'var(--border-subtle)' }} />
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in your environment to connect PayPal.</span>
        </>
      )}
    </div>
  );
}

// ── Mission Spend Setter ───────────────────────────────────────────────────────
function MissionSpendSetter({ onCreated }: { onCreated: (b: Row) => void }) {
  const missions = useFetch(() => api.missions());
  const [missionId, setMissionId] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Row | null>(null);

  const handle = async () => {
    setBusy(true); setError(null);
    try {
      const res = await api.budgets.create({ amount, currency, mission_id: missionId || undefined });
      setResult(res.budget);
      onCreated(res.budget);
    } catch (e: any) { setError(e?.message ?? 'Failed'); }
    finally { setBusy(false); }
  };

  if (result) return (
    <Card title="Spend budget created" icon={BadgeCheck}>
      <dl className="kv">
        <dt>Budget ID</dt><dd><code>{result.id}</code></dd>
        <dt>Amount</dt><dd style={{ color: 'var(--color-primary)', fontWeight: 700 }}>{fmt(result.amount, result.currency)}</dd>
        <dt>Status</dt><dd><StatusBadge label={sl(result.status)} variant={sv(result.status)} /></dd>
      </dl>
      {result.approve_url && (
        <a href={result.approve_url} target="_blank" rel="noopener noreferrer"
          style={{ display: 'inline-flex', marginTop: 12, padding: '8px 16px', background: 'var(--color-primary)', color: 'var(--surface-solid)', borderRadius: 6, textDecoration: 'none', fontWeight: 600, fontSize: 13 }}>
          Approve in PayPal →
        </a>
      )}
      <p className="card-sub" style={{ marginTop: 10 }}>
        After PayPal approval the budget activates. Agents will debit against it — one PayPal hold, zero micro-calls.
      </p>
    </Card>
  );

  const missionList = missions.status === 'ok' ? missions.data.missions : [];
  return (
    <Card title="Set mission spending budget" icon={PiggyBank}>
      <p className="card-sub" style={{ marginBottom: 14 }}>
        Pre-approve a spending cap for a mission. Funds are held by PayPal once. Agents debit the allocation without additional PayPal calls.
      </p>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))' }}>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Mission (optional)</label>
          <select className="grid-search-input" style={{ width: '100%', background: 'var(--surface-solid)' }}
            value={missionId} onChange={(e) => setMissionId(e.target.value)}>
            <option value="">No specific mission</option>
            {missionList.map((m) => (
              <option key={m.id} value={m.id}>{m.title} ({m.status})</option>
            ))}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Amount *</label>
          <input type="number" className="grid-search-input" style={{ width: '100%' }}
            min="0.01" step="0.01" placeholder="e.g. 25.00"
            value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Currency</label>
          <select className="grid-search-input" style={{ width: '100%', background: 'var(--surface-solid)' }}
            value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="USD">USD</option><option value="EUR">EUR</option><option value="GBP">GBP</option>
          </select>
        </div>
      </div>
      {error && <div className="notice notice-error" style={{ marginTop: 10, display: 'flex', gap: 6 }}><Icon icon={TriangleAlert} /><span>{error}</span></div>}
      <button type="button" disabled={busy || !amount}
        style={{ marginTop: 14, padding: '8px 16px', background: busy || !amount ? 'var(--border-subtle)' : 'var(--color-primary)', color: busy || !amount ? 'var(--text-muted)' : 'var(--surface-solid)', border: 'none', borderRadius: 6, cursor: busy || !amount ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 13 }}
        onClick={handle}>
        {busy ? 'Creating…' : 'Create budget & authorise in PayPal'}
      </button>
    </Card>
  );
}

// ── Top-up Panel ──────────────────────────────────────────────────────────────
function TopUpPanel({ budget, onDone }: { budget: Row; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [currency] = useState(budget.currency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Row | null>(null);

  const handle = async () => {
    setBusy(true); setError(null);
    try {
      // A top-up is a brand-new budget on the same mission, pre-linking to the same mission.
      const res = await api.budgets.create({ amount, currency, mission_id: budget.mission_id || undefined });
      setResult(res.budget);
      onDone();
    } catch (e: any) { setError(e?.message ?? 'Failed'); }
    finally { setBusy(false); }
  };

  if (result) return (
    <Card title="Top-up created" icon={PlusCircle}>
      <p className="card-sub">New budget <code>{result.id.slice(0, 8)}…</code> created.
        {result.approve_url && <> <a href={result.approve_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)' }}>Approve in PayPal →</a></>}
      </p>
    </Card>
  );

  return (
    <Card title={`Top up — add more funds to mission`} icon={PlusCircle}>
      <p className="card-sub" style={{ marginBottom: 12 }}>
        Current balance: <strong style={{ color: 'var(--color-success)' }}>{fmt(budget.balance, budget.currency)}</strong> of {fmt(budget.amount, budget.currency)} approved.
        A top-up creates a new budget linked to the same mission.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Top-up amount *</label>
          <input type="number" className="grid-search-input" style={{ width: 150 }}
            min="0.01" step="0.01" placeholder="e.g. 10.00"
            value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <button type="button" disabled={busy || !amount}
          style={{ padding: '8px 14px', background: busy || !amount ? 'var(--border-subtle)' : 'var(--color-success)', color: busy || !amount ? 'var(--text-muted)' : 'var(--surface-solid)', border: 'none', borderRadius: 6, cursor: busy || !amount ? 'not-allowed' : 'pointer', fontWeight: 600 }}
          onClick={handle}>
          {busy ? 'Creating…' : 'Top up'}
        </button>
      </div>
      {error && <div className="notice notice-error" style={{ marginTop: 8, display: 'flex', gap: 6 }}><Icon icon={TriangleAlert} /><span>{error}</span></div>}
    </Card>
  );
}

// ── Refund Panel ──────────────────────────────────────────────────────────────
function RefundPanel({ budget, onDone }: { budget: Row; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Row | null>(null);
  const canRefund = budget.status === 'awaiting_decision';

  const handle = async () => {
    setBusy(true); setError(null);
    try {
      const res = await api.budgets.decide(budget.id, 'refund', note || undefined);
      setResult(res.decision);
      onDone();
    } catch (e: any) { setError(e?.message ?? 'Refund failed'); }
    finally { setBusy(false); }
  };

  if (!canRefund) return (
    <Card title="Request a refund" icon={HandCoins}>
      <div className="notice notice-info" style={{ display: 'flex', gap: 8 }}>
        <Icon icon={AlertCircle} />
        <span>Refunds are only available for budgets in <strong>awaiting decision</strong> state (mission completed with remaining balance). Current status: <strong>{sl(budget.status)}</strong>.</span>
      </div>
    </Card>
  );

  if (result) return (
    <Card title="Refund requested" icon={ShieldCheck}>
      <dl className="kv">
        <dt>Decision</dt><dd><StatusBadge label={result.decision} variant="info" /></dd>
        {result.paypal_refund_id && <><dt>PayPal refund ID</dt><dd><code>{result.paypal_refund_id}</code></dd></>}
        {result.refund_status && <><dt>Refund status</dt><dd><StatusBadge label={result.refund_status} variant="ok" /></dd></>}
      </dl>
    </Card>
  );

  return (
    <Card title="Request refund of remaining balance" icon={HandCoins}>
      <p className="card-sub" style={{ marginBottom: 12 }}>
        Remaining balance: <strong style={{ color: 'var(--color-warning)' }}>{fmt(budget.balance, budget.currency)}</strong> will be returned to your PayPal account.
      </p>
      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>Reason (optional)</label>
        <input type="text" className="grid-search-input" style={{ width: '100%' }} maxLength={300}
          placeholder="Why are you requesting a refund?" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {error && <div className="notice notice-error" style={{ marginTop: 8, display: 'flex', gap: 6 }}><Icon icon={TriangleAlert} /><span>{error}</span></div>}
      <button type="button" disabled={busy}
        style={{ padding: '8px 14px', background: busy ? 'var(--border-subtle)' : 'var(--color-danger)', color: busy ? 'var(--text-muted)' : 'var(--surface-solid)', border: 'none', borderRadius: 6, cursor: busy ? 'not-allowed' : 'pointer', fontWeight: 600 }}
        onClick={handle}>
        {busy ? 'Processing…' : 'Confirm refund via PayPal'}
      </button>
    </Card>
  );
}

// ── AI Assistant Panel ─────────────────────────────────────────────────────────
interface ChatMsg { role: 'user' | 'assistant'; content: string; confidence?: string; actions?: { label: string; action: string }[] }

function AiAssistantPanel({ selectedBudget }: { selectedBudget?: Row }) {
  const [messages, setMessages] = useState<ChatMsg[]>([
    { role: 'assistant', content: 'Hi! I\'m your Payments Assistant powered by Fireworks AI. Ask me anything about your spending budgets, balances, analytics, or what to do next.', confidence: 'high' }
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const suggestions = [
    'How much have I spent this month?',
    'Which budgets are running low?',
    'Should I top up my active budget?',
    'Explain my utilization rate',
    'How do I request a refund?',
    'What is my total funds on hold?',
  ];

  const send = async (q?: string) => {
    const question = q ?? input.trim();
    if (!question) return;
    setInput('');
    setBusy(true);
    setError(null);
    const userMsg: ChatMsg = { role: 'user', content: question };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const history = messages.slice(-6).map((m) => ({ role: m.role, content: m.content }));
      const res = await api.paymentsAiAssist({
        question,
        budget_id: selectedBudget?.id,
        mission_id: selectedBudget?.mission_id ?? undefined,
        history,
      });
      const assistMsg: ChatMsg = {
        role: 'assistant',
        content: res.reply.answer,
        confidence: res.reply.confidence,
        actions: res.reply.action_hints.filter((h) => h.action !== 'none'),
      };
      setMessages((prev) => [...prev, assistMsg]);
    } catch (e: any) {
      setError(e?.message ?? 'AI assistant unavailable');
      setMessages((prev) => prev.slice(0, -1)); // remove the user msg on error
    } finally {
      setBusy(false);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
  };

  const confidenceColor = (c?: string) =>
    c === 'high' ? 'var(--color-success)' : c === 'medium' ? 'var(--color-warning)' : 'var(--text-muted)';

  return (
    <Card title="Payments AI Assistant" icon={Bot}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Icon icon={Zap} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Powered by Fireworks AI · answers are based on your live account data</span>
      </div>

      {/* Chat history */}
      <div style={{ height: 340, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '10px 12px', marginBottom: 10, background: 'var(--surface-muted)', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start', gap: 4 }}>
            <div style={{
              maxWidth: '86%', padding: '8px 12px', borderRadius: m.role === 'user' ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
              background: m.role === 'user' ? 'var(--color-primary)' : 'var(--surface-solid)',
              color: m.role === 'user' ? 'var(--surface-solid)' : 'var(--text-primary)',
              border: m.role === 'assistant' ? '1px solid var(--border-subtle)' : 'none',
              fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap',
            }}>
              {m.content}
            </div>
            {m.confidence && m.role === 'assistant' && (
              <span style={{ fontSize: 10, color: confidenceColor(m.confidence) }}>
                {m.confidence} confidence
              </span>
            )}
            {m.actions && m.actions.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {m.actions.map((a, ai) => (
                  <button key={ai} type="button"
                    style={{ padding: '4px 10px', fontSize: 11, background: 'var(--surface-muted)', border: '1px solid var(--border-subtle)', borderRadius: 20, cursor: 'pointer', color: 'var(--color-primary)', fontWeight: 600 }}
                    onClick={() => send(`Tell me more about: ${a.label}`)}>
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div style={{ alignSelf: 'flex-start', padding: '8px 12px', background: 'var(--surface-solid)', border: '1px solid var(--border-subtle)', borderRadius: '12px 12px 12px 2px', fontSize: 13, color: 'var(--text-muted)' }}>
            Thinking…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Suggestion chips */}
      {messages.length <= 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {suggestions.map((s, i) => (
            <button key={i} type="button" onClick={() => send(s)}
              style={{ padding: '5px 10px', fontSize: 12, background: 'var(--surface-muted)', border: '1px solid var(--border-subtle)', borderRadius: 20, cursor: 'pointer', color: 'var(--text-muted)' }}>
              {s}
            </button>
          ))}
        </div>
      )}

      {error && <div className="notice notice-error" style={{ marginBottom: 8, display: 'flex', gap: 6 }}><Icon icon={TriangleAlert} /><span>{error}</span></div>}

      {/* Input */}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text" className="grid-search-input" style={{ flex: 1 }}
          placeholder="Ask about balances, spend, refunds, top-ups…"
          value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !busy) send(); }}
          disabled={busy} maxLength={400}
        />
        <button type="button" disabled={busy || !input.trim()}
          style={{ padding: '8px 14px', background: busy || !input.trim() ? 'var(--border-subtle)' : 'var(--color-primary)', color: busy || !input.trim() ? 'var(--text-muted)' : 'var(--surface-solid)', border: 'none', borderRadius: 6, cursor: busy || !input.trim() ? 'not-allowed' : 'pointer' }}
          onClick={() => send()}>
          <Icon icon={Send} />
        </button>
      </div>
      {selectedBudget && (
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
          Context: budget <code>{selectedBudget.id.slice(0, 8)}…</code> · {fmt(selectedBudget.balance, selectedBudget.currency)} remaining
        </p>
      )}
    </Card>
  );
}

// ── Pending budget actions (check PayPal / edit / delete) ─────────────────────
// For budgets that never went through at PayPal. The server checks PayPal before any change
// and refuses if the buyer actually approved, so a real payment is never discarded.
function PendingBudgetActions({ budget, onChanged, onDeleted }: {
  budget: Row; onChanged: (newId?: string) => void; onDeleted: () => void;
}) {
  const [mode, setMode] = useState<'idle' | 'edit'>('idle');
  const [amount, setAmount] = useState(String(Number(budget.amount)));
  const [currency, setCurrency] = useState(String(budget.currency ?? 'USD'));
  const [busy, setBusy] = useState<null | 'sync' | 'save' | 'delete'>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setMode('idle'); setMsg(null);
    setAmount(String(Number(budget.amount))); setCurrency(String(budget.currency ?? 'USD'));
  }, [budget.id]);

  const check = async () => {
    setBusy('sync'); setMsg(null);
    try {
      const { budget: b } = await api.budgets.sync(budget.id);
      setMsg(b.status === 'pending_approval'
        ? { ok: false, text: 'PayPal reports this order is not approved yet.' }
        : { ok: true, text: 'Budget is now ' + sl(b.status) + '.' });
      onChanged();
    } catch (e: any) { setMsg({ ok: false, text: e?.message ?? 'Could not check PayPal.' }); }
    finally { setBusy(null); }
  };

  const save = async () => {
    const a = amount.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(a) || Number(a) <= 0) {
      setMsg({ ok: false, text: 'Enter an amount greater than 0 with at most 2 decimals.' });
      return;
    }
    setBusy('save'); setMsg(null);
    try {
      const { budget: b } = await api.budgets.edit(budget.id, { amount: a, currency });
      setMode('idle');
      onChanged(b.id);
    } catch (e: any) { setMsg({ ok: false, text: e?.message ?? 'Could not update the budget.' }); onChanged(); }
    finally { setBusy(null); }
  };

  const remove = async () => {
    if (!window.confirm('Delete this pending budget? It was never approved in PayPal, so no money has moved. Stoat checks PayPal first and keeps the budget if it was approved.')) return;
    setBusy('delete'); setMsg(null);
    try {
      await api.budgets.remove(budget.id);
      onDeleted();
    } catch (e: any) { setMsg({ ok: false, text: e?.message ?? 'Could not delete the budget.' }); onChanged(); }
    finally { setBusy(null); }
  };

  const btn = (danger = false): React.CSSProperties => ({
    padding: '6px 14px', background: 'var(--surface-muted)', color: danger ? 'var(--color-danger)' : 'var(--text-primary)',
    border: '1px solid var(--border-subtle)', borderRadius: 6, cursor: busy ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 12,
  });

  return (
    <div style={{ marginTop: 10 }}>
      {mode === 'edit' ? (
        <form style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }} noValidate
          onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label className="card-sub" style={{ display: 'grid', gap: 4 }}>
            Amount
            <input type="text" inputMode="decimal" className="grid-search-input" style={{ width: 120 }}
              value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy !== null} />
          </label>
          <label className="card-sub" style={{ display: 'grid', gap: 4 }}>
            Currency
            <select className="grid-search-input" value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={busy !== null}>
              {['USD', 'EUR', 'GBP'].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <button type="submit" disabled={busy !== null} aria-busy={busy === 'save'}
            style={{ ...btn(), background: 'var(--color-primary)', color: 'var(--surface-solid)', border: 'none' }}>
            {busy === 'save' ? 'Saving…' : 'Save & new PayPal link'}
          </button>
          <button type="button" style={btn()} disabled={busy !== null} onClick={() => { setMode('idle'); setMsg(null); }}>Cancel</button>
        </form>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" style={btn()} disabled={busy !== null} aria-busy={busy === 'sync'} onClick={() => void check()}>
            {busy === 'sync' ? 'Checking…' : 'Check PayPal status'}
          </button>
          <button type="button" style={btn()} disabled={busy !== null} onClick={() => { setMode('edit'); setMsg(null); }}>Edit</button>
          <button type="button" style={btn(true)} disabled={busy !== null} aria-busy={busy === 'delete'} onClick={() => void remove()}>
            {busy === 'delete' ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      )}
      {msg && (
        <p role={msg.ok ? 'status' : 'alert'} style={{ fontSize: 12, marginTop: 8, color: msg.ok ? 'var(--color-success)' : 'var(--color-danger)' }}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

// ── Main Workspace ─────────────────────────────────────────────────────────────
export const PaymentsDashboard: React.FC = () => {
  const [selectedBudgetId, setSelectedBudgetId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [activePanel, setActivePanel] = useState<'topup' | 'refund' | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  // PayPal sends the buyer back here (?budget_id&budget_status); the server already tried to activate.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const id = q.get('budget_id');
    if (!id) return;
    const st = q.get('budget_status') ?? '';
    const err = q.get('budget_error');
    setSelectedBudgetId(id);
    setNotice(q.get('paypal') === 'cancel'
      ? { ok: false, text: 'PayPal checkout was cancelled. The budget is still waiting for approval; you can edit or delete it below.' }
      : st === 'active' ? { ok: true, text: 'Budget approved in PayPal and activated.' }
      : st === 'failed' ? { ok: false, text: 'PayPal did not complete the payment, so the budget could not be activated.' }
      : { ok: false, text: 'Back from PayPal, but the budget is not active yet' + (err ? ' (' + err + ')' : '') + '. Use "Check PayPal status" below.' });
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    refresh();
  }, [refresh]);

  const budgets = useFetch(() => api.budgets.list(), [refreshKey]);
  const analytics = useFetch(() => api.budgets.analytics(), [refreshKey]);
  const paypalSt = useFetch(() => api.paypalStatus(), [refreshKey]);
  const debits = useFetch(
    () => selectedBudgetId ? api.budgets.debits(selectedBudgetId) : Promise.resolve({ debits: [] }),
    [selectedBudgetId, refreshKey]
  );

  // Budgets, spend and charts follow the wallet live (every 15 s, and on a new notification).
  useLiveRefresh(() => {
    budgets.reload();
    analytics.reload();
    debits.reload();
  });

  const rows: Row[] = budgets.status === 'ok' ? budgets.data.budgets : [];
  const ad = analytics.status === 'ok' ? analytics.data : null;
  const selected = rows.find((r) => r.id === selectedBudgetId) ?? null;

  // KPIs
  const active = rows.filter((r) => r.status === 'active');
  const totalHeld = active.reduce((s, r) => s + Number(r.balance), 0);
  const totalDebited = rows.reduce((s, r) => s + Number(r.total_debited), 0);
  const awaiting = rows.filter((r) => r.status === 'awaiting_decision').length;
  const depleted = rows.filter((r) => r.status === 'depleted').length;

  // Chart data
  const statusChartData = ad?.by_status?.map((d: any) => ({
    status: sl(d.status), count: d.count, total: Number(d.total_amount ?? 0),
  })) ?? [];

  const dailyData = ad?.daily_debits?.map((d: any) => ({
    day: String(d.day ?? '').slice(0, 10),
    total: Number(d.total ?? 0),
    count: Number(d.count ?? 0),
  })) ?? [];

  const histogramData = ad?.utilization_histogram?.map((d: any) => ({
    bucket: d.bucket, count: d.count,
  })) ?? [];

  const topReasonsData = ad?.top_debit_reasons?.map((d: any) => ({
    reason: d.reason, total: Number(d.total ?? 0),
  })) ?? [];

  const tabBtn = (label: string, panel: 'topup' | 'refund' | null) => (
    <button type="button" onClick={() => setActivePanel(activePanel === panel ? null : panel)}
      style={{ padding: '6px 14px', background: activePanel === panel ? 'var(--color-primary)' : 'var(--surface-muted)', color: activePanel === panel ? 'var(--surface-solid)' : 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
      {label}
    </button>
  );

  return (
    <>
      {notice && (
        <div className={notice.ok ? 'notice notice-success' : 'notice notice-error'} role="status"
          style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <span style={{ flex: 1 }}>{notice.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontWeight: 700 }}>×</button>
        </div>
      )}
      {/* ── Account Status Bar ──────────────────────── */}
      <AccountStatusBar />

      {/* ── Action Bar ────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <button type="button"
          style={{ padding: '7px 14px', background: showCreate ? 'var(--border-subtle)' : 'var(--color-primary)', color: showCreate ? 'var(--text-primary)' : 'var(--surface-solid)', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
          onClick={() => setShowCreate((v) => !v)}>
          <Icon icon={PlusCircle} /> {showCreate ? 'Cancel' : 'Set mission spend'}
        </button>
        <button type="button" onClick={refresh}
          style={{ padding: '7px 12px', background: 'var(--surface-muted)', border: '1px solid var(--border-subtle)', borderRadius: 6, cursor: 'pointer', display: 'flex', gap: 4, alignItems: 'center', fontSize: 13 }}>
          <Icon icon={RefreshCcw} /> Refresh
        </button>
        {awaiting > 0 && (
          <div className="notice notice-error" role="status"
            style={{ margin: 0, padding: '5px 12px', display: 'flex', gap: 6, fontSize: 12 }}>
            <Icon icon={TriangleAlert} />
            <strong>{awaiting}</strong> budget{awaiting > 1 ? 's' : ''} awaiting your decision
          </div>
        )}
      </div>

      {/* ── Mission Spend Setter ──────────────────────────── */}
      {showCreate && (
        <div style={{ marginBottom: 16 }}>
          <MissionSpendSetter onCreated={() => { setShowCreate(false); refresh(); }} />
        </div>
      )}

      {/* ── KPI Row ──────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))', gap: 10, marginBottom: 18 }}>
        <KpiCard label="Active Budgets" value={String(active.length)} icon={CircleDollarSign} accent='var(--color-primary)' />
        <KpiCard label="Funds On Hold" value={`$${totalHeld.toFixed(2)}`} sub="PayPal-authorised" icon={Banknote} accent='var(--color-violet)' />
        <KpiCard label="Total Spent" value={`$${totalDebited.toFixed(2)}`} sub="micro-debits applied" icon={TrendingUp} accent='var(--color-info)' />
        <KpiCard label="Awaiting Decision" value={String(awaiting)} sub="refund or retain?" icon={MessageSquare} accent={awaiting > 0 ? 'var(--color-warning)' : 'var(--text-muted)'} />
        <KpiCard label="Depleted" value={String(depleted)} sub="mission stopped" icon={AlertCircle} accent={depleted > 0 ? 'var(--color-danger)' : 'var(--text-muted)'} />
        {paypalSt.status === 'ok' && paypalSt.data.configured && (
          <KpiCard label="PayPal" value={paypalSt.data.environment ?? '—'} sub={paypalSt.data.webhook_configured ? 'webhook active' : 'no webhook'} icon={ShieldCheck} accent={paypalSt.data.environment === 'live' ? 'var(--color-success)' : 'var(--color-primary)'} />
        )}
      </div>

      {/* ── Charts Row 1 ─────────────────────────────────── */}
      <div className="card-grid card-grid--wide" style={{ marginBottom: 16 }}>
        <ChartPanel title="Budgets by Status" data={statusChartData}
          loading={analytics.status === 'loading'} error={analytics.status === 'error' ? analytics.error : undefined}
          series={[{ type: 'bar', xKey: 'status', yKey: 'count', yName: 'Count', fill: 'var(--color-primary)',
            tooltip: { renderer: ({ datum }: any) => ({ content: `${datum.status}: ${datum.count} budgets · $${Number(datum.total ?? 0).toFixed(2)}` }) } }]}
        />
        <ChartPanel title="30-Day Spend Trend" data={dailyData}
          loading={analytics.status === 'loading'} error={analytics.status === 'error' ? analytics.error : undefined}
          series={[{ type: 'area', xKey: 'day', yKey: 'total', yName: 'Debited', fill: 'var(--color-violet)', stroke: 'var(--color-violet)', fillOpacity: 0.25,
            tooltip: { renderer: ({ datum }: any) => ({ content: `${datum.day}: $${Number(datum.total ?? 0).toFixed(2)} (${datum.count} debits)` }) } }]}
        />
      </div>

      {/* ── Charts Row 2 ─────────────────────────────────── */}
      <div className="card-grid card-grid--wide" style={{ marginBottom: 16 }}>
        <ChartPanel title="Utilization Distribution" data={histogramData}
          loading={analytics.status === 'loading'} error={analytics.status === 'error' ? analytics.error : undefined}
          series={[{ type: 'bar', xKey: 'bucket', yKey: 'count', yName: 'Budgets', fill: 'var(--color-info)',
            tooltip: { renderer: ({ datum }: any) => ({ content: `${datum.bucket}: ${datum.count} budgets` }) } }]}
        />
        <ChartPanel title="Top Spend Reasons" data={topReasonsData}
          loading={analytics.status === 'loading'} error={analytics.status === 'error' ? analytics.error : undefined}
          series={[{ type: 'bar', direction: 'horizontal', xKey: 'reason', yKey: 'total', yName: 'Total ($)', fill: 'var(--color-warning)',
            tooltip: { renderer: ({ datum }: any) => ({ content: `${datum.reason}: $${Number(datum.total ?? 0).toFixed(2)}` }) } }]}
        />
      </div>

      {/* ── Budgets Grid ──────────────────────────────────── */}
      <GridPanel
        title="All Spending Budgets"
        rows={rows}
        cols={budgetCols}
        loading={budgets.status === 'loading'}
        error={budgets.status === 'error' ? budgets.error : undefined}
        onRowClick={(row) => {
          const id = (row as Row).id;
          setSelectedBudgetId(id === selectedBudgetId ? null : id);
          setActivePanel(null);
        }}
        getRowId={(p) => (p.data as Row).id}
        badge={awaiting > 0 ? <span style={{ fontSize: 12, color: 'var(--color-warning)', display: 'flex', gap: 4 }}><Icon icon={TriangleAlert} />{awaiting} need decision</span> : undefined}
      />

      {/* ── Selected Budget Detail ────────────────────────── */}
      {selected ? (
        <div style={{ marginTop: 16, display: 'grid', gap: 14 }}>
          {/* Summary */}
          <Card title={`Budget ${short(selected.id)} — ${sl(selected.status)}`} icon={Wallet}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))', gap: 12, marginBottom: 12 }}>
              {[
                ['Pre-approved', fmt(selected.amount, selected.currency), 'var(--color-primary)'],
                ['Remaining', fmt(selected.balance, selected.currency), Number(selected.balance) < Number(selected.amount) * 0.1 ? 'var(--color-danger)' : 'var(--color-success)'],
                ['Total debited', fmt(selected.total_debited, selected.currency), 'var(--text-primary)'],
              ].map(([label, val, color]) => (
                <div key={label}>
                  <span className="card-sub">{label}</span>
                  <div style={{ fontSize: 18, fontWeight: 700, color: color as string, marginTop: 2 }}>{val}</div>
                </div>
              ))}
              <div>
                <span className="card-sub">Utilization</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <div style={{ flex: 1, background: 'var(--border-subtle)', borderRadius: 4, height: 10 }}>
                    <div style={{ width: `${Math.min(selected.utilization_pct, 100)}%`, background: selected.utilization_pct >= 90 ? 'var(--color-danger)' : selected.utilization_pct >= 70 ? 'var(--color-warning)' : 'var(--color-primary)', borderRadius: 4, height: 10 }} />
                  </div>
                  <strong>{Number(selected.utilization_pct ?? 0).toFixed(1)}%</strong>
                </div>
              </div>
            </div>

            {selected.status === 'pending_approval' && selected.approve_url && (
              <div className="notice notice-info" style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <Icon icon={ShieldCheck} />
                <span>Funds not yet authorised. <a href={selected.approve_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)', fontWeight: 600 }}>Approve in PayPal →</a></span>
              </div>
            )}
            {selected.status === 'depleted' && (
              <div className="notice notice-error" style={{ display: 'flex', gap: 8 }}>
                <Icon icon={TriangleAlert} />
                <span><strong>Budget depleted.</strong> Mission stopped. Top up to continue.</span>
              </div>
            )}
            {selected.status === 'awaiting_decision' && (
              <div className="notice notice-error" style={{ display: 'flex', gap: 8 }}>
                <Icon icon={MessageSquare} />
                <span><strong>Mission complete with remaining balance.</strong> Choose to refund or retain below.</span>
              </div>
            )}

            {/* Action buttons */}
            {selected.status === 'pending_approval' ? (
              <PendingBudgetActions
                budget={selected}
                onChanged={(newId) => {
                  if (newId) {
                    setSelectedBudgetId(newId);
                    setNotice({ ok: true, text: 'Budget updated. Use the new "Approve in PayPal" link to authorise it.' });
                  }
                  refresh();
                }}
                onDeleted={() => {
                  setSelectedBudgetId(null);
                  setNotice({ ok: true, text: 'Pending budget deleted. No money had moved.' });
                  refresh();
                }}
              />
            ) : selected.status !== 'cancelled' && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                {tabBtn('Top up', 'topup')}
                {tabBtn('Request refund', 'refund')}
              </div>
            )}
          </Card>

          {/* Top-up / Refund panels */}
          {activePanel === 'topup' && <TopUpPanel budget={selected} onDone={() => { setActivePanel(null); refresh(); }} />}
          {activePanel === 'refund' && <RefundPanel budget={selected} onDone={() => { setActivePanel(null); refresh(); }} />}
          {selected.status === 'awaiting_decision' && activePanel === null && (
            <Card title="Remainder decision required" icon={HandCoins}>
              <p className="card-sub" style={{ marginBottom: 10 }}>
                Your mission completed with <strong style={{ color: 'var(--color-warning)' }}>{fmt(selected.balance, selected.currency)}</strong> remaining. What would you like to do?
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => setActivePanel('refund')}
                  style={{ padding: '8px 16px', background: 'var(--color-danger)', color: 'var(--surface-solid)', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
                  Refund via PayPal
                </button>
                <button type="button" onClick={async () => {
                  try { await api.budgets.decide(selected.id, 'retain'); refresh(); }
                  catch { /* handled in panel */ }
                }}
                  style={{ padding: '8px 16px', background: 'var(--color-success)', color: 'var(--surface-solid)', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
                  Keep for next mission
                </button>
              </div>
            </Card>
          )}

          {/* Debit stream */}
          <GridPanel
            title={`Micro-payment Stream — ${short(selected.id)}`}
            rows={debits.status === 'ok' ? debits.data.debits : []}
            cols={debitCols}
            loading={debits.status === 'loading'}
            error={debits.status === 'error' ? debits.error : undefined}
            getRowId={(p) => (p.data as Row).id}
            badge={<span className="card-sub" style={{ fontSize: 12 }}>{debits.status === 'ok' ? debits.data.debits.length : 0} debits · no PayPal call per debit</span>}
          />
        </div>
      ) : (
        <Card title="Select a budget" icon={CircleDollarSign}>
          <EmptyState title="Click a row above to inspect it">
            View balances, top up, request a refund, or ask the AI assistant for advice.
          </EmptyState>
        </Card>
      )}

      {/* ── AI Assistant ──────────────────────────────────── */}
      <div style={{ marginTop: 16 }}>
        <AiAssistantPanel selectedBudget={selected ?? undefined} />
      </div>
    </>
  );
};
