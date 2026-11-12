import React from "react";
import { CircleCheck, RefreshCw, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import type { ColDef } from "ag-grid-community";
import { useFetch } from "../hooks.js";
import { api } from "../api.js";
import { Card, Icon, Loading } from "../components/ui.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { GridPanel } from "../components/GridPanel.js";

interface Row { label: string; hint: string; ok: boolean; value: string }

const BALANCE_COLS: ColDef[] = [
  { field: 'currency', headerName: 'Currency', width: 110 },
  { field: 'total_debit', headerName: 'Total Debits', flex: 1,
    valueFormatter: ({ value, data }) => `${value} ${(data as Record<string, string>)['currency']}` },
  { field: 'total_credit', headerName: 'Total Credits', flex: 1,
    valueFormatter: ({ value, data }) => `${value} ${(data as Record<string, string>)['currency']}` },
  { field: 'delta', headerName: 'Difference', flex: 1,
    valueFormatter: ({ value, data }) => `${value} ${(data as Record<string, string>)['currency']}` },
  { field: 'balanced', headerName: 'Status', width: 130,
    cellRenderer: ({ value }: { value: boolean }) =>
      <StatusBadge label={value ? 'balanced' : 'unbalanced'} variant={value ? 'ok' : 'error'} /> },
];

/** Live accounting invariants. Every value is recomputed by the API on each refresh. */
export const IntegrityWorkspace: React.FC = () => {
  const report = useFetch(() => api.integrity());

  if (report.status !== "ok") {
    if (report.status === "error") {
      return (
        <Card>
          <div className="notice notice-error" role="alert">
            <Icon icon={TriangleAlert} />
            <span>Integrity data could not be loaded: {report.error}</span>
            <button type="button" className="small-button" onClick={report.reload}>Retry</button>
          </div>
        </Card>
      );
    }
    return <Card><Loading label="Computing integrity…" /></Card>;
  }
  const { metrics, integrity_status, computed_at } = report.data;
  const healthy = integrity_status === "healthy";
  const balanced = (metrics.debit_credit_balance ?? []).every((b) => b.balanced);

  const rows: Row[] = [
    { label: "Journal balance", hint: "Debits equal credits in every currency", ok: balanced, value: balanced ? "Balanced" : "Out of balance" },
    { label: "Event-chain gaps", hint: "Every event links to the one before it", ok: metrics.hash_chain_gaps === 0, value: String(metrics.hash_chain_gaps) },
    { label: "Duplicate obligations", hint: "At most one payable per agreement", ok: metrics.duplicate_obligations === 0, value: String(metrics.duplicate_obligations) },
    { label: "Duplicate reservations", hint: "No obligation is in two active batches", ok: metrics.duplicate_active_reservations === 0, value: String(metrics.duplicate_active_reservations) },
    { label: "Orphan reservations", hint: "Reserved budget never exceeds the budget", ok: metrics.orphan_reservations === 0, value: String(metrics.orphan_reservations) },
    { label: "Batch total mismatches", hint: "Each batch total equals its items", ok: metrics.batch_sum_mismatches === 0, value: String(metrics.batch_sum_mismatches) },
    { label: "Unreconciled captures", hint: "Every captured payment is reconciled", ok: metrics.unreconciled_captures === 0, value: String(metrics.unreconciled_captures) },
    { label: "Paid without a PayPal payout", hint: "An obligation is paid only when PayPal confirmed its payout item", ok: metrics.paid_without_payout === 0, value: String(metrics.paid_without_payout) },
    { label: "Duplicate successful payouts", hint: "No obligation is paid twice", ok: metrics.duplicate_successful_payouts === 0, value: String(metrics.duplicate_successful_payouts) },
    { label: "Payout above obligation", hint: "No payout exceeds what was owed", ok: metrics.payout_exceeds_obligation === 0, value: String(metrics.payout_exceeds_obligation) },
    { label: "Non-PayPal payments", hint: "Every payment record is PayPal", ok: metrics.non_paypal_payments === 0, value: String(metrics.non_paypal_payments) },
    { label: "Unauthorized agreements", hint: "Every agreement has an allow decision", ok: metrics.unauthorized_agreements === 0, value: String(metrics.unauthorized_agreements) },
  ];

  return (
    <>
      <Card
        className="card--full"
        title={healthy ? "All integrity checks pass" : "Integrity violation detected"}
        icon={healthy ? ShieldCheck : ShieldAlert}
        description={`Computed ${new Date(computed_at).toLocaleString()}`}
        actions={
          <button type="button" className="btn btn-secondary" onClick={report.reload}>
            <Icon icon={RefreshCw} /> Refresh
          </button>
        }
      >
        <StatusBadge label={healthy ? "healthy" : "violation detected"} variant={healthy ? "ok" : "error"} />
      </Card>

      <div className="card-grid card-grid--kpi">
        {rows.map((row) => (
          <div className="card" key={row.label}>
            <div className="stat">
              <div>
                <div className="stat-label">{row.label}</div>
                <div className="stat-value">{row.value}</div>
                <div className="stat-sub">{row.hint}</div>
              </div>
              <span className={`stat-icon ${row.ok ? "tone-success" : "tone-danger"}`}>
                <Icon icon={row.ok ? CircleCheck : TriangleAlert} label={row.ok ? "Passing" : "Failing"} />
              </span>
            </div>
          </div>
        ))}
      </div>

      {(metrics.debit_credit_balance ?? []).length > 0 && (
        <div style={{ marginTop: "var(--space-4)" }}>
          <GridPanel
            title="Journal Balance by Currency"
            rows={metrics.debit_credit_balance}
            cols={BALANCE_COLS}
            getRowId={(p) => (p.data as { currency: string }).currency}
            badge={<StatusBadge label="double-entry verified" variant="ok" />}
          />
        </div>
      )}
    </>
  );
};
