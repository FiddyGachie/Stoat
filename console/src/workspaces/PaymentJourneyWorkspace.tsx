/**
 * PaymentJourneyWorkspace — the complete payment journey: pre-approve, hold, debit, decide.
 *
 * Layout:
 *   1. Summary KPI cards + Utilization donut (ChartPanel)
 *   2. Daily debit activity chart (line/area)
 *   3. Budget breakdown by status (bar chart)
 *   4. AG Grid: all budgets with full lifecycle status
 *   5. Detail panel on row click: debit stream grid + remainder decision panel
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  Banknote, CircleDollarSign, GitMerge, HandCoins,
  PiggyBank, RefreshCcw, ShieldCheck, TriangleAlert,
} from 'lucide-react';
import type { ColDef } from 'ag-grid-community';
import { GridPanel } from '../components/GridPanel.js';
import { ChartPanel } from '../components/ChartPanel.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { Card, EmptyState, Icon } from '../components/ui.js';
import { useFetch } from '../hooks.js';
import { api } from '../api.js';

type Row = Record<string, any>;

// ── Status colours ────────────────────────────────────────────────────────────

type Variant = 'ok' | 'error' | 'warning' | 'info' | 'mocked' | 'live' | 'replayed';
function statusVariant(s: string): Variant {
  if (s === 'active') return 'ok';
  if (s === 'refunded') return 'info';
  if (s === 'retained') return 'ok';
  if (s === 'depleted') return 'error';
  if (s === 'failed') return 'error';
  if (s === 'awaiting_decision') return 'warning';
  if (s === 'completed') return 'ok';
  if (s === 'pending_approval') return 'mocked';
  return 'info';
}

function statusLabel(s: string) {
  return s.replace(/_/g, ' ');
}

const short = (v?: string | null) => (v ? `${v.slice(0, 8)}…` : '—');
const fmt = (v: string | number | undefined, cur = 'USD') =>
  v != null ? `${Number(v).toFixed(2)} ${cur}` : '—';

// ── Column definitions ────────────────────────────────────────────────────────

const budgetCols: ColDef[] = [
  { field: 'id', headerName: 'Budget ID', width: 120, valueFormatter: ({ value }) => short(value) },
  { field: 'amount', headerName: 'Pre-approved', width: 130,
    valueFormatter: ({ value, data }) => fmt(value, data?.currency) },
  { field: 'balance', headerName: 'Remaining', width: 130,
    valueFormatter: ({ value, data }) => fmt(value, data?.currency),
    cellStyle: ({ value, data }) => ({
      color: Number(value) < Number(data?.amount) * 0.1 ? 'var(--color-danger)' :
             Number(value) < Number(data?.amount) * 0.3 ? 'var(--color-warning)' : 'var(--color-success)',
      fontWeight: '600',
    }) },
  { field: 'total_debited', headerName: 'Total Debited', width: 140,
    valueFormatter: ({ value, data }) => fmt(value, data?.currency) },
  { field: 'utilization_pct', headerName: 'Utilization', width: 120,
    valueFormatter: ({ value }) => `${Number(value ?? 0).toFixed(1)}%`,
    cellRenderer: ({ value }: { value: number }) => {
      const pct = Number(value ?? 0);
      const colour = pct >= 90 ? 'var(--color-danger)' : pct >= 70 ? 'var(--color-warning)' : 'var(--color-success)';
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ flex: 1, background: 'var(--border-subtle)', borderRadius: 4, height: 8 }}>
            <div style={{ width: `${Math.min(pct, 100)}%`, background: colour, borderRadius: 4, height: 8, transition: 'width 0.4s' }} />
          </div>
          <span style={{ minWidth: 42, fontSize: 12, color: colour }}>{pct.toFixed(1)}%</span>
        </div>
      );
    } },
  { field: 'status', headerName: 'Status', width: 160,
    cellRenderer: ({ value }: { value: string }) =>
      <StatusBadge label={statusLabel(value)} variant={statusVariant(value)} /> },
  { field: 'mission_id', headerName: 'Mission', width: 120, valueFormatter: ({ value }) => short(value) },
  { field: 'paypal_environment', headerName: 'Env', width: 90,
    cellRenderer: ({ value }: { value: string }) =>
      value ? <StatusBadge label={value} variant={value === 'live' ? 'ok' : 'info'} /> : <span>—</span> },
  { field: 'activated_at', headerName: 'Activated', width: 140,
    valueFormatter: ({ value }) => value ? new Date(value).toLocaleString() : '—' },
  { field: 'created_at', headerName: 'Created', width: 140,
    valueFormatter: ({ value }) => new Date(value).toLocaleString() },
];

const debitCols: ColDef[] = [
  { field: 'created_at', headerName: 'Time', width: 150,
    valueFormatter: ({ value }) => new Date(value).toLocaleString() },
  { field: 'amount', headerName: 'Debited', width: 110,
    valueFormatter: ({ value, data }) => fmt(value, data?.currency) },
  { field: 'balance_after', headerName: 'Balance After', width: 130,
    valueFormatter: ({ value, data }) => fmt(value, data?.currency),
    cellStyle: ({ value }) => ({ color: Number(value) === 0 ? 'var(--color-danger)' : 'var(--text-primary)' }) },
  { field: 'reason', headerName: 'Reason', flex: 1, minWidth: 140 },
  { field: 'actor_type', headerName: 'Actor Type', width: 110,
    cellRenderer: ({ value }: { value: string }) =>
      <StatusBadge label={value} variant={value === 'agent' ? 'live' : 'info'} /> },
  { field: 'reference_type', headerName: 'Ref Type', width: 110, valueFormatter: ({ value }) => value ?? '—' },
  { field: 'reference_id', headerName: 'Ref ID', width: 110, valueFormatter: ({ value }) => short(value) },
  { field: 'id', headerName: 'Debit ID', width: 110, valueFormatter: ({ value }) => short(value) },
];

// ── Sub-components ─────────────────────────────────────────────────────────────

interface KpiCardProps { label: string; value: string; sub?: string; icon: typeof Banknote; accent?: string; }
function KpiCard({ label, value, sub, icon, accent = 'var(--color-primary)' }: KpiCardProps) {
  return (
    <div style={{ background: 'var(--surface-muted)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
      <div style={{ background: accent + '20', borderRadius: 8, padding: 10, flexShrink: 0 }}>
        <Icon icon={icon} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{sub}</div>}
      </div>
    </div>
  );
}

// ── Remainder Decision Panel ──────────────────────────────────────────────────

function RemainderDecisionPanel({
  budget, tenantId, onDecisionMade,
}: { budget: Row; tenantId: string; onDecisionMade: () => void }) {
  const [deciding, setDeciding] = useState(false);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<Row | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const promptFetch = useFetch(() => api.budgets.remainderPrompt(budget.id));
  const promptData = promptFetch.status === 'ok' ? promptFetch.data : null;

  const decide = async (decision: 'refund' | 'retain') => {
    setDeciding(true);
    setErr(null);
    try {
      const res = await api.budgets.decide(budget.id, decision, note);
      setResult(res);
      onDecisionMade();
    } catch (e: any) {
      setErr(e?.message ?? 'Decision failed');
    } finally {
      setDeciding(false);
    }
  };

  if (result) {
    return (
      <Card title="Decision recorded" icon={ShieldCheck}>
        <dl className="kv">
          <dt>Choice</dt><dd><StatusBadge label={result.decision?.decision} variant="ok" /></dd>
          {result.decision?.paypal_refund_id && <><dt>PayPal refund</dt><dd><code>{result.decision.paypal_refund_id}</code></dd></>}
        </dl>
      </Card>
    );
  }

  return (
    <Card title="What would you like to do with the remaining balance?" icon={HandCoins}>
      {promptFetch.status === 'loading' && <p className="card-sub">AI agent is preparing your options…</p>}
      {promptData && (
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{promptData.prompt?.subject}</h3>
          <p className="card-sub" style={{ marginBottom: 10 }}>{promptData.prompt?.body}</p>
          {promptData.prompt?.recommendation && promptData.prompt?.recommendation !== 'neutral' && (
            <div className="notice notice-info" role="status" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon icon={GitMerge} />
              <span>Agent recommends: <strong>{promptData.prompt.recommendation === 'refund' ? promptData.prompt.refund_label : promptData.prompt.retain_label}</strong> — {promptData.prompt.rationale}</span>
            </div>
          )}
        </div>
      )}
      <div className="kv" style={{ marginBottom: 12 }}>
        <strong>Remaining balance:</strong>&nbsp;<span style={{ color: 'var(--color-success)', fontWeight: 700 }}>{fmt(budget.balance, budget.currency)}</span>
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Note (optional)</label>
        <input
          type="text" className="grid-search-input" style={{ width: '100%' }}
          placeholder="Add a note…" value={note} onChange={(e) => setNote(e.target.value)}
          maxLength={300}
        />
      </div>
      {err && <div className="notice notice-error" role="alert" style={{ marginBottom: 10 }}><Icon icon={TriangleAlert} /><span>{err}</span></div>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button" className="small-button" disabled={deciding}
          style={{ background: 'var(--color-primary)', color: 'var(--surface-solid)', border: 'none', cursor: deciding ? 'not-allowed' : 'pointer', opacity: deciding ? 0.7 : 1 }}
          onClick={() => decide('refund')}
        >
          {deciding ? 'Processing…' : promptData?.prompt?.refund_label ?? 'Refund remainder'}
        </button>
        <button
          type="button" className="small-button" disabled={deciding}
          style={{ background: 'var(--color-success)', color: 'var(--surface-solid)', border: 'none', cursor: deciding ? 'not-allowed' : 'pointer', opacity: deciding ? 0.7 : 1 }}
          onClick={() => decide('retain')}
        >
          {deciding ? 'Processing…' : promptData?.prompt?.retain_label ?? 'Keep for later'}
        </button>
      </div>
    </Card>
  );
}

// ── Create Budget Panel ────────────────────────────────────────────────────────

function CreateBudgetPanel({ onCreated }: { onCreated: (b: Row) => void }) {
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [missionId, setMissionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Row | null>(null);

  const handleCreate = async () => {
    setBusy(true); setError(null);
    try {
      const result = await api.budgets.create({ amount, currency, mission_id: missionId || undefined });
      setCreated(result.budget);
      onCreated(result.budget);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to create budget');
    } finally { setBusy(false); }
  };

  if (created) {
    return (
      <Card title="Budget created — approve in PayPal" icon={Banknote}>
        <dl className="kv">
          <dt>Budget ID</dt><dd><code>{created.id}</code></dd>
          <dt>Amount</dt><dd style={{ fontWeight: 700, color: 'var(--color-primary)' }}>{fmt(created.amount, created.currency)}</dd>
          <dt>Status</dt><dd><StatusBadge label={statusLabel(created.status)} variant={statusVariant(created.status)} /></dd>
        </dl>
        {created.approve_url && (
          <a
            href={created.approve_url} target="_blank" rel="noopener noreferrer"
            className="small-button" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 12, background: 'var(--color-primary)', color: 'var(--surface-solid)', textDecoration: 'none', border: 'none', padding: '8px 16px', borderRadius: 6, fontWeight: 600 }}
          >
            Approve funds in PayPal →
          </a>
        )}
        <p className="card-sub" style={{ marginTop: 10, fontSize: 12 }}>
          After approving in PayPal, the budget activates automatically. The counter then
          starts against your pre-approved allocation — no PayPal call per micro-payment.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Pre-approve a spending budget" icon={PiggyBank}>
      <p className="card-sub" style={{ marginBottom: 16 }}>
        Set a cap, approve it once in PayPal, and agents will debit micro-amounts from the
        held balance. If the mission finishes without depleting the funds you can refund or
        keep the remainder.
      </p>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Amount *</label>
          <input type="number" className="grid-search-input" style={{ width: '100%' }}
            placeholder="e.g. 25.00" value={amount} min="0.01" step="0.01"
            onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Currency</label>
          <select className="grid-search-input" style={{ width: '100%', background: 'var(--surface-solid)' }}
            value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="USD">USD</option>
            <option value="EUR">EUR</option>
            <option value="GBP">GBP</option>
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Mission ID (optional)</label>
          <input type="text" className="grid-search-input" style={{ width: '100%' }}
            placeholder="UUID…" value={missionId}
            onChange={(e) => setMissionId(e.target.value)} maxLength={36} />
        </div>
      </div>
      {error && (
        <div className="notice notice-error" role="alert" style={{ marginTop: 10 }}>
          <Icon icon={TriangleAlert} /><span>{error}</span>
        </div>
      )}
      <button
        type="button" className="small-button" disabled={busy || !amount}
        style={{ marginTop: 14, background: 'var(--color-primary)', color: 'var(--surface-solid)', border: 'none',
          cursor: busy || !amount ? 'not-allowed' : 'pointer', opacity: busy || !amount ? 0.6 : 1 }}
        onClick={handleCreate}
      >
        {busy ? 'Creating…' : 'Create budget & go to PayPal'}
      </button>
    </Card>
  );
}

// ── Main workspace ────────────────────────────────────────────────────────────

export const PaymentJourneyWorkspace: React.FC = () => {
  const [selectedBudgetId, setSelectedBudgetId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Back from PayPal: the server already tried to activate the budget (?budget_id&budget_status).
  const [returnNotice, setReturnNotice] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const id = q.get('budget_id');
    if (!id) return;
    const status = q.get('budget_status') ?? '';
    const error = q.get('budget_error');
    const cancelled = q.get('paypal') === 'cancel';
    setSelectedBudgetId(id);
    setReturnNotice(
      cancelled ? { ok: false, text: 'PayPal checkout was cancelled. The budget is still waiting for approval.' }
      : status === 'active' ? { ok: true, text: 'Budget approved in PayPal and activated.' }
      : status === 'failed' ? { ok: false, text: 'PayPal did not complete the payment, so the budget could not be activated.' }
      : { ok: false, text: 'Back from PayPal, but the budget is not active yet' + (error ? ' (' + error + ')' : '') + '. Use "Check PayPal status" below.' },
    );
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    refresh();
  }, [refresh]);

  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const syncWithPayPal = async (id: string) => {
    setSyncing(true); setSyncMsg(null);
    try {
      const { budget } = await api.budgets.sync(id);
      setSyncMsg(budget.status === 'pending_approval'
        ? 'PayPal reports this order is not approved yet. Approve it in PayPal, then check again.'
        : 'Budget is now ' + statusLabel(budget.status) + '.');
      refresh();
    } catch (e: any) {
      setSyncMsg(e?.message ?? 'Could not check PayPal.');
    } finally { setSyncing(false); }
  };

  // Edit / delete a budget that never went through at PayPal. The server checks PayPal first
  // and refuses if the buyer actually approved it, so a real payment is never discarded.
  const [editing, setEditing] = useState(false);
  const [editAmount, setEditAmount] = useState('');
  const [editCurrency, setEditCurrency] = useState('USD');
  const [changing, setChanging] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  useEffect(() => { setEditing(false); setChangeError(null); }, [selectedBudgetId]);
  const startEdit = (b: Row) => {
    setEditAmount(String(Number(b.amount)));
    setEditCurrency(String(b.currency ?? 'USD'));
    setChangeError(null);
    setEditing(true);
  };
  const saveEdit = async (b: Row) => {
    const amt = editAmount.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(amt) || Number(amt) <= 0) {
      setChangeError('Enter an amount greater than 0 with at most 2 decimals.');
      return;
    }
    setChanging(true); setChangeError(null);
    try {
      const { budget } = await api.budgets.edit(b.id, { amount: amt, currency: editCurrency });
      setEditing(false);
      setSyncMsg('Budget updated. A new PayPal approval link was created for ' + fmt(budget.amount, budget.currency) + '.');
      setSelectedBudgetId(budget.id);
      refresh();
    } catch (e: any) {
      setChangeError(e?.message ?? 'Could not update the budget.');
    } finally { setChanging(false); }
  };
  const deleteBudget = async (b: Row) => {
    if (!window.confirm('Delete this pending budget? It was never approved in PayPal, so no money has moved. Stoat checks PayPal first and keeps the budget if it was approved.')) return;
    setChanging(true); setChangeError(null);
    try {
      await api.budgets.remove(b.id);
      setEditing(false);
      setSelectedBudgetId(null);
      setSyncMsg(null);
      refresh();
    } catch (e: any) {
      setChangeError(e?.message ?? 'Could not delete the budget.');
      refresh();
    } finally { setChanging(false); }
  };

  const budgets = useFetch(() => api.budgets.list({ status: statusFilter || undefined }), [refreshKey, statusFilter]);
  const analytics = useFetch(() => api.budgets.analytics(), [refreshKey]);
  const debits = useFetch(
    () => selectedBudgetId ? api.budgets.debits(selectedBudgetId) : Promise.resolve({ debits: [] }),
    [selectedBudgetId, refreshKey]
  );
  const selectedDecision = useFetch(
    () => selectedBudgetId ? api.budgets.getDecision(selectedBudgetId) : Promise.resolve({ decision: null }),
    [selectedBudgetId, refreshKey]
  );

  const rows: Row[] = budgets.status === 'ok' ? budgets.data.budgets : [];
  const analytics_data = analytics.status === 'ok' ? analytics.data : null;
  const selected = rows.find((r) => r.id === selectedBudgetId) ?? null;

  // ── KPI calculation ────────────────────────────────────────────────────────
  const activeCount = rows.filter((r) => r.status === 'active').length;
  const totalHeld = rows.filter((r) => ['active', 'awaiting_decision'].includes(r.status))
    .reduce((s, r) => s + Number(r.balance), 0);
  const totalDebited = rows.reduce((s, r) => s + Number(r.total_debited), 0);
  const awaitingDecision = rows.filter((r) => r.status === 'awaiting_decision').length;
  const depleted = rows.filter((r) => r.status === 'depleted').length;

  // ── Chart data ─────────────────────────────────────────────────────────────
  const statusChartData = analytics_data?.by_status?.map((d: any) => ({
    status: statusLabel(d.status),
    count: d.count,
    total: Number(d.total_amount ?? 0),
    debited: Number(d.total_debited ?? 0),
  })) ?? [];

  const histogramData = analytics_data?.utilization_histogram?.map((d: any) => ({
    bucket: d.bucket,
    count: d.count,
  })) ?? [];

  const dailyData = analytics_data?.daily_debits?.map((d: any) => ({
    day: d.day?.slice(0, 10) ?? '',
    total: Number(d.total ?? 0),
    count: Number(d.count ?? 0),
  })) ?? [];

  const topReasonsData = analytics_data?.top_debit_reasons?.map((d: any) => ({
    reason: d.reason,
    total: Number(d.total ?? 0),
    count: Number(d.count ?? 0),
  })) ?? [];

  const statusFilterOptions = ['', 'active', 'pending_approval', 'awaiting_decision', 'depleted', 'refunded', 'retained', 'failed', 'completed', 'cancelled'];

  return (
    <>
      {returnNotice && (
        <p className={returnNotice.ok ? 'notice notice-success' : 'notice notice-error'} role="status">{returnNotice.text}</p>
      )}
      {/* ── Header description ─────────────────────────────────────── */}
      <p className="card-sub" style={{ marginBottom: 0 }}>
        Pre-approve a spending budget through PayPal once. Agents debit micro-amounts against the
        held allocation — no PayPal call per micro-payment. If the budget depletes, the mission
        stops automatically. If the mission completes with funds remaining, you choose: refund or retain.
      </p>

      {/* ── Action bar ────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '16px 0' }}>
        <button type="button" className="small-button"
          style={{ background: showCreate ? 'var(--border-subtle)' : 'var(--color-primary)', color: showCreate ? 'var(--text-primary)' : 'var(--surface-solid)', border: 'none', cursor: 'pointer' }}
          onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? 'Cancel' : '+ New Budget'}
        </button>
        <select className="grid-search-input" style={{ minWidth: 160 }}
          value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {statusFilterOptions.filter(Boolean).map((s) => (
            <option key={s} value={s}>{statusLabel(s)}</option>
          ))}
        </select>
        <button type="button" className="small-button" onClick={refresh}
          style={{ background: 'var(--surface-muted)', border: '1px solid var(--border-subtle)', cursor: 'pointer' }}>
          <Icon icon={RefreshCcw} /> Refresh
        </button>
        {awaitingDecision > 0 && (
          <div className="notice notice-error" role="status"
            style={{ margin: 0, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <Icon icon={TriangleAlert} />
            <span><strong>{awaitingDecision}</strong> budget{awaitingDecision > 1 ? 's' : ''} awaiting your decision (refund or retain)</span>
          </div>
        )}
      </div>

      {/* ── Create form ────────────────────────────────────────────── */}
      {showCreate && (
        <div style={{ marginBottom: 16 }}>
          <CreateBudgetPanel onCreated={() => { setShowCreate(false); refresh(); }} />
        </div>
      )}

      {/* ── KPI Cards ─────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
        <KpiCard label="Active Budgets" value={String(activeCount)} icon={CircleDollarSign} accent='var(--color-primary)' />
        <KpiCard label="Funds On Hold" value={`$${totalHeld.toFixed(2)}`} sub="across active + awaiting" icon={Banknote} accent='var(--color-violet)' />
        <KpiCard label="Total Debited" value={`$${totalDebited.toFixed(2)}`} sub="micro-payments applied" icon={HandCoins} accent='var(--color-info)' />
        <KpiCard label="Awaiting Decision" value={String(awaitingDecision)} sub="refund or retain" icon={GitMerge} accent={awaitingDecision > 0 ? 'var(--color-warning)' : 'var(--text-muted)'} />
        <KpiCard label="Depleted (stopped)" value={String(depleted)} sub="mission halted on empty" icon={TriangleAlert} accent={depleted > 0 ? 'var(--color-danger)' : 'var(--text-muted)'} />
      </div>

      {/* ── Charts row ─────────────────────────────────────────────── */}
      <div className="card-grid card-grid--wide" style={{ marginBottom: 20 }}>
        <ChartPanel
          title="Budgets by Status"
          data={statusChartData}
          loading={analytics.status === 'loading'}
          error={analytics.status === 'error' ? analytics.error : undefined}
          series={[{
            type: 'bar',
            xKey: 'status',
            yKey: 'count',
            yName: 'Count',
            fill: 'var(--color-primary)',
            tooltip: { renderer: ({ datum }: any) => ({ content: `${datum.status}: ${datum.count} budgets, $${datum.total.toFixed(2)} total` }) },
          }]}
        />
        <ChartPanel
          title="Utilization Distribution"
          data={histogramData}
          loading={analytics.status === 'loading'}
          error={analytics.status === 'error' ? analytics.error : undefined}
          series={[{
            type: 'bar',
            xKey: 'bucket',
            yKey: 'count',
            yName: 'Budgets',
            fill: 'var(--color-violet)',
            tooltip: { renderer: ({ datum }: any) => ({ content: `${datum.bucket}: ${datum.count} budgets` }) },
          }]}
        />
      </div>

      <div className="card-grid card-grid--wide" style={{ marginBottom: 20 }}>
        <ChartPanel
          title="Daily Debit Activity (30 days)"
          data={dailyData}
          loading={analytics.status === 'loading'}
          error={analytics.status === 'error' ? analytics.error : undefined}
          series={[{
            type: 'area',
            xKey: 'day',
            yKey: 'total',
            yName: 'Amount Debited',
            fill: 'var(--color-info)',
            stroke: 'var(--color-info)',
            fillOpacity: 0.3,
            tooltip: { renderer: ({ datum }: any) => ({ content: `${datum.day}: $${Number(datum.total ?? 0).toFixed(2)} (${datum.count} debits)` }) },
          }]}
        />
        <ChartPanel
          title="Top Debit Reasons"
          data={topReasonsData}
          loading={analytics.status === 'loading'}
          error={analytics.status === 'error' ? analytics.error : undefined}
          series={[{
            type: 'bar',
            direction: 'horizontal',
            xKey: 'reason',
            yKey: 'total',
            yName: 'Total Debited',
            fill: 'var(--color-warning)',
            tooltip: { renderer: ({ datum }: any) => ({ content: `${datum.reason}: $${Number(datum.total ?? 0).toFixed(2)} (${datum.count} debits)` }) },
          }]}
        />
      </div>

      {/* ── Budgets Grid ───────────────────────────────────────────── */}
      <GridPanel
        title="Spending Budgets"
        rows={rows}
        cols={budgetCols}
        loading={budgets.status === 'loading'}
        error={budgets.status === 'error' ? budgets.error : undefined}
        onRowClick={(row) => setSelectedBudgetId((row as Row).id === selectedBudgetId ? null : (row as Row).id)}
        getRowId={(p) => (p.data as Row).id}
        badge={
          awaitingDecision > 0
            ? <span className="kv" style={{ fontSize: 12, color: 'var(--color-warning)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Icon icon={TriangleAlert} />
                {awaitingDecision} awaiting decision
              </span>
            : undefined
        }
      />

      {/* ── Detail Panel ───────────────────────────────────────────── */}
      {selected ? (
        <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
          {/* Budget summary */}
          <Card title={`Budget ${short(selected.id)} — ${statusLabel(selected.status)}`} icon={Banknote}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, marginBottom: 12 }}>
              <div><span className="card-sub">Pre-approved</span><br /><strong style={{ color: 'var(--color-primary)' }}>{fmt(selected.amount, selected.currency)}</strong></div>
              <div><span className="card-sub">Balance</span><br /><strong style={{ color: Number(selected.balance) < Number(selected.amount) * 0.1 ? 'var(--color-danger)' : 'var(--color-success)' }}>{fmt(selected.balance, selected.currency)}</strong></div>
              <div><span className="card-sub">Total debited</span><br /><strong>{fmt(selected.total_debited, selected.currency)}</strong></div>
              <div><span className="card-sub">Utilization</span><br />
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <div style={{ flex: 1, background: 'var(--border-subtle)', borderRadius: 4, height: 10 }}>
                    <div style={{ width: `${Math.min(selected.utilization_pct, 100)}%`, background: selected.utilization_pct >= 90 ? 'var(--color-danger)' : selected.utilization_pct >= 70 ? 'var(--color-warning)' : 'var(--color-success)', borderRadius: 4, height: 10 }} />
                  </div>
                  <strong>{Number(selected.utilization_pct ?? 0).toFixed(1)}%</strong>
                </div>
              </div>
              <div><span className="card-sub">PayPal order</span><br /><code style={{ fontSize: 12 }}>{selected.paypal_order_id ? short(selected.paypal_order_id) : '—'}</code></div>
              <div><span className="card-sub">Capture ID</span><br /><code style={{ fontSize: 12 }}>{selected.paypal_capture_id ? short(selected.paypal_capture_id) : '—'}</code></div>
              <div><span className="card-sub">Environment</span><br />{selected.paypal_environment
                ? <StatusBadge label={selected.paypal_environment} variant={selected.paypal_environment === 'live' ? 'ok' : 'info'} />
                : <span>—</span>}</div>
              <div><span className="card-sub">Activated</span><br /><span style={{ fontSize: 13 }}>{selected.activated_at ? new Date(selected.activated_at).toLocaleString() : 'Not yet'}</span></div>
            </div>

            {/* Pending approval link */}
            {selected.status === 'pending_approval' && selected.approve_url && (
              <div className="notice notice-info" role="status" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Icon icon={ShieldCheck} />
                <span>Funds not yet authorized.&nbsp;
                  <a href={selected.approve_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)', fontWeight: 600 }}>
                    Approve in PayPal →
                  </a>
                </span>
                <button type="button" className="secondary-button" style={{ marginLeft: 'auto' }}
                  disabled={syncing} aria-busy={syncing} onClick={() => syncWithPayPal(selected.id)}>
                  {syncing ? 'Checking…' : 'Check PayPal status'}
                </button>
              </div>
            )}
            {syncMsg && <p className="field-note" role="status">{syncMsg}</p>}
            {selected.status === 'pending_approval' && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end', marginTop: 10 }}>
                {editing ? (
                  <form
                    style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}
                    onSubmit={(e) => { e.preventDefault(); void saveEdit(selected); }}
                    noValidate
                  >
                    <label className="field-note" style={{ display: 'grid', gap: 4 }}>
                      Amount
                      <input type="text" inputMode="decimal" className="grid-search-input" value={editAmount}
                        onChange={(e) => setEditAmount(e.target.value)} disabled={changing}
                        aria-invalid={changeError ? true : undefined} />
                    </label>
                    <label className="field-note" style={{ display: 'grid', gap: 4 }}>
                      Currency
                      <select className="grid-search-input" value={editCurrency}
                        onChange={(e) => setEditCurrency(e.target.value)} disabled={changing}>
                        {['USD', 'EUR', 'GBP'].map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </label>
                    <button type="submit" className="primary-button" disabled={changing} aria-busy={changing}>
                      {changing ? 'Saving…' : 'Save & new PayPal link'}
                    </button>
                    <button type="button" className="secondary-button" disabled={changing} onClick={() => setEditing(false)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <button type="button" className="secondary-button" disabled={changing} onClick={() => startEdit(selected)}>
                      Edit
                    </button>
                    <button type="button" className="secondary-button" style={{ color: 'var(--color-danger)' }}
                      disabled={changing} aria-busy={changing} onClick={() => void deleteBudget(selected)}>
                      {changing ? 'Deleting…' : 'Delete'}
                    </button>
                  </>
                )}
              </div>
            )}
            {changeError && <p className="field-note" role="alert" style={{ color: 'var(--color-danger)' }}>{changeError}</p>}

            {/* Depleted notice */}
            {selected.status === 'depleted' && (
              <div className="notice notice-error" role="alert" style={{ display: 'flex', gap: 8 }}>
                <Icon icon={TriangleAlert} />
                <span><strong>Budget depleted.</strong> The mission has been stopped. No further micro-payments will be accepted against this budget.</span>
              </div>
            )}
          </Card>

          {/* Remainder decision — only shown when awaiting */}
          {selected.status === 'awaiting_decision' &&
            !(selectedDecision.status === 'ok' && selectedDecision.data.decision) && (
            <RemainderDecisionPanel
              budget={selected}
              tenantId={selected.tenant_id}
              onDecisionMade={refresh}
            />
          )}

          {/* Show recorded decision */}
          {selectedDecision.status === 'ok' && selectedDecision.data.decision && (() => {
            const d = selectedDecision.data.decision as Row;
            return (
              <Card title="Remainder decision" icon={ShieldCheck}>
                <dl className="kv">
                  <dt>Choice</dt><dd><StatusBadge label={d.decision} variant={d.decision === 'refund' ? 'info' : 'ok'} /></dd>
                  <dt>Decided by</dt><dd><code>{short(d.decided_by)}</code></dd>
                  <dt>Decided at</dt><dd>{new Date(d.decided_at).toLocaleString()}</dd>
                  {d.paypal_refund_id && <><dt>PayPal refund ID</dt><dd><code>{d.paypal_refund_id}</code></dd></>}
                  {d.refund_status && <><dt>Refund status</dt><dd><StatusBadge label={d.refund_status} variant="ok" /></dd></>}
                  {d.note && <><dt>Note</dt><dd>{d.note}</dd></>}
                </dl>
              </Card>
            );
          })()}

          {/* Debit stream grid */}
          <GridPanel
            title={`Micro-payment Debit Stream — Budget ${short(selected.id)}`}
            rows={debits.status === 'ok' ? debits.data.debits : []}
            cols={debitCols}
            loading={debits.status === 'loading'}
            error={debits.status === 'error' ? debits.error : undefined}
            getRowId={(p) => (p.data as Row).id}
            badge={
              <span className="card-sub" style={{ fontSize: 12 }}>
                {debits.status === 'ok' ? debits.data.debits.length : 0} micro-payments — no PayPal call per debit
              </span>
            }
          />
        </div>
      ) : (
        <Card title="Select a budget" icon={CircleDollarSign}>
          <EmptyState title="Pick a row above">
            Click any budget to view its debit stream, PayPal evidence, and remainder decision panel.
          </EmptyState>
        </Card>
      )}
    </>
  );
};
