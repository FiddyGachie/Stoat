import { useCallback, useEffect, useMemo, useState } from "react";
import { api, AgentPerformance, PerformanceOverview } from "../api.js";
import { ChartPanel } from "./ChartPanel.js";
import { useLiveRefresh } from "../live.js";
import { CHART_COLORS } from "../styles/chartTheme.js";

/**
 * "How are my agents doing?" dashboard.
 *
 * Every figure comes from GET /v1/agents/performance, which computes it live from
 * deliveries, verifications, obligations, agreements and agent runs. Nothing is
 * estimated here. Money is shown as the API's decimal string next to its currency and
 * different currencies are never added together.
 */
type Mode = "owner" | "self" | "operator";

const percent = (rate: number | null) => (rate === null ? null : Math.round(rate * 100));

function Rate({ rate }: { rate: number | null }) {
  const value = percent(rate);
  if (value === null) return <span className="muted">No judged deliveries yet</span>;
  return (
    <div className="rate" role="img" aria-label={`Verification rate ${value} percent`}>
      <div className="rate-track"><div className="rate-fill" style={{ width: `${value}%` }} /></div>
      <span>{value}%</span>
    </div>
  );
}

function Money({ rows, empty = "—" }: { rows: Array<{ label?: string; amount: string; currency: string }>; empty?: string }) {
  if (rows.length === 0) return <span className="muted">{empty}</span>;
  return (
    <>
      {rows.map((row) => (
        <div key={`${row.label}-${row.currency}`} className="money-line">
          {row.label && <span className="muted">{row.label} </span>}
          <strong>{row.amount}</strong> {row.currency}
        </div>
      ))}
    </>
  );
}

export function PerformanceDashboard({ mode, onChanged }: { mode: Mode; onChanged?: () => void }) {
  const [data, setData] = useState<PerformanceOverview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      setData(await api.agentPerformance());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load performance data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useLiveRefresh(() => { void load(true); });

  async function toggle(row: AgentPerformance) {
    const suspending = row.agent.status === "active";
    const prompt = suspending
      ? `Suspend "${row.agent.name}"? It is signed out immediately and cannot sign in or take new work until you reactivate it.`
      : `Reactivate "${row.agent.name}"? It will be able to sign in with its existing secret again.`;
    if (!window.confirm(prompt)) return;
    setBusyId(row.agent.id);
    setError("");
    try {
      await api.setAgentStatus(row.agent.id, suspending ? "suspended" : "active");
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the agent's status.");
    } finally {
      setBusyId("");
    }
  }

  const perCurrencyTrend = useMemo(() => {
    const byCurrency = new Map<string, Array<{ day: string; amount: number }>>();
    for (const point of data?.earnings_by_day ?? []) {
      const list = byCurrency.get(point.currency) ?? [];
      list.push({ day: point.day, amount: Number(point.amount) }); // chart axis only; tables show exact strings
      byCurrency.set(point.currency, list);
    }
    return [...byCurrency];
  }, [data]);

  const deliveriesChart = useMemo(
    () => (data?.agents ?? [])
      .filter((a) => a.deliveries.total > 0)
      .map((a) => ({ name: a.agent.name, verified: a.deliveries.verified, rejected: a.deliveries.rejected, needs_review: a.deliveries.needs_review })),
    [data],
  );

  const title = mode === "self" ? "My performance" : "Agent performance";
  const subtitle =
    mode === "self"
      ? "Your own delivery quality and earnings, computed from verified records."
      : "How your agents are performing, computed live from verified deliveries and the ledger.";

  return (
    <section className="portal-card performance-section" aria-labelledby="performance-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">PERFORMANCE · LIVE FROM LEDGER</p>
          <h2 id="performance-title">{title}</h2>
          <p className="portal-subtitle">{subtitle}</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <p className="notice notice-error" role="alert">
          {error} <button type="button" className="text-button" onClick={() => void load()}>Retry</button>
        </p>
      )}

      {!data && loading && <p role="status">Loading performance…</p>}

      {data && data.agents.length === 0 && (
        <div className="empty-state compact">
          <h3>No agents yet</h3>
          <p>Create a provider agent to publish a service, or a buyer agent to commission work. Performance appears here once they act.</p>
        </div>
      )}

      {data && data.agents.length > 0 && (
        <>
          <div className="kpi-grid">
            <div className="kpi-card">
              <span className="kpi-label">Agents</span>
              <span className="kpi-value">{data.summary.agents}</span>
              <span className="kpi-sub">{data.summary.active_agents} active · {data.summary.suspended_agents} suspended</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Verification rate</span>
              <span className="kpi-value">{percent(data.summary.verification_rate) === null ? "—" : `${percent(data.summary.verification_rate)}%`}</span>
              <span className="kpi-sub">{data.summary.deliveries_judged} judged deliveries</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Earned (verified work)</span>
              <span className="kpi-value kpi-money">
                <Money rows={data.summary.earned.map((e) => ({ amount: e.total, currency: e.currency }))} empty="0 — nothing verified yet" />
              </span>
              <span className="kpi-sub">Accrued in the ledger</span>
            </div>
            <div className="kpi-card">
              <span className="kpi-label">Committed spend</span>
              <span className="kpi-value kpi-money">
                <Money rows={data.summary.committed_spend.map((e) => ({ amount: e.total, currency: e.currency }))} empty="0" />
              </span>
              <span className="kpi-sub">Accepted agreements</span>
            </div>
          </div>

          <div className="chart-row">
            {perCurrencyTrend.map(([currency, points]) => (
              <ChartPanel
                key={currency}
                title={`Earned per day (${currency}, last 30 days)`}
                data={points}
                series={[{ type: "bar", xKey: "day", yKey: "amount", yName: `Accrued ${currency}`, fill: CHART_COLORS.primary }]}
              />
            ))}
            {deliveriesChart.length > 0 && (
              <ChartPanel
                title="Delivery outcomes by agent"
                data={deliveriesChart}
                series={[
                  { type: "bar", xKey: "name", yKey: "verified", yName: "Verified", stacked: true, fill: CHART_COLORS.success },
                  { type: "bar", xKey: "name", yKey: "rejected", yName: "Rejected", stacked: true, fill: CHART_COLORS.danger },
                  { type: "bar", xKey: "name", yKey: "needs_review", yName: "Needs review", stacked: true, fill: CHART_COLORS.warning },
                ]}
              />
            )}
          </div>

          <div className="table-scroll">
            <table className="perf-table">
              <caption className="visually-hidden">Per-agent delivery quality, earnings and spend</caption>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Status</th>
                  <th scope="col">Deliveries</th>
                  <th scope="col">Verification rate</th>
                  <th scope="col">Earned</th>
                  <th scope="col">Spend</th>
                  <th scope="col">Services</th>
                  {mode !== "self" && <th scope="col"><span className="visually-hidden">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {data.agents.map((row) => (
                  <tr key={row.agent.id}>
                    <th scope="row">
                      {row.agent.name}
                      <div><span className="role-pill">{row.agent.role}</span></div>
                    </th>
                    <td><span className={`status-pill status-${row.agent.status}`}>{row.agent.status}</span></td>
                    <td>
                      {row.deliveries.total === 0 ? (
                        <span className="muted">None</span>
                      ) : (
                        <>
                          <div><span aria-hidden="true">✓</span> {row.deliveries.verified} verified</div>
                          <div><span aria-hidden="true">✗</span> {row.deliveries.rejected} rejected</div>
                          {row.deliveries.needs_review > 0 && <div>{row.deliveries.needs_review} in review</div>}
                        </>
                      )}
                    </td>
                    <td><Rate rate={row.deliveries.verification_rate} /></td>
                    <td>
                      <Money
                        rows={row.earnings.flatMap((e) => [
                          { label: "Payable", amount: e.payable, currency: e.currency },
                          { label: "In settlement", amount: e.in_settlement, currency: e.currency },
                          { label: "Collected, provider unpaid", amount: e.settled, currency: e.currency },
                          { label: "Payout pending", amount: e.payout_pending, currency: e.currency },
                          { label: "Paid by PayPal", amount: e.paid, currency: e.currency },
                          { label: "Payout issue", amount: e.payout_issue, currency: e.currency },
                        ]).filter((r) => Number(r.amount) > 0)}
                      />
                    </td>
                    <td><Money rows={row.spend.map((s) => ({ amount: s.committed, currency: s.currency }))} /></td>
                    <td>{row.services.total === 0 ? <span className="muted">—</span> : `${row.services.active} active / ${row.services.total}`}</td>
                    {mode !== "self" && (
                      <td>
                        <button
                          type="button"
                          className="small-button"
                          disabled={busyId === row.agent.id}
                          onClick={() => void toggle(row)}
                          aria-label={`${row.agent.status === "active" ? "Suspend" : "Reactivate"} ${row.agent.name}`}
                        >
                          {row.agent.status === "active" ? "Suspend" : "Reactivate"}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="fine-print">
            “Earned” is what verified work has accrued in your internal ledger. A settlement captures the buyer's payment to the
            merchant account; paying providers out is not implemented, so nothing here means money has reached a provider.
          </p>
        </>
      )}
    </section>
  );
}

