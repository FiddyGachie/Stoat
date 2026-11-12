import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColDef } from "ag-grid-community";
import { Activity, BarChart3, Download } from "lucide-react";
import { EconomicEventView, walletApi } from "../api.js";
import { ChartPanel } from "../components/ChartPanel.js";
import { GridPanel } from "../components/GridPanel.js";
import { Card, EmptyState, Loading } from "../components/ui.js";
import { describeError } from "../walletReturn.js";
import { withTimeout } from "./WalletMissions.js";
import {
  ANALYTICS_TIMEOUT_MS,
  AnalyticsColumn,
  AnalyticsRow,
  CHARTS,
  ChartDef,
  ChartPointRow,
  DATASETS,
  DETAIL_TIMEOUT_MS,
  DatasetDef,
  PAGE_SIZE,
  appendPage,
  cellText,
  columnLabel,
  csvFileName,
  eventEntity,
  moneyComparator,
  paypalIds,
  pivotByCurrency,
  relatedLedger,
  statusCounts,
  utilizationRows,
} from "../walletAnalytics.js";

type GoTo = (target: string) => void;

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

function EmptyWithAction({
  icon,
  title,
  empty,
  goTo,
}: {
  icon: typeof Activity;
  title: string;
  empty: { text: string; action: string; target: string };
  goTo: GoTo;
}) {
  return (
    <EmptyState icon={icon} title={title}>
      {empty.text}{" "}
      <button type="button" className="secondary-button" onClick={() => goTo(empty.target)}>
        {empty.action}
      </button>
    </EmptyState>
  );
}

const EnvLabel = ({ env }: { env: string | null }) =>
  env ? <span className="badge badge-neutral">PayPal environment: {env}</span> : null;

/* ── Row detail: PayPal IDs, ledger entries, event history (R14.4) ── */

type Part<T> = { status: "loading" } | { status: "ok"; data: T } | { status: "error"; text: string };

function RowDetail({ dataset, row, onClose }: { dataset: DatasetDef; row: AnalyticsRow; onClose: () => void }) {
  const [ledger, setLedger] = useState<Part<AnalyticsRow[]>>({ status: "loading" });
  const [events, setEvents] = useState<Part<EconomicEventView[]>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const ids = paypalIds(row);

  useEffect(() => {
    let live = true;
    setLedger({ status: "loading" });
    setEvents({ status: "loading" });
    withTimeout(walletApi.analytics("ledger-lines", { limit: String(PAGE_SIZE) }), DETAIL_TIMEOUT_MS).then(
      (r) => live && setLedger({ status: "ok", data: relatedLedger(dataset.id, row, (r?.rows ?? []) as AnalyticsRow[]) }),
      (e) => live && setLedger({ status: "error", text: describeError(e) }),
    );
    const entity = eventEntity(dataset.id, row);
    if (!entity) setEvents({ status: "ok", data: [] });
    else
      withTimeout(walletApi.events(entity), DETAIL_TIMEOUT_MS).then(
        (r) => live && setEvents({ status: "ok", data: r.events }),
        (e) => live && setEvents({ status: "error", text: describeError(e) }),
      );
    return () => {
      live = false;
    };
  }, [dataset.id, row, tick]);

  const retry = () => setTick((t) => t + 1);

  return (
    <section className="card" aria-label={`${dataset.label} row details`} aria-live="polite">
      <div className="card-header">
        <h3 className="card-title">Row details</h3>
        <button type="button" className="secondary-button" onClick={onClose}>
          Close details
        </button>
      </div>
      <h4>PayPal IDs</h4>
      {ids.length === 0 ? (
        <p>none recorded</p>
      ) : (
        <dl>
          {ids.map((i, n) => (
            <div key={`${i.value}-${n}`}>
              <dt>{i.label}</dt>
              <dd>{i.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <h4>Ledger entries</h4>
      {ledger.status === "loading" ? (
        <Loading label="Loading ledger entries…" />
      ) : ledger.status === "error" ? (
        <ErrorLine text={ledger.text} onRetry={retry} />
      ) : ledger.data.length === 0 ? (
        <p>none recorded</p>
      ) : (
        <table className="data-table">
          <caption className="sr-only">Ledger entries for this row</caption>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">Debit</th>
              <th scope="col">Credit</th>
              <th scope="col">Currency</th>
              <th scope="col">When</th>
            </tr>
          </thead>
          <tbody>
            {ledger.data.map((l) => (
              <tr key={l.id ?? undefined}>
                <td>{l.account_code} {l.account_name}</td>
                <td>{cellText({ name: "debit", type: "money" }, l.debit)}</td>
                <td>{cellText({ name: "credit", type: "money" }, l.credit)}</td>
                <td>{l.currency}</td>
                <td>{l.effective_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4>Event history</h4>
      {events.status === "loading" ? (
        <Loading label="Loading event history…" />
      ) : events.status === "error" ? (
        <ErrorLine text={events.text} onRetry={retry} />
      ) : events.data.length === 0 ? (
        <p>none recorded</p>
      ) : (
        <ol>
          {events.data.map((e) => (
            <li key={e.id}>
              {e.recorded_at} {e.event_type}
              {e.amount ? ` ${cellText({ name: "amount", type: "money" }, e.amount)} ${e.currency ?? ""}` : ""}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/* ── One dataset grid ── */

type GridState =
  | { status: "loading" }
  | { status: "error"; text: string }
  | { status: "ok"; env: string | null; columns: AnalyticsColumn[]; rows: AnalyticsRow[]; next: string | null };

function DatasetGrid({ def, goTo }: { def: DatasetDef; goTo: GoTo }) {
  const [state, setState] = useState<GridState>({ status: "loading" });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<AnalyticsRow | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState("");
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvError, setCsvError] = useState("");
  const seq = useRef(0);

  const load = useCallback(() => {
    const mine = ++seq.current;
    setState({ status: "loading" });
    setSelected(null);
    withTimeout(walletApi.analytics(def.id, { limit: String(PAGE_SIZE) }), ANALYTICS_TIMEOUT_MS).then(
      (r) => {
        if (mine !== seq.current) return;
        setState({
          status: "ok",
          env: r.paypal_environment ?? null,
          columns: r.columns ?? [],
          rows: r.rows ?? [],
          next: r.next_cursor ?? null,
        });
      },
      (e) => {
        // Stale rows are never kept: the grid shows the error instead (R14.10).
        if (mine === seq.current) setState({ status: "error", text: describeError(e) });
      },
    );
  }, [def.id]);

  useEffect(() => {
    load();
    return () => {
      seq.current++;
    };
  }, [load]);

  const loadMore = async () => {
    if (state.status !== "ok" || !state.next || moreBusy) return;
    setMoreBusy(true);
    setMoreError("");
    try {
      const r = await withTimeout(
        walletApi.analytics(def.id, { limit: String(PAGE_SIZE), cursor: state.next }),
        ANALYTICS_TIMEOUT_MS,
      );
      setState((s) =>
        s.status === "ok" ? { ...s, rows: appendPage(s.rows, r.rows ?? []), next: r.next_cursor ?? null } : s,
      );
    } catch (e) {
      setMoreError(describeError(e));
    } finally {
      setMoreBusy(false);
    }
  };

  const downloadCsv = async () => {
    if (csvBusy) return;
    setCsvBusy(true);
    setCsvError("");
    try {
      const text = await walletApi.analyticsCsv(def.id);
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = csvFileName(def.id);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setCsvError(describeError(e));
    } finally {
      setCsvBusy(false);
    }
  };

  const columns = state.status === "ok" ? state.columns : [];
  const cols: ColDef[] = useMemo(
    () =>
      columns.map((c) => ({
        field: c.name,
        headerName: columnLabel(c.name),
        hide: hidden.has(c.name),
        valueFormatter: (p: { value: string | null }) => cellText(c, p.value),
        ...(c.type === "money" ? { comparator: moneyComparator, type: "rightAligned" } : {}),
      })),
    [columns, hidden],
  );

  const toggle = (name: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  if (state.status === "loading") return <Loading label={`Loading ${def.label.toLowerCase()}…`} />;
  if (state.status === "error")
    return (
      <section className="card" aria-label={def.label}>
        <h3 className="card-title">{def.label}</h3>
        <ErrorLine text={`Could not load ${def.label.toLowerCase()}: ${state.text}`} onRetry={load} />
      </section>
    );
  if (state.rows.length === 0)
    return (
      <section aria-label={def.label}>
        <EnvLabel env={state.env} />
        <EmptyWithAction icon={Activity} title={`No ${def.label.toLowerCase()}`} empty={def.empty} goTo={goTo} />
      </section>
    );

  return (
    <>
      <GridPanel
        title={def.label}
        rows={state.rows}
        cols={cols}
        hideCsv
        badge={<EnvLabel env={state.env} />}
        onRowClick={(r) => setSelected(r as AnalyticsRow)}
        actions={
          <>
            <details>
              <summary>Columns</summary>
              <fieldset>
                <legend className="sr-only">Visible columns for {def.label}</legend>
                {state.columns.map((c) => (
                  <label key={c.name} style={{ display: "block" }}>
                    <input
                      type="checkbox"
                      checked={!hidden.has(c.name)}
                      onChange={() => toggle(c.name)}
                    />{" "}
                    {columnLabel(c.name)}
                  </label>
                ))}
              </fieldset>
            </details>
            <button
              type="button"
              className="small-button"
              onClick={downloadCsv}
              disabled={csvBusy}
              aria-busy={csvBusy}
              aria-label={`Download all ${def.label} as CSV`}
            >
              <Download size={14} aria-hidden="true" /> <span>{csvBusy ? "Preparing…" : "CSV (all rows)"}</span>
            </button>
          </>
        }
      />
      <p className="field-note">
        Select a row (click, or press Enter on a cell) to see its PayPal IDs, ledger entries and event history.
      </p>
      {csvError && <ErrorLine text={csvError} />}
      {state.next && (
        <p>
          <button type="button" className="secondary-button" onClick={loadMore} disabled={moreBusy} aria-busy={moreBusy}>
            {moreBusy ? "Loading…" : `Load next ${PAGE_SIZE} rows`}
          </button>{" "}
          <span className="field-note">{state.rows.length} rows loaded. CSV includes every row.</span>
        </p>
      )}
      {moreError && <ErrorLine text={moreError} onRetry={loadMore} />}
      {selected && <RowDetail dataset={def} row={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

/* ── One chart with a data-table equivalent (R14.2, R15.13) ── */

type ChartState =
  | { status: "loading" }
  | { status: "error"; text: string }
  | { status: "ok"; env: string | null; points: ChartPointRow[] };

function buildChart(def: ChartDef, points: ChartPointRow[]): { data: unknown[]; series: unknown[] } {
  switch (def.id) {
    case "balance-over-time": {
      const p = pivotByCurrency(points, "date", [{ key: "balance", label: "Balance" }]);
      return { data: p.data, series: p.series.map((s) => ({ type: "line", ...s })) };
    }
    case "flows-per-day": {
      const p = pivotByCurrency(points, "date", [
        { key: "deposits", label: "Deposits" },
        { key: "refunds", label: "Refunds" },
      ]);
      return { data: p.data, series: p.series.map((s) => ({ type: "bar", ...s })) };
    }
    case "charges-per-mission": {
      const p = pivotByCurrency(points, "mission_title", [{ key: "charged", label: "Charged" }]);
      return { data: p.data, series: p.series.map((s) => ({ type: "bar", ...s })) };
    }
    case "budget-utilization":
      return {
        data: utilizationRows(points),
        series: [{ type: "bar", xKey: "mission_title", yKey: "utilization_percent", yName: "Utilization %" }],
      };
    case "deposit-status":
      return {
        data: statusCounts(points),
        series: [{ type: "donut", angleKey: "count", calloutLabelKey: "status" }],
      };
    default: {
      const p = pivotByCurrency(points, "date", [{ key: "absolute_difference", label: "Absolute difference" }]);
      return { data: p.data, series: p.series.map((s) => ({ type: "line", ...s })) };
    }
  }
}

function ChartCard({ def, goTo }: { def: ChartDef; goTo: GoTo }) {
  const [state, setState] = useState<ChartState>({ status: "loading" });
  const seq = useRef(0);

  const load = useCallback(() => {
    const mine = ++seq.current;
    setState({ status: "loading" });
    withTimeout(walletApi.analyticsChart(def.id), ANALYTICS_TIMEOUT_MS).then(
      (r) => {
        if (mine === seq.current) setState({ status: "ok", env: r.paypal_environment ?? null, points: r.points ?? [] });
      },
      (e) => {
        if (mine === seq.current) setState({ status: "error", text: describeError(e) });
      },
    );
  }, [def.id]);

  useEffect(() => {
    load();
    return () => {
      seq.current++;
    };
  }, [load]);

  const built = useMemo(
    () => (state.status === "ok" ? buildChart(def, state.points) : { data: [], series: [] }),
    [def, state],
  );

  if (state.status === "loading") return <Loading label={`Loading ${def.title.toLowerCase()}…`} />;
  if (state.status === "error")
    return (
      <section className="card" aria-label={def.title}>
        <h3 className="card-title">{def.title}</h3>
        <ErrorLine text={`Could not load this chart: ${state.text}`} onRetry={load} />
      </section>
    );
  if (state.points.length === 0)
    return (
      <section aria-label={def.title}>
        <h3 className="card-title">{def.title}</h3>
        <EnvLabel env={state.env} />
        <EmptyWithAction icon={BarChart3} title="No data yet" empty={def.emptyAction} goTo={goTo} />
      </section>
    );

  return (
    <div>
      <EnvLabel env={state.env} />
      <ChartPanel title={def.title} data={built.data} series={built.series} />
      <details>
        <summary>Data table for {def.title}</summary>
        <table className="data-table">
          <caption className="sr-only">{def.title} as a table</caption>
          <thead>
            <tr>
              {def.table.map((c) => (
                <th key={c} scope="col">{columnLabel(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.points.map((p, i) => (
              <tr key={i}>
                {def.table.map((c) => (
                  <td key={c}>{p[c] ?? "–"}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** Read-only analytics: nine grids and six charts. Nothing here moves money. */
export function WalletActivity({ goTo }: { goTo: GoTo }) {
  const [datasetId, setDatasetId] = useState(DATASETS[0].id);
  const def = DATASETS.find((d) => d.id === datasetId) ?? DATASETS[0];
  return (
    <Card title="Activity" icon={Activity} description="Read-only views of your wallet activity.">
      <div role="group" aria-label="Choose a dataset" style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        {DATASETS.map((d) => (
          <button
            key={d.id}
            type="button"
            className={d.id === datasetId ? "primary-button" : "secondary-button"}
            aria-pressed={d.id === datasetId}
            onClick={() => setDatasetId(d.id)}
          >
            {d.label}
          </button>
        ))}
      </div>
      <DatasetGrid key={def.id} def={def} goTo={goTo} />
      <div className="card-grid card-grid--wide">
        {CHARTS.map((c) => (
          <ChartCard key={c.id} def={c} goTo={goTo} />
        ))}
      </div>
    </Card>
  );
}
