import { FormEvent, useRef, useState } from "react";
import type { ColDef } from "ag-grid-community";
import { AlertTriangle, Bell, Landmark, Play, RotateCcw, Scale } from "lucide-react";
import {
  BusinessAccountRow,
  TrialBalanceRow,
  WalletNotification,
  api,
  walletApi,
} from "../api.js";
import { GridPanel } from "../components/GridPanel.js";
import { Card, EmptyState, Loading, PageHeader } from "../components/ui.js";
import { useFetch } from "../hooks.js";
import { formatAmount, formatMoney, validateDepositAmount } from "../money.js";
import { describeError } from "../walletReturn.js";

interface AdminWallet {
  id: string;
  owner_user_id: string;
  currency: string;
  status: string;
  paypal_environment: string | null;
  balance: string;
  reserved: string;
  available: string;
  last_activity_at: string | null;
}

interface RunRow {
  id: string;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  counts: { orders: number; captures: number; refunds: number; payouts: number; new_exceptions: number; open_exceptions: number };
}

interface ExceptionRow {
  id: string;
  item_type: string;
  paypal_id: string;
  kind: string;
  currency: string | null;
  stoat_amount: string | null;
  paypal_amount: string | null;
  difference: string | null;
  status: string;
}

function ErrorLine({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="field-note" style={{ color: "var(--color-danger)" }}>
      {text}{" "}
      {onRetry && (
        <button type="button" className="secondary-button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

const FIGURES: [keyof BusinessAccountRow, string][] = [
  ["paypal_funds_received", "PayPal funds received"],
  ["wallet_balance_held", "Wallet balances held"],
  ["funds_allocated_to_providers", "Allocated to providers"],
  ["provider_payouts_completed", "Provider payouts completed"],
  ["refunds_completed", "Refunds completed"],
  ["platform_revenue", "Platform revenue"],
];

const walletCols: ColDef[] = [
  { field: "owner_user_id", headerName: "Owner" },
  { field: "currency", headerName: "Currency", maxWidth: 120 },
  { field: "balance", headerName: "Balance" },
  { field: "reserved", headerName: "Reserved" },
  { field: "available", headerName: "Available" },
  { field: "status", headerName: "Status", maxWidth: 140 },
  { field: "last_activity_at", headerName: "Last activity", valueFormatter: (p) => p.value ?? "No activity" },
];

const runCols: ColDef[] = [
  { field: "started_at", headerName: "Started" },
  { field: "finished_at", headerName: "Finished", valueFormatter: (p) => p.value ?? "Running" },
  { field: "trigger", headerName: "Trigger", maxWidth: 130 },
  { field: "status", headerName: "Status", maxWidth: 140 },
  { valueGetter: (p) => p.data?.counts?.new_exceptions ?? 0, headerName: "New exceptions" },
  { valueGetter: (p) => p.data?.counts?.open_exceptions ?? 0, headerName: "Open exceptions" },
];

const exceptionCols: ColDef[] = [
  { field: "item_type", headerName: "Item" },
  { field: "paypal_id", headerName: "PayPal ID" },
  { field: "kind", headerName: "Kind" },
  { field: "currency", headerName: "Currency", maxWidth: 120 },
  { field: "stoat_amount", headerName: "Stoat" },
  { field: "paypal_amount", headerName: "PayPal" },
  { field: "difference", headerName: "Difference" },
  { field: "status", headerName: "Status", maxWidth: 130 },
];

/** Route target for `#/business-account`. The server limits every call here to a signed-in Admin. */
export function BusinessAccountWorkspace() {
  const me = useFetch(() => api.auth.me(), []);
  const account = useFetch(() => walletApi.admin.businessAccount(), []);
  const trial = useFetch(() => walletApi.admin.trialBalance(), []);
  const wallets = useFetch(() => walletApi.admin.wallets({ limit: "200" }), []);
  const runs = useFetch(() => walletApi.admin.reconciliationRuns({ limit: "20" }), []);
  const exceptions = useFetch(
    () => walletApi.admin.reconciliationExceptions({ status: "open", limit: "200" }),
    [],
  );
  const notes = useFetch(() => walletApi.notifications(), []);

  // Only a signed-in person with an Admin role sees money controls.
  const isAdminPerson =
    me.status === "ok" && me.data.type === "user" && ["operator", "supervisor"].includes(me.data.role);

  /* ── Run reconciliation (R11) ── */
  const [runBusy, setRunBusy] = useState(false);
  const runRef = useRef(false);
  const [runMsg, setRunMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const startRun = async () => {
    if (runRef.current) return;
    runRef.current = true;
    setRunBusy(true);
    setRunMsg(null);
    try {
      await walletApi.admin.startReconciliation();
      setRunMsg({ tone: "ok", text: "Reconciliation finished. Results are below." });
      runs.reload();
      exceptions.reload();
      notes.reload();
    } catch (e) {
      setRunMsg({ tone: "error", text: describeError(e) });
    } finally {
      runRef.current = false;
      setRunBusy(false);
    }
  };

  /* ── Admin refund (reason required) ── */
  const [walletId, setWalletId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [refundBusy, setRefundBusy] = useState(false);
  const refundRef = useRef(false);
  const [refundMsg, setRefundMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const walletRows: AdminWallet[] = wallets.status === "ok" ? ((wallets.data as any).wallets ?? []) : [];

  const submitRefund = async (e: FormEvent) => {
    e.preventDefault();
    if (refundRef.current) return;
    setRefundMsg(null);
    const problem = !walletId
      ? "Choose a wallet."
      : validateDepositAmount(amount) ?? (reason.trim().length < 1 || reason.trim().length > 500 ? "Give a reason of 1 to 500 characters." : null);
    setFieldError(problem);
    if (problem) return; // No request is sent for invalid input.
    refundRef.current = true;
    setRefundBusy(true);
    try {
      await walletApi.admin.refund(walletId, { amount: formatAmount(amount.trim()), reason: reason.trim() });
      setRefundMsg({ tone: "ok", text: "Refund requested. PayPal confirms the final status." });
      setAmount("");
      setReason("");
      wallets.reload();
      account.reload();
    } catch (err) {
      setRefundMsg({ tone: "error", text: describeError(err) });
    } finally {
      refundRef.current = false;
      setRefundBusy(false);
    }
  };

  const accountRows: BusinessAccountRow[] = account.status === "ok" ? ((account.data as any).currencies ?? []) : [];
  const trialRows: TrialBalanceRow[] = trial.status === "ok" ? ((trial.data as any).currencies ?? []) : [];
  const runRows: RunRow[] = runs.status === "ok" ? ((runs.data as any).runs ?? []) : [];
  const exceptionRows: ExceptionRow[] = exceptions.status === "ok" ? ((exceptions.data as any).exceptions ?? []) : [];
  const env = account.status === "ok" ? ((account.data as any).paypal_environment as string | null) : null;
  const noteRows: WalletNotification[] = notes.status === "ok" ? (notes.data?.notifications ?? []) : [];

  return (
    <>
      <PageHeader
        icon={Landmark}
        title="Business account"
        description="Platform PayPal funds, wallet balances and reconciliation. Read-only except the two Admin actions below."
      />
      {env && <span className="badge badge-neutral">PayPal environment: {env}</span>}

      <Card title="Business account totals" icon={Landmark}>
        {account.status === "loading" || account.status === "idle" ? (
          <Loading />
        ) : account.status === "error" ? (
          <ErrorLine text={describeError(new Error(account.error))} onRetry={account.reload} />
        ) : accountRows.length === 0 ? (
          <EmptyState icon={Landmark} title="No activity yet">
            Totals appear after the first deposit. Every figure is 0.00 until then.
          </EmptyState>
        ) : (
          accountRows.map((r) => (
            <dl key={r.currency} className="wallet-figures" aria-label={`${r.currency} business account`}>
              <p><strong>{r.currency}</strong></p>
              {FIGURES.map(([key, label]) => (
                <div key={key}><dt>{label}</dt><dd>{formatMoney(r[key], r.currency)}</dd></div>
              ))}
              <div><dt>Wallet balance sum</dt><dd>{formatMoney(r.wallet_balance_sum, r.currency)}</dd></div>
              <div><dt>Difference</dt><dd>{formatMoney(r.difference, r.currency)}</dd></div>
            </dl>
          ))
        )}
      </Card>

      <GridPanel
        title="User wallets"
        rows={walletRows}
        cols={walletCols}
        loading={wallets.status === "loading" || wallets.status === "idle"}
        error={wallets.status === "error" ? describeError(new Error(wallets.error)) : undefined}
        badge={env ? <span className="badge badge-neutral">{env}</span> : undefined}
        onRowClick={isAdminPerson ? (row) => setWalletId((row as AdminWallet).id) : undefined}
      />

      <Card title="Trial balance" icon={Scale}>
        {trial.status === "loading" || trial.status === "idle" ? (
          <Loading />
        ) : trial.status === "error" ? (
          <ErrorLine text={describeError(new Error(trial.error))} onRetry={trial.reload} />
        ) : trialRows.length === 0 ? (
          <EmptyState icon={Scale} title="No ledger entries">Debits and credits appear after the first posting.</EmptyState>
        ) : (
          <table className="data-table">
            <caption className="sr-only">Trial balance per currency</caption>
            <thead>
              <tr><th scope="col">Currency</th><th scope="col">Debits</th><th scope="col">Credits</th><th scope="col">Difference</th><th scope="col">Balanced</th></tr>
            </thead>
            <tbody>
              {trialRows.map((t) => (
                <tr key={t.currency}>
                  <th scope="row">{t.currency}</th>
                  <td>{formatMoney(t.total_debits, t.currency)}</td>
                  <td>{formatMoney(t.total_credits, t.currency)}</td>
                  <td>{formatMoney(t.difference, t.currency)}</td>
                  <td>{t.balanced ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title="Reconciliation"
        icon={AlertTriangle}
        description="Compares Stoat's books with PayPal. It never changes a balance."
        actions={
          isAdminPerson ? (
            <button type="button" className="primary-button" onClick={startRun} disabled={runBusy} aria-busy={runBusy}>
              <Play size={14} aria-hidden="true" /> {runBusy ? "Running…" : "Run reconciliation"}
            </button>
          ) : undefined
        }
      >
        {runMsg && (
          <div role={runMsg.tone === "error" ? "alert" : "status"} className="field-note">{runMsg.text}</div>
        )}
        {!isAdminPerson && me.status === "ok" && (
          <p className="field-note">Only a signed-in Admin can start a run.</p>
        )}
      </Card>

      <GridPanel
        title="Reconciliation runs"
        rows={runRows}
        cols={runCols}
        loading={runs.status === "loading" || runs.status === "idle"}
        error={runs.status === "error" ? describeError(new Error(runs.error)) : undefined}
      />
      <GridPanel
        title="Open reconciliation exceptions"
        rows={exceptionRows}
        cols={exceptionCols}
        loading={exceptions.status === "loading" || exceptions.status === "idle"}
        error={exceptions.status === "error" ? describeError(new Error(exceptions.error)) : undefined}
      />

      {isAdminPerson && (
        <Card title="Refund a wallet" icon={RotateCcw} description="A person gives a reason. The refund goes back to the original PayPal payment.">
          <form className="portal-form" onSubmit={submitRefund} noValidate>
            <label>
              Wallet
              <select value={walletId} onChange={(e) => setWalletId(e.target.value)} disabled={refundBusy}>
                <option value="">Choose a wallet</option>
                {walletRows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.owner_user_id} ({w.currency}, balance {w.balance})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Amount
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={refundBusy}
              />
            </label>
            <label>
              Reason
              <textarea
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
                required
                disabled={refundBusy}
              />
            </label>
            {fieldError && (
              <div role="alert" className="field-note" style={{ color: "var(--color-danger)" }}>{fieldError}</div>
            )}
            <button type="submit" className="primary-button" disabled={refundBusy} aria-busy={refundBusy}>
              {refundBusy ? "Refunding…" : "Refund"}
            </button>
            {refundMsg && (
              <div role={refundMsg.tone === "error" ? "alert" : "status"} className="field-note">{refundMsg.text}</div>
            )}
          </form>
        </Card>
      )}

      <Card title="Admin notifications" icon={Bell}>
        {notes.status === "loading" || notes.status === "idle" ? (
          <Loading />
        ) : notes.status === "error" ? (
          <ErrorLine text={describeError(new Error(notes.error))} onRetry={notes.reload} />
        ) : noteRows.length === 0 ? (
          <EmptyState icon={Bell} title="No notifications">Reconciliation and balance alerts appear here.</EmptyState>
        ) : (
          <ul>
            {noteRows.slice(0, 20).map((n) => (
              <li key={n.id}><strong>{n.title}</strong> {n.body}</li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
