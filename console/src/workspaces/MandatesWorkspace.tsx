import React, { useMemo, useRef, useState } from "react";
import type { ColDef } from "ag-grid-community";
import { X } from "lucide-react";
import { agenticApi } from "../api.js";
import { useLatestFetch } from "../hooks.js";
import { Card, EmptyState, Icon, Loading } from "../components/ui.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { VirtualGridPanel } from "../components/agentic/VirtualGridPanel.js";
import { UtilizationBar } from "../components/agentic/UtilizationBar.js";
import { Money } from "../components/agentic/Money.js";
import { AutonomousLabel } from "../components/agentic/labels.js";
import {
  EMPTY_MANDATE_FORM,
  buildMandateBody,
  canRevoke,
  mandateView,
  mergeRow,
  type MandateForm,
} from "../components/agentic/mandateHelpers.js";

type Row = Record<string, unknown>;

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const short = (v: unknown): string => (str(v) ? `${str(v).slice(0, 8)}…` : "");

const STATUS_VARIANT: Record<string, "ok" | "warning" | "error" | "info"> = {
  active: "ok",
  suspended: "warning",
  exhausted: "warning",
  revoked: "error",
  expired: "error",
};

const COLS: ColDef[] = [
  { field: "id", headerName: "Mandate", width: 120, valueFormatter: ({ value }) => short(value) },
  {
    field: "status",
    headerName: "Status",
    width: 120,
    cellRenderer: ({ value }: { value: string }) => (
      <StatusBadge label={value} variant={STATUS_VARIANT[value] ?? "info"} />
    ),
  },
  { field: "currency", headerName: "Currency", width: 100 },
  { field: "per_agreement_max", headerName: "Per agreement", width: 140 },
  { field: "daily_cap", headerName: "Daily cap", width: 130 },
  { field: "total_cap", headerName: "Total cap", width: 130 },
  { field: "expires_at", headerName: "Expires", flex: 1, valueFormatter: ({ value }) => (value ? new Date(value).toLocaleString() : "") },
];

/** The create form. Caps, categories, scope and expiry only: no payee, recipient or payment state. */
function CreateForm({ onCreated }: { onCreated: (mandate: Row) => void }) {
  const [form, setForm] = useState<MandateForm>(EMPTY_MANDATE_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // One key per form fill: a retry after a network failure reuses it, so it cannot double-create.
  const key = useRef<string | undefined>(undefined);
  const set = (field: keyof MandateForm) => (e: React.ChangeEvent<HTMLInputElement>) => {
    key.current = undefined;
    setForm((f) => ({ ...f, [field]: e.target.value }));
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      key.current ??= globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const created = await agenticApi.mandates.create(buildMandateBody(form), key.current);
      setForm(EMPTY_MANDATE_FORM);
      key.current = undefined;
      onCreated(created);
    } catch (err) {
      const code = (err as { code?: string }).code;
      setError(`${code ? `${code}: ` : ""}${err instanceof Error ? err.message : "Could not create the Mandate."}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Sign a new Mandate" description="Limits for a buyer agent. Terms cannot change later: revoke and create a new one.">
      <form className="portal-form" onSubmit={(e) => void submit(e)} noValidate aria-label="Create Mandate">
        <label>
          Currency
          <input value={form.currency} onChange={set("currency")} maxLength={3} required />
        </label>
        <label>
          Per agreement maximum
          <input value={form.perAgreementMax} onChange={set("perAgreementMax")} inputMode="decimal" placeholder="25.00" required />
        </label>
        <label>
          Daily cap
          <input value={form.dailyCap} onChange={set("dailyCap")} inputMode="decimal" placeholder="100.00" required />
        </label>
        <label>
          Total cap
          <input value={form.totalCap} onChange={set("totalCap")} inputMode="decimal" placeholder="500.00" required />
        </label>
        <label>
          Allowed service categories (1 to 20, comma separated)
          <input value={form.categories} onChange={set("categories")} required />
        </label>
        <label>
          Mission scope (optional, up to 50 mission IDs)
          <input value={form.missionScope} onChange={set("missionScope")} />
        </label>
        <label>
          Expires
          <input type="datetime-local" value={form.expiresAt} onChange={set("expiresAt")} required />
        </label>
        {error && <p className="notice notice-error" role="alert">{error}</p>}
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? "Signing…" : "Sign Mandate"}
        </button>
      </form>
    </Card>
  );
}

interface DrawerProps {
  mandateId: string;
  role: string | undefined;
  /** A row the server returned from a revoke; shown over whatever the detail fetch holds. */
  revoked: Row | undefined;
  readOnly: boolean;
  onClose: () => void;
  onRevoked: (mandate: Row) => void;
}

function MandateDrawer({ mandateId, role, revoked, readOnly, onClose, onRevoked }: DrawerProps) {
  const detail = useLatestFetch((signal) => agenticApi.mandates.get(mandateId, { signal }), [mandateId]);
  const alerts = useLatestFetch(
    (signal) => agenticApi.watchdog.alerts({ status: "open", limit: 200 }, { signal }),
    [mandateId],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const m: Row | undefined = detail.status === "ok" ? { ...detail.data, ...(revoked ?? {}) } : revoked;
  const status = str(m?.status);
  const currency = str(m?.currency);
  const reservations = (Array.isArray(m?.reservations) ? m?.reservations : []) as Row[];
  const openAlerts = useMemo(
    () => (alerts.status === "ok" ? alerts.data.alerts.filter((a) => str(a.mandate_id) === mandateId) : []),
    [alerts, mandateId],
  );

  async function revoke() {
    setBusy(true);
    setError("");
    try {
      // The response is the source of truth: show `revoked` from it straight away.
      onRevoked(await agenticApi.mandates.revoke(mandateId));
    } catch (err) {
      const code = (err as { code?: string }).code;
      setError(`${code ? `${code}: ` : ""}${err instanceof Error ? err.message : "Could not revoke the Mandate."}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="card" role="complementary" aria-label="Mandate detail">
      <div className="card-header">
        <h2 className="card-title">Mandate {short(mandateId)}</h2>
        <button type="button" className="icon-button" aria-label="Close detail" onClick={onClose}>
          <Icon icon={X} />
        </button>
      </div>
      {!m && detail.status === "loading" && <Loading label="Loading Mandate…" />}
      {detail.status === "error" && !m && (
        <p className="notice notice-error" role="alert">Could not load this Mandate: {detail.error}</p>
      )}
      {m && (
        <>
          <p>
            <StatusBadge label={status} variant={STATUS_VARIANT[status] ?? "info"} />{" "}
            <span className="card-sub">Expires {m.expires_at ? new Date(str(m.expires_at)).toLocaleString() : "—"}</span>
          </p>
          {m.usage !== undefined && (
            <>
              <h3>Total usage</h3>
              <UtilizationBar used={str(m.usage)} cap={str(m.total_cap)} currency={currency} label="Total usage" />
              <h3>Usage today (UTC)</h3>
              <UtilizationBar used={str(m.today_usage)} cap={str(m.daily_cap)} currency={currency} label="Usage today" />
              <p className="card-sub">Remaining: <Money amount={str(m.remaining)} currency={currency} /></p>
            </>
          )}
          <p className="card-sub">
            Per agreement maximum: <Money amount={str(m.per_agreement_max)} currency={currency} />
          </p>
          <p className="card-sub">Categories: {Array.isArray(m.allowed_categories) ? m.allowed_categories.join(", ") : ""}</p>

          <h3>Reservations and Agreements</h3>
          {reservations.length === 0 ? (
            <p className="muted-copy">No Reservations yet.</p>
          ) : (
            <table className="data-table" aria-label="Linked Reservations">
              <thead>
                <tr><th>Reservation</th><th>Agreement</th><th>Agreement status</th><th>Amount</th><th>State</th></tr>
              </thead>
              <tbody>
                {reservations.map((r) => (
                  <tr key={str(r.id)}>
                    <td>{short(r.id)}</td>
                    <td>
                      {short(r.agreement_id)}
                      <div><AutonomousLabel mandateId={mandateId} replayed={r.replayed === true} /></div>
                    </td>
                    <td>{str(r.agreement_status)}</td>
                    <td><Money amount={str(r.amount)} currency={currency} /></td>
                    <td>{str(r.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Open Alerts</h3>
          {alerts.status === "loading" && <Loading label="Loading Alerts…" />}
          {alerts.status === "error" && <p className="muted-copy">Alerts are unavailable: {alerts.error}</p>}
          {alerts.status === "ok" &&
            (openAlerts.length === 0 ? (
              <p className="muted-copy">No open Alerts for this Mandate.</p>
            ) : (
              <ul aria-label="Open Alerts">
                {openAlerts.map((a) => (
                  <li key={str(a.id)}>
                    <StatusBadge label={str(a.severity)} variant={str(a.severity) === "high" || str(a.severity) === "critical" ? "error" : "warning"} />{" "}
                    {str(a.detector)}
                  </li>
                ))}
              </ul>
            ))}

          {error && <p className="notice notice-error" role="alert">{error}</p>}
          {canRevoke(status, role) && (
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void revoke()}>
              {busy ? "Revoking…" : "Revoke Mandate"}
            </button>
          )}
          {readOnly && <p className="card-sub">Mandates are switched off. You can still revoke; nothing else changes.</p>}
        </>
      )}
    </aside>
  );
}

export const MandatesWorkspace: React.FC<{ role?: string }> = ({ role }) => {
  const caps = useLatestFetch((signal) => agenticApi.capabilities({ signal }), []);
  const list = useLatestFetch((signal) => agenticApi.mandates.list({ limit: 100 }, { signal }), []);
  const [selected, setSelected] = useState<string | null>(null);
  // Rows the server returned from a revoke, keyed by Mandate ID, so `revoked` shows at once.
  const [revoked, setRevoked] = useState<Record<string, Row>>({});

  const flagOn = caps.status === "ok" ? caps.data.flags.mandates === true : undefined;
  const base = list.status === "ok" ? list.data.mandates : [];
  const rows = useMemo(
    () => Object.values(revoked).reduce<Row[]>((acc, r) => mergeRow(acc, r), base),
    [base, revoked],
  );
  const view = mandateView(flagOn, list.status === "ok" ? rows.length : list.status === "error" ? 0 : undefined);

  if (caps.status === "error") {
    return <p className="notice notice-error" role="alert">Could not load capabilities: {caps.error}</p>;
  }
  if (view === "loading") return <Loading label="Loading Mandates…" />;
  if (view === "disabled") {
    return (
      <EmptyState title="Mandates are switched off">
        An administrator can turn Mandates on for this workspace. There are no Mandates to wind down.
      </EmptyState>
    );
  }
  const readOnly = view === "wind-down";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      {readOnly && (
        <p className="notice" role="status">
          Mandates are switched off. This view is read-only: you can look at existing Mandates and revoke them.
        </p>
      )}
      {!readOnly && role === "buyer" && (
        <CreateForm
          onCreated={(mandate) => {
            setSelected(str(mandate.id));
            list.reload();
          }}
        />
      )}
      <VirtualGridPanel
        title="Mandates"
        rows={rows}
        cols={COLS}
        loading={list.status === "loading"}
        error={list.status === "error" ? list.error : undefined}
        getRowId={(p) => str((p.data as Row).id)}
        onRowClick={(row) => setSelected(str((row as Row).id))}
      />
      {selected && (
        <MandateDrawer
          key={selected}
          mandateId={selected}
          role={role}
          revoked={revoked[selected]}
          readOnly={readOnly}
          onClose={() => setSelected(null)}
          onRevoked={(m) => {
            setRevoked((prev) => ({ ...prev, [str(m.id)]: m }));
            list.reload();
          }}
        />
      )}
    </div>
  );
};
