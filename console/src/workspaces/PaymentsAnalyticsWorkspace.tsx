import React, { useEffect, useMemo, useReducer, useState } from "react";
import type { ColDef } from "ag-grid-community";
import { agenticApi } from "../api.js";
import { useLatestFetch } from "../hooks.js";
import { Card, Loading } from "../components/ui.js";
import { VirtualGridPanel } from "../components/agentic/VirtualGridPanel.js";
import { AccessibleChart, type CurrencyPoint } from "../components/agentic/AccessibleChart.js";
import { UtilizationBar } from "../components/agentic/UtilizationBar.js";
import { Money } from "../components/agentic/Money.js";
import { InsightCard, QuestionPanel } from "../components/agentic/InsightPanels.js";
import {
  activeFilterLabels,
  analyticsReducer,
  applyRowFilters,
  effectiveFilters,
  emptyStateText,
  environmentLabel,
  errorCode,
  errorWithCode,
  feeText,
  filterChartGroups,
  initialState,
  queryParams,
  selectionChips,
  truncateRows,
  truncationNotice,
  unappliedFilters,
  type AnalyticsAction,
  type AnalyticsState,
  type Dimension,
  type EffectiveFilters,
  type FieldMap,
} from "../components/agentic/analyticsHelpers.js";

type Row = Record<string, unknown>;
type Dispatch = React.Dispatch<AnalyticsAction>;

interface DatasetResponse {
  meta?: { paypal_environment?: string; row_count_total?: number; truncated?: boolean };
  groups?: Array<{ currency: string | null; rows: Row[] }>;
}
interface ChartResponse {
  meta?: DatasetResponse["meta"];
  groups?: Array<{ currency: string | null; points: Array<{ x: string; y: string }> }>;
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

// ── Columns ─────────────────────────────────────────────────────────────────────────────────
// No column field matches /recipient|payee|email/i (R11.2).

const moneyCol = (field: string, headerName: string): ColDef => ({
  field,
  headerName,
  minWidth: 150,
  cellRenderer: ({ value, data }: { value: unknown; data?: Row }) =>
    value === null || value === undefined || value === "" ? <span>unknown</span> : <Money amount={str(value)} currency={str(data?.currency)} />,
});

const dashFormatter = ({ value }: { value: unknown }) => (value === null || value === undefined ? "–" : str(value));

const SPEND_COLS: ColDef[] = [
  { field: "day", headerName: "UTC day", minWidth: 120 },
  { field: "currency", headerName: "Currency", minWidth: 100 },
  { field: "mandate_id", headerName: "Mandate", valueFormatter: dashFormatter },
  { field: "agent_id", headerName: "Agent" },
  { field: "provider_id", headerName: "Provider" },
  { field: "category", headerName: "Category" },
  moneyCol("reserved_amount", "Reserved"),
  moneyCol("charged_amount", "Charged"),
  moneyCol("released_amount", "Released"),
  { field: "count", headerName: "Count", minWidth: 90 },
];

const USAGE_COLS: ColDef[] = [
  { field: "mandate_id", headerName: "Mandate" },
  { field: "status", headerName: "Status", minWidth: 110 },
  {
    field: "usage",
    headerName: "Utilization",
    minWidth: 240,
    sortable: false,
    cellRenderer: ({ data }: { data?: Row }) => (
      <UtilizationBar used={str(data?.usage)} cap={str(data?.total_cap)} currency={str(data?.currency)} label="Total usage" />
    ),
  },
  moneyCol("today_usage", "Today"),
  moneyCol("daily_cap", "Daily cap"),
  moneyCol("remaining", "Remaining"),
];

const ALERT_COLS: ColDef[] = [
  { field: "day", headerName: "UTC day", minWidth: 120 },
  { field: "detector", headerName: "Detector" },
  { field: "severity", headerName: "Severity", minWidth: 110 },
  { field: "status", headerName: "Status", minWidth: 110 },
  { field: "count", headerName: "Count", minWidth: 90 },
];

const LATENCY_COLS: ColDef[] = [
  { field: "type", headerName: "Type" },
  { field: "status", headerName: "Status", minWidth: 110 },
  { field: "count", headerName: "Count", minWidth: 90 },
  { field: "min_seconds", headerName: "Min seconds", valueFormatter: dashFormatter },
  { field: "median_seconds", headerName: "Median seconds", valueFormatter: dashFormatter },
  { field: "max_seconds", headerName: "Max seconds", valueFormatter: dashFormatter },
];

const PAYPAL_COLS: ColDef[] = [
  { field: "day", headerName: "UTC day", minWidth: 120 },
  { field: "kind", headerName: "Kind", minWidth: 100 },
  { field: "status", headerName: "Status", minWidth: 110 },
  { field: "currency", headerName: "Currency", minWidth: 100 },
  { field: "count", headerName: "Count", minWidth: 90 },
  moneyCol("amount", "Amount"),
  {
    field: "fee_amount",
    headerName: "PayPal fee",
    minWidth: 190,
    // A fee PayPal did not report reads "unknown", never 0.
    valueGetter: ({ data }: { data?: Row }) =>
      feeText(data?.fee_amount as string | null | undefined, data?.fee_state as string | undefined, str(data?.currency)),
  },
];

// ── Panel frame: loading, error, empty, truncation ───────────────────────────────────────────

interface FrameProps {
  title: string;
  status: "idle" | "loading" | "error" | "ok";
  error?: string;
  onRetry: () => void;
  empty: boolean;
  eff: EffectiveFilters;
  notices?: string[];
  children: React.ReactNode;
}

function PanelFrame({ title, status, error, onRetry, empty, eff, notices = [], children }: FrameProps) {
  const waiting = status === "loading" || status === "idle";
  return (
    <section aria-label={title} aria-busy={waiting} style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {waiting && (
        <Card title={title}>
          <Loading label={`Loading ${title.toLowerCase()}…`} />
        </Card>
      )}
      {status === "error" && (
        <Card title={title}>
          <div className="notice notice-error" role="alert">
            <span>
              Could not load {title.toLowerCase()}. Error code: <strong>{errorCode(error ?? "")}</strong>. {error}
            </span>
            <button type="button" className="small-button" onClick={onRetry} aria-label={`Retry ${title}`}>
              Retry
            </button>
          </div>
        </Card>
      )}
      {status === "ok" && empty && (
        <Card title={title}>
          <div role="status">
            <p>{emptyStateText(eff).message}</p>
            <p>{emptyStateText(eff).total}</p>
          </div>
        </Card>
      )}
      {status === "ok" && !empty && (
        <>
          {notices.map((n) => (
            <p key={n} className="notice" role="status">{n}</p>
          ))}
          {children}
        </>
      )}
    </section>
  );
}

function useSelect(id: string, title: string, dispatch: Dispatch) {
  return (dimension: Dimension, value: string) => {
    if (value) dispatch({ type: "select", selection: { dimension, value, source: id, sourceLabel: title } });
  };
}

// ── Grid panel ──────────────────────────────────────────────────────────────────────────────

interface GridPanelProps {
  id: string;
  title: string;
  dataset: string;
  cols: ColDef[];
  fields: FieldMap;
  state: AnalyticsState;
  dispatch: Dispatch;
  onEnvironment: (env: unknown) => void;
  /** Clicking a row (or pressing Enter on a cell) narrows the other panels by this field. */
  select?: { dimension: Dimension; field: string };
  /** Only mandate-usage is a point-in-time view; the others take the date range. */
  status?: string;
}

function DatasetGrid({ id, title, dataset, cols, fields, state, dispatch, onEnvironment, select, status }: GridPanelProps) {
  const eff = effectiveFilters(state, id);
  const params = queryParams(eff);
  const key = JSON.stringify(params);
  const res = useLatestFetch(
    (signal) =>
      agenticApi.analytics
        .dataset(dataset, { ...params, status }, { signal })
        .catch((e: unknown) => {
          throw new Error(errorWithCode(e));
        }) as Promise<DatasetResponse>,
    [dataset, key, status],
  );
  const choose = useSelect(id, title, dispatch);

  useEffect(() => {
    if (res.status === "ok") onEnvironment(res.data.meta?.paypal_environment);
  }, [res.status, res.data, onEnvironment]);

  const view = useMemo(() => {
    if (res.status !== "ok") return null;
    // Flattening groups only concatenates rows. Each row keeps its own currency; nothing is summed.
    const flat: Row[] = (res.data.groups ?? []).flatMap((g) => g.rows.map((r) => ({ ...r })));
    const filtered = applyRowFilters(flat, eff, fields);
    const cut = truncateRows(filtered, Math.max(res.data.meta?.row_count_total ?? 0, filtered.length), res.data.meta?.truncated === true);
    return { ...cut, rows: cut.rows.map((r, i) => ({ ...r, __key: String(i) })) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res.status, res.data, key]);

  const notices: string[] = [];
  const unapplied = unappliedFilters(eff, fields);
  if (unapplied.length > 0) notices.push(`Not applied to this panel: ${unapplied.join(", ")}.`);
  if (view?.truncated) notices.push(truncationNotice(view.total));

  return (
    <PanelFrame title={title} status={res.status} error={res.error} onRetry={res.reload} empty={!view || view.rows.length === 0} eff={eff} notices={notices}>
      {view && (
        <VirtualGridPanel
          title={title}
          rows={view.rows}
          cols={cols}
          getRowId={(p) => str((p.data as Row).__key)}
          onRowClick={select ? (row) => choose(select.dimension, str((row as Row)[select.field])) : undefined}
        />
      )}
    </PanelFrame>
  );
}

// ── Chart panel ─────────────────────────────────────────────────────────────────────────────

interface ChartPanelProps {
  id: string;
  title: string;
  chart: string;
  dimension: Dimension;
  state: AnalyticsState;
  dispatch: Dispatch;
  onEnvironment: (env: unknown) => void;
}

function ChartBlock({ id, title, chart, dimension, state, dispatch, onEnvironment }: ChartPanelProps) {
  const eff = effectiveFilters(state, id);
  const params = queryParams(eff);
  const key = JSON.stringify(params);
  const res = useLatestFetch(
    (signal) =>
      agenticApi.analytics
        .chart(chart, params, { signal })
        .catch((e: unknown) => {
          throw new Error(errorWithCode(e));
        }) as Promise<ChartResponse>,
    [chart, key],
  );
  const choose = useSelect(id, title, dispatch);

  useEffect(() => {
    if (res.status === "ok") onEnvironment(res.data.meta?.paypal_environment);
  }, [res.status, res.data, onEnvironment]);

  const points: CurrencyPoint[] = useMemo(() => {
    if (res.status !== "ok") return [];
    // The day chart's x values are days, so only the other dimensions filter by their own value.
    const own = dimension === "day" ? "" : eff[dimension];
    return filterChartGroups(res.data.groups ?? [], eff.currency, own).flatMap((g) =>
      g.points.map((p) => ({ currency: g.currency ?? "", label: p.x, value: p.y })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res.status, res.data, key]);

  const unapplied = (["agent", "mandate", "provider", "category"] as const)
    .filter((d) => eff[d] && d !== dimension)
    .map((d) => d[0]!.toUpperCase() + d.slice(1));

  return (
    <PanelFrame
      title={title}
      status={res.status}
      error={res.error}
      onRetry={res.reload}
      empty={points.length === 0}
      eff={eff}
      notices={unapplied.length > 0 ? [`Not applied to this panel: ${unapplied.join(", ")}.`] : []}
    >
      <AccessibleChart title={title} points={points} type={dimension === "day" ? "line" : "bar"} onSegmentClick={(v) => choose(dimension, v)} />
    </PanelFrame>
  );
}

// ── Workspace ───────────────────────────────────────────────────────────────────────────────

const FILTER_INPUTS: Array<{ key: "currency" | "agent" | "mandate" | "provider"; label: string; max?: number }> = [
  { key: "currency", label: "Currency", max: 3 },
  { key: "agent", label: "Agent" },
  { key: "mandate", label: "Mandate" },
  { key: "provider", label: "Provider" },
];

export const PaymentsAnalyticsWorkspace: React.FC = () => {
  const [state, dispatch] = useReducer(analyticsReducer, undefined, () => initialState());
  const [draft, setDraft] = useState(state.filters);
  const [env, setEnv] = useState<string>("unknown");
  const [followUp, setFollowUp] = useState<{ id: number; intent: string; params: Record<string, unknown> } | null>(null);
  // Insight and question panels show only when their flags are on; unknown capabilities hide them.
  const caps = useLatestFetch((signal) => agenticApi.capabilities({ signal }), []);

  // Clear restores an earlier filter state, so the form follows it.
  useEffect(() => setDraft(state.filters), [state.filters]);

  const onEnvironment = useMemo(() => (v: unknown) => setEnv(environmentLabel(v)), []);
  const chips = selectionChips(state.selections);
  const common = { state, dispatch, onEnvironment };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      <header>
        <h1>Payments Analytics</h1>
        <p>
          PayPal environment: <strong data-testid="paypal-environment">{env}</strong>
        </p>
      </header>

      <form
        aria-label="Analytics filters"
        className="portal-form"
        onSubmit={(e) => {
          e.preventDefault();
          dispatch({ type: "set_filters", filters: { ...draft, currency: draft.currency.trim().toUpperCase() } });
        }}
        style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)", alignItems: "flex-end" }}
      >
        <label>
          From (UTC)
          <input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </label>
        <label>
          To (UTC)
          <input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </label>
        {FILTER_INPUTS.map((f) => (
          <label key={f.key}>
            {f.label}
            <input value={draft[f.key]} maxLength={f.max} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
          </label>
        ))}
        <button type="submit" className="primary-button">Apply filters</button>
      </form>

      {(chips.length > 0 || state.saved) && (
        <div role="group" aria-label="Active selections" style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center" }}>
          <ul style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", listStyle: "none", margin: 0, padding: 0 }}>
            {chips.map((c) => (
              <li key={c.key} className="chip" style={{ border: "1px solid var(--color-border)", borderRadius: 12, padding: "2px 10px" }}>
                {c.label}
              </li>
            ))}
          </ul>
          <button type="button" className="small-button" onClick={() => dispatch({ type: "clear" })}>
            Clear selection
          </button>
        </div>
      )}
      <p className="sr-only" aria-live="polite">{`Active filters: ${activeFilterLabels(effectiveFilters(state, "")).join("; ")}`}</p>

      {caps.status === "ok" && caps.data.flags.insights === true && (
        <InsightCard
          from={state.filters.from}
          to={state.filters.to}
          onFollowUp={
            caps.data.flags.nl_questions === true
              ? (intent, params) => setFollowUp((p) => ({ id: (p?.id ?? 0) + 1, intent, params }))
              : undefined
          }
        />
      )}
      {caps.status === "ok" && caps.data.flags.nl_questions === true && <QuestionPanel followUp={followUp} />}

      <ChartBlock id="spend-mandate" title="Spend by Mandate" chart="spend-by-mandate" dimension="mandate" {...common} />
      <ChartBlock id="spend-agent" title="Spend by agent" chart="spend-by-agent" dimension="agent" {...common} />
      <ChartBlock id="spend-provider" title="Spend by provider" chart="spend-by-provider" dimension="provider" {...common} />
      <ChartBlock id="spend-category" title="Spend by category" chart="spend-by-category" dimension="category" {...common} />
      <ChartBlock id="spend-day" title="Spend by UTC day" chart="spend-by-day" dimension="day" {...common} />

      <DatasetGrid
        id="spend-facts"
        title="Spend facts"
        dataset="spend-facts"
        cols={SPEND_COLS}
        fields={{ currency: "currency", agent: "agent_id", mandate: "mandate_id", provider: "provider_id", category: "category" }}
        select={{ dimension: "mandate", field: "mandate_id" }}
        {...common}
      />
      <DatasetGrid
        id="utilization"
        title="Mandate utilization"
        dataset="mandate-usage"
        cols={USAGE_COLS}
        fields={{ currency: "currency", mandate: "mandate_id" }}
        select={{ dimension: "mandate", field: "mandate_id" }}
        {...common}
      />
      <DatasetGrid id="alerts" title="Watchdog Alerts" dataset="alerts" cols={ALERT_COLS} fields={{}} {...common} />
      <DatasetGrid id="holds" title="Watchdog Holds" dataset="holds" cols={LATENCY_COLS} fields={{}} {...common} />
      <DatasetGrid id="proposals" title="Proposal outcomes" dataset="proposals" cols={LATENCY_COLS} fields={{}} {...common} />
      <DatasetGrid
        id="paypal"
        title="PayPal capture, refund, payout and fee status"
        dataset="paypal-flows"
        cols={PAYPAL_COLS}
        fields={{ currency: "currency" }}
        {...common}
      />
    </div>
  );
};
