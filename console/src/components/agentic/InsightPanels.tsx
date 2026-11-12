import React, { useEffect, useMemo, useState } from "react";
import type { ColDef } from "ag-grid-community";
import { agenticApi, type AgenticDigestFigure, type AgenticInsightResponse, type AgenticIntentResult, type AgenticQuestionResponse } from "../../api.js";
import { Card, Loading } from "../ui.js";
import { ChartPanel } from "../ChartPanel.js";
import { AccessibleChart } from "./AccessibleChart.js";
import { VirtualGridPanel } from "./VirtualGridPanel.js";
import { Money } from "./Money.js";
import { ModelWrittenLabel, ReplayLabel } from "./labels.js";
import { errorCode, errorWithCode } from "./analyticsHelpers.js";
import { chartYIsMoney, citedFigures, figureLabel, insightNoticeText, intentChartPoints, paramEntries } from "./insightHelpers.js";

type Row = Record<string, unknown>;

const FigureValue: React.FC<{ figure: AgenticDigestFigure }> = ({ figure }) => {
  if (figure.kind === "amount" && figure.currency) return <Money amount={figure.value} currency={figure.currency} />;
  const suffix = figure.kind === "percent" ? "%" : figure.kind === "days" ? " days" : "";
  return <span>{figure.value}{suffix}</span>;
};

const FigureList: React.FC<{ figures: readonly AgenticDigestFigure[]; label: string }> = ({ figures, label }) => (
  <dl aria-label={label} style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "2px var(--space-3)", margin: 0 }}>
    {figures.map((f) => (
      <React.Fragment key={f.key}>
        <dt>{figureLabel(f.key)}</dt>
        <dd style={{ margin: 0 }}><FigureValue figure={f} /></dd>
      </React.Fragment>
    ))}
  </dl>
);

// ── Insight card ────────────────────────────────────────────────────────────────────────────

export const InsightCard: React.FC<{
  from: string;
  to: string;
  onFollowUp?: (intent: string, params: Record<string, unknown>) => void;
}> = ({ from, to, onFollowUp }) => {
  const [state, setState] = useState<{ status: "idle" | "loading" | "error" | "ok"; data?: AgenticInsightResponse; error?: string }>({ status: "idle" });

  const generate = () => {
    setState({ status: "loading" });
    agenticApi.analytics
      .insights({ from, to })
      .then((data) => setState({ status: "ok", data }))
      .catch((e: unknown) => setState({ status: "error", error: errorWithCode(e) }));
  };

  const data = state.data;
  const narrative = data?.narrative ?? null;
  return (
    <Card title="Insight" description="A short written summary of this date range. The figures come from the ledger; a model only writes the words.">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }} aria-busy={state.status === "loading"}>
        <div>
          <button type="button" className="primary-button" onClick={generate} disabled={state.status === "loading"}>
            {data ? "Refresh insight" : "Generate insight"}
          </button>
        </div>
        {state.status === "loading" && <Loading label="Generating insight…" />}
        {state.status === "error" && (
          <div className="notice notice-error" role="alert">
            Could not generate the insight. Error code: <strong>{errorCode(state.error ?? "")}</strong>. {state.error}
          </div>
        )}
        {state.status === "ok" && data && (
          <>
            {narrative ? (
              <div data-testid="insight-narrative">
                <p style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
                  <ModelWrittenLabel />
                  {narrative.replayed ? <ReplayLabel /> : null}
                </p>
                <h3>{narrative.narrative.headline}</h3>
                <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                  {narrative.narrative.findings.map((f, i) => (
                    <li key={i}>
                      <p>{f.text}</p>
                      <FigureList figures={citedFigures(f.cites, data.digest.figures)} label={`Figures cited by finding ${i + 1}`} />
                    </li>
                  ))}
                </ul>
                {onFollowUp && narrative.narrative.follow_ups.length > 0 && (
                  <div role="group" aria-label="Follow-up questions" style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
                    {narrative.narrative.follow_ups.map((u, i) => (
                      <button key={i} type="button" className="small-button" onClick={() => onFollowUp(u.intent, u.params)}>
                        Run: {figureLabel(u.intent)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="notice" role="status" data-testid="insight-notice">{insightNoticeText(data.notice, data.notice_text)}</p>
            )}
            {data.digest.figures.length > 0 && (
              <details open={!narrative}>
                <summary>Digest figures</summary>
                <FigureList figures={data.digest.figures} label="Digest figures" />
              </details>
            )}
          </>
        )}
      </div>
    </Card>
  );
};

// ── Intent result ───────────────────────────────────────────────────────────────────────────

const colsFor = (result: AgenticIntentResult): ColDef[] =>
  result.columns.map((c) => ({
    field: c.field,
    headerName: figureLabel(c.field),
    cellRenderer:
      c.type === "money"
        ? ({ value, data }: { value: unknown; data?: Row }) =>
          value === null || value === undefined || value === "" ? <span>unknown</span> : <Money amount={String(value)} currency={String(data?.currency ?? "")} />
        : undefined,
  }));

export const IntentResultView: React.FC<{
  intent: string;
  params: Record<string, unknown> | null;
  result: AgenticIntentResult;
  replayed?: boolean;
}> = ({ intent, params, result, replayed }) => {
  const cols = useMemo(() => colsFor(result), [result]);
  const rows = useMemo(() => result.rows.map((r, i) => ({ ...r, __key: String(i) })), [result]);
  const points = intentChartPoints(result);
  return (
    <div data-testid="intent-result" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <p style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
        <span>Intent: <code>{intent}</code></span>
        {replayed ? <ReplayLabel /> : null}
      </p>
      <dl aria-label="Validated parameters" style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "2px var(--space-3)", margin: 0 }}>
        {paramEntries(params ?? result.params).map(([k, v]) => (
          <React.Fragment key={k}>
            <dt>{k}</dt>
            <dd style={{ margin: 0 }}>{v}</dd>
          </React.Fragment>
        ))}
      </dl>
      {result.truncated && <p className="notice" role="status">Showing the first {result.rows.length} of {result.row_count} rows. The display is truncated.</p>}
      <VirtualGridPanel title={`Answer: ${intent}`} rows={rows} cols={cols} getRowId={(p) => String((p.data as Row).__key)} />
      {result.chart && points.length > 0 &&
        (chartYIsMoney(result) ? (
          <AccessibleChart title={`Chart: ${intent}`} points={points} type={result.chart.type === "line" ? "line" : "bar"} />
        ) : (
          <ChartPanel
            title={`Chart: ${intent}`}
            data={points.map((p) => ({ label: p.label, value: Number(p.value) }))}
            series={[{ type: result.chart.type === "line" ? "line" : "bar", xKey: "label", yKey: "value", yName: result.chart.y }]}
          />
        ))}
    </div>
  );
};

// ── Question panel ──────────────────────────────────────────────────────────────────────────

export const QuestionPanel: React.FC<{
  /** A follow-up the person selected from the insight card. Runs once per selection. */
  followUp?: { id: number; intent: string; params: Record<string, unknown> } | null;
}> = ({ followUp }) => {
  const [text, setText] = useState("");
  const [state, setState] = useState<{ status: "idle" | "loading" | "error" | "ok"; error?: string; answer?: AgenticQuestionResponse; followUp?: AgenticIntentResult & { name: string } }>({ status: "idle" });

  // A selected follow-up runs once per selection, because a person chose it (R13.8).
  const followUpId = followUp?.id;
  useEffect(() => {
    if (!followUp) return;
    let live = true;
    setState({ status: "loading" });
    agenticApi.analytics
      .runIntent(followUp.intent, followUp.params)
      .then((r) => live && setState({ status: "ok", followUp: { ...r, name: followUp.intent } }))
      .catch((e: unknown) => live && setState({ status: "error", error: errorWithCode(e) }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followUpId]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = text.trim();
    if (!q) return;
    setState({ status: "loading" });
    agenticApi.analytics
      .ask(q)
      .then((answer) => setState({ status: "ok", answer }))
      .catch((err: unknown) => setState({ status: "error", error: errorWithCode(err) }));
  };

  const { answer } = state;
  return (
    <Card title="Ask a question" description="Ask about your payments in plain words. A model picks one fixed, read-only report; it cannot change anything.">
      <form onSubmit={submit} aria-label="Ask a question" style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ flex: 1, minWidth: 240 }}>
          Your question
          <input value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder="For example: which Mandates are closest to their cap?" />
        </label>
        <button type="submit" className="primary-button" disabled={state.status === "loading" || !text.trim()}>Ask</button>
      </form>
      <div aria-live="polite" aria-busy={state.status === "loading"} style={{ marginTop: "var(--space-3)" }}>
        {state.status === "loading" && <Loading label="Working on it…" />}
        {state.status === "error" && (
          <div className="notice notice-error" role="alert">
            Could not answer. Error code: <strong>{errorCode(state.error ?? "")}</strong>. {state.error}
          </div>
        )}
        {state.status === "ok" && state.followUp && (
          <IntentResultView intent={state.followUp.name} params={state.followUp.params} result={state.followUp} />
        )}
        {state.status === "ok" && answer?.outcome === "intent" && answer.result && answer.intent && (
          <IntentResultView intent={answer.intent} params={answer.params} result={answer.result} replayed={answer.replayed} />
        )}
        {state.status === "ok" && answer?.outcome === "unsupported" && (
          <div role="status" data-testid="question-unsupported">
            <p style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
              <span>I can't answer that question. I can run these reports:</span>
              {answer.replayed ? <ReplayLabel /> : null}
            </p>
            <ul>
              {answer.allowed_intents.map((i) => (
                <li key={i.name}><code>{i.name}</code>: {i.description}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
};
