import React, { useState } from "react";
import type { ColDef } from "ag-grid-community";
import { X } from "lucide-react";
import { agenticApi } from "../api.js";
import { useLatestFetch } from "../hooks.js";
import { Card, EmptyState, Icon, Loading } from "../components/ui.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { VirtualGridPanel } from "../components/agentic/VirtualGridPanel.js";
import { ModelWrittenLabel, ReplayLabel } from "../components/agentic/labels.js";
import {
  THRESHOLD_FIELDS,
  buildThresholdBody,
  canRelease,
  evidenceEntries,
  severityVariant,
  thresholdError,
} from "../components/agentic/watchdogHelpers.js";

type Row = Record<string, unknown>;

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const asRow = (v: unknown): Row => (v && typeof v === "object" ? (v as Row) : {});
const short = (v: unknown): string => (str(v) ? `${str(v).slice(0, 8)}…` : "");
const when = (v: unknown): string => (v ? new Date(str(v)).toLocaleString() : "");
const errText = (err: unknown, fallback: string): string => {
  const e = err as { code?: string; message?: string } | null;
  return `${e?.code ? `${e.code}: ` : ""}${e?.message || fallback}`;
};

const ALERT_COLS: ColDef[] = [
  {
    field: "severity",
    headerName: "Severity",
    width: 120,
    cellRenderer: ({ value }: { value: string }) => <StatusBadge label={value} variant={severityVariant(value)} />,
  },
  { field: "detector", headerName: "Detector", width: 190 },
  { field: "subject_type", headerName: "Subject", width: 150 },
  { field: "status", headerName: "Status", width: 110 },
  { field: "response", headerName: "Response", width: 140 },
  { field: "first_seen_at", headerName: "First seen", flex: 1, valueFormatter: ({ value }) => when(value) },
];

const HOLD_COLS: ColDef[] = [
  { field: "id", headerName: "Hold", width: 120, valueFormatter: ({ value }) => short(value) },
  { field: "status", headerName: "Status", width: 110 },
  { field: "scope_type", headerName: "Subject", width: 150 },
  { field: "reason_code", headerName: "Reason code", width: 190 },
  { field: "placed_by_type", headerName: "Placed by", width: 120 },
  { field: "placed_at", headerName: "Placed", flex: 1, valueFormatter: ({ value }) => when(value) },
];

interface AlertDrawerProps {
  alertId: string;
  canExplain: boolean;
  onClose: () => void;
}

function AlertDrawer({ alertId, canExplain, onClose }: AlertDrawerProps) {
  const detail = useLatestFetch((signal) => agenticApi.watchdog.alert(alertId, { signal }), [alertId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [explained, setExplained] = useState<Row | null | undefined>(undefined);

  const d = detail.status === "ok" ? detail.data : undefined;
  const alert = asRow(d?.alert);
  const explanation = asRow(explained !== undefined ? explained : d?.explanation);
  const hasExplanation = Object.keys(explanation).length > 0;
  const payload = asRow(explanation.payload);
  const factors = Array.isArray(payload.factors) ? (payload.factors as unknown[]) : [];

  async function explain() {
    setBusy(true);
    setError("");
    try {
      const res = await agenticApi.watchdog.explain(alertId);
      setExplained(res.explanation);
    } catch (err) {
      setError(errText(err, "Could not get an explanation."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="card" role="complementary" aria-label="Alert detail">
      <div className="card-header">
        <h2 className="card-title">Alert {short(alertId)}</h2>
        <button type="button" className="icon-button" aria-label="Close detail" onClick={onClose}>
          <Icon icon={X} />
        </button>
      </div>
      {detail.status === "loading" && !d && <Loading label="Loading Alert…" />}
      {detail.status === "error" && !d && (
        <p className="notice notice-error" role="alert">Could not load this Alert: {detail.error}</p>
      )}
      {d && (
        <>
          <p>
            <StatusBadge label={str(alert.severity)} variant={severityVariant(alert.severity)} />{" "}
            <span className="card-sub">{str(alert.detector)} · {str(alert.status)} · {str(alert.subject_type)}</span>
          </p>

          <section aria-label="Deterministic evidence">
            <h3>Evidence</h3>
            <p className="card-sub">Computed from the ledger by a fixed rule, not by a model.</p>
            <dl>
              {evidenceEntries(alert.evidence).map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </React.Fragment>
              ))}
            </dl>
          </section>

          <section aria-label="Model explanation">
            <h3>Model explanation</h3>
            {hasExplanation ? (
              <>
                <p>
                  <ModelWrittenLabel /> {explanation.replayed === true && <ReplayLabel />}
                </p>
                <p>{str(payload.summary)}</p>
                {factors.length > 0 && (
                  <ul>
                    {factors.map((f, i) => (
                      <li key={i}>{str(f)}</li>
                    ))}
                  </ul>
                )}
                {str(payload.next_step) && <p className="card-sub">Suggested next step: {str(payload.next_step)}</p>}
                <p className="card-sub">
                  Model <code>{str(explanation.model) || "none"}</code> · prompt hash <code>{str(explanation.prompt_hash) || "none"}</code>
                </p>
              </>
            ) : (
              <p className="card-sub">No explanation has been written for this Alert.</p>
            )}
            {error && <p className="notice notice-error" role="alert">{error}</p>}
            {canExplain && !hasExplanation && (
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void explain()}>
                {busy ? "Asking…" : "Explain this Alert"}
              </button>
            )}
          </section>
        </>
      )}
    </aside>
  );
}

interface HoldDrawerProps {
  holdId: string;
  onClose: () => void;
  onReleased: () => void;
}

function HoldDrawer({ holdId, onClose, onReleased }: HoldDrawerProps) {
  const detail = useLatestFetch((signal) => agenticApi.watchdog.hold(holdId, { signal }), [holdId]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Set only from a server response, so a failed release keeps the last confirmed status.
  const [confirmed, setConfirmed] = useState<Row | undefined>(undefined);

  const hold = { ...asRow(detail.status === "ok" ? detail.data.hold : undefined), ...(confirmed ?? {}) };
  const status = str(hold.status);

  async function release() {
    setBusy(true);
    setError("");
    try {
      const res = await agenticApi.watchdog.releaseHold(holdId, reason.trim());
      setConfirmed(asRow(res.hold));
      onReleased();
    } catch (err) {
      setError(errText(err, "The Hold could not be released."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="card" role="complementary" aria-label="Hold detail">
      <div className="card-header">
        <h2 className="card-title">Hold {short(holdId)}</h2>
        <button type="button" className="icon-button" aria-label="Close detail" onClick={onClose}>
          <Icon icon={X} />
        </button>
      </div>
      {detail.status === "loading" && !status && <Loading label="Loading Hold…" />}
      {detail.status === "error" && !status && (
        <p className="notice notice-error" role="alert">Could not load this Hold: {detail.error}</p>
      )}
      {status && (
        <>
          <p>
            <StatusBadge label={status} variant={status === "active" ? "warning" : "ok"} />{" "}
            <span className="card-sub">{str(hold.scope_type)} · {str(hold.reason_code)} · placed {when(hold.placed_at)}</span>
          </p>
          {str(hold.release_reason) && <p>Released: {str(hold.release_reason)}</p>}
          {error && <p className="notice notice-error" role="alert">{error}</p>}
          {status === "active" && (
            <form className="portal-form" aria-label="Release Hold" onSubmit={(e) => e.preventDefault()}>
              <label>
                Reason (required)
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} />
              </label>
              <button
                type="button"
                className="primary-button"
                disabled={busy || !canRelease(status, reason)}
                onClick={() => void release()}
              >
                {busy ? "Releasing…" : "Release Hold"}
              </button>
            </form>
          )}
        </>
      )}
    </aside>
  );
}

function DetectorForm({ detector, current, onSaved }: { detector: string; current: Row; onSaved: () => void }) {
  const fields = THRESHOLD_FIELDS[detector] ?? [];
  const params = asRow(current.params);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, str(params[f.key])])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const errors = Object.fromEntries(fields.map((f) => [f.key, thresholdError(f, values[f.key] ?? "")]));
  const invalid = Object.values(errors).some(Boolean);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await agenticApi.watchdog.setThreshold(detector, buildThresholdBody(fields, values));
      setSaved(true);
      onSaved();
    } catch (err) {
      // The old value stays on the server; the form keeps what was typed.
      setError(errText(err, "Could not save the threshold."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="portal-form" aria-label={`Thresholds for ${detector}`} onSubmit={submit}>
      <h3>{detector}</h3>
      {fields.map((f) => (
        <label key={f.key}>
          {f.label}
          <input
            inputMode="decimal"
            value={values[f.key] ?? ""}
            onChange={(e) => {
              setSaved(false);
              setValues((v) => ({ ...v, [f.key]: e.target.value }));
            }}
            aria-invalid={errors[f.key] ? true : undefined}
          />
          <span className="card-sub">
            Allowed: {f.min} to {f.max}
            {f.integer ? " (whole number)" : ""}
          </span>
          {errors[f.key] && <span className="notice notice-error" role="alert">{errors[f.key]}</span>}
        </label>
      ))}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {saved && <p className="card-sub" role="status">Saved.</p>}
      <button type="submit" className="primary-button" disabled={busy || invalid}>
        {busy ? "Saving…" : "Save thresholds"}
      </button>
    </form>
  );
}

function ThresholdSection() {
  const t = useLatestFetch((signal) => agenticApi.watchdog.thresholds({ signal }), []);
  if (t.status === "loading") return <Loading label="Loading thresholds…" />;
  if (t.status === "error") {
    return <p className="notice notice-error" role="alert">Could not load thresholds: {t.error}</p>;
  }
  const data = t.data;
  if (!data) return null;
  const all = asRow(data.thresholds);
  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      {data.detectors
        .filter((d) => (THRESHOLD_FIELDS[d] ?? []).length > 0)
        .map((d) => (
          <DetectorForm key={`${d}:${JSON.stringify(asRow(all[d]).params)}`} detector={d} current={asRow(all[d])} onSaved={() => t.reload()} />
        ))}
    </div>
  );
}

export const WatchdogWorkspace: React.FC<{ role?: string }> = ({ role }) => {
  const isAdmin = role === "operator" || role === "supervisor";
  const caps = useLatestFetch((signal) => agenticApi.capabilities({ signal }), []);
  const alerts = useLatestFetch((signal) => agenticApi.watchdog.alerts({ limit: 100 }, { signal }), []);
  const holds = useLatestFetch((signal) => agenticApi.watchdog.holds({ limit: 100 }, { signal }), []);
  const [alertId, setAlertId] = useState<string | null>(null);
  const [holdId, setHoldId] = useState<string | null>(null);

  if (caps.status === "error") {
    return <p className="notice notice-error" role="alert">Could not load capabilities: {caps.error}</p>;
  }
  if (alerts.status === "loading" && holds.status === "loading") return <Loading label="Loading Watchdog…" />;

  const alertRows = alerts.status === "ok" ? alerts.data.alerts : [];
  const holdRows = holds.status === "ok" ? holds.data.holds : [];
  const canExplain = isAdmin && caps.status === "ok" && caps.data.flags.watchdog_explanations === true;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      <Card title="Alerts" description="Raised by fixed rules over your ledger. The Watchdog can place a Hold; only a person releases it.">
        {alerts.status === "ok" && alertRows.length === 0 ? (
          <EmptyState title="No Alerts">Nothing has been flagged.</EmptyState>
        ) : (
          <VirtualGridPanel
            title="Alerts"
            rows={alertRows}
            cols={ALERT_COLS}
            loading={alerts.status === "loading"}
            error={alerts.status === "error" ? alerts.error : undefined}
            getRowId={(p) => str((p.data as Row).id)}
            onRowClick={(row) => setAlertId(str((row as Row).id))}
          />
        )}
      </Card>
      {alertId && <AlertDrawer key={alertId} alertId={alertId} canExplain={canExplain} onClose={() => setAlertId(null)} />}

      <Card title="Holds" description="A Hold stops the subject from moving until a person releases it with a reason.">
        {holds.status === "ok" && holdRows.length === 0 ? (
          <EmptyState title="No Holds">No Holds have been placed.</EmptyState>
        ) : (
          <VirtualGridPanel
            title="Holds"
            rows={holdRows}
            cols={HOLD_COLS}
            loading={holds.status === "loading"}
            error={holds.status === "error" ? holds.error : undefined}
            getRowId={(p) => str((p.data as Row).id)}
            onRowClick={(row) => setHoldId(str((row as Row).id))}
          />
        )}
      </Card>
      {holdId && (
        <HoldDrawer key={holdId} holdId={holdId} onClose={() => setHoldId(null)} onReleased={() => holds.reload()} />
      )}

      {isAdmin && (
        <Card title="Thresholds" description="Detector limits. The allowed range is shown beside each field; the server checks it again.">
          <ThresholdSection />
        </Card>
      )}
    </div>
  );
};
