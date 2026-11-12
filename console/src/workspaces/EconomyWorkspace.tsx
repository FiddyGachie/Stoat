import React, { useState } from "react";
import { Bot, ClipboardList, HandCoins, Landmark, ShieldAlert, ShieldCheck, Target } from "lucide-react";
import type { ColDef } from "ag-grid-community";
import { useFetch } from "../hooks.js";
import { api } from "../api.js";
import { ChartPanel } from "../components/ChartPanel.js";
import { GridPanel } from "../components/GridPanel.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { Card, CommerceHeroCard, EmptyState, Icon, Stat } from "../components/ui.js";
import { CHART_COLORS } from "../styles/chartTheme.js";

const MISSION_COLS: ColDef[] = [
  { field: "id", headerName: "ID", width: 90, valueFormatter: ({ value }) => value ? `${value.substring(0, 8)}…` : "" },
  { field: "title", headerName: "Mission Title", flex: 2, minWidth: 160 },
  { field: "status", headerName: "Status", width: 120,
    cellRenderer: ({ value }: { value: string }) =>
      <StatusBadge label={value} variant={value === "created" ? "live" : value === "completed" ? "ok" : "info"} /> },
  { field: "budget", headerName: "Budget", width: 130,
    valueFormatter: ({ value, data }) => value ? `${Number(value).toFixed(2)} ${(data as Record<string, string>)["currency"] ?? "USD"}` : "",
    cellStyle: { color: "var(--color-primary)" } },
  { field: "reserved_budget", headerName: "Reserved", width: 130,
    valueFormatter: ({ value, data }) => value ? `${Number(value).toFixed(2)} ${(data as Record<string, string>)["currency"] ?? "USD"}` : "",
    cellStyle: { color: "var(--color-violet)" } },
  { field: "created_at", headerName: "Created", flex: 1, minWidth: 140,
    valueFormatter: ({ value }) => value ? new Date(value).toLocaleDateString() : "" },
];

/** Landing screen: health, volume, live AG Charts and AG Grid analytics in an adaptive layout. */
export const EconomyWorkspace: React.FC = () => {
  const integrity = useFetch(() => api.integrity());
  const missions = useFetch(() => api.missions());
  const obligations = useFetch(() => api.obligations());
  const agents = useFetch(() => api.agents());
  const obByStatus = useFetch(() => api.aggregates.obligationsByStatus());
  const missionSpend = useFetch(() => api.aggregates.missionSpend());
  const policyDenials = useFetch(() => api.aggregates.policyDenials());
  const eventVolume = useFetch(() => api.aggregates.eventVolume());
  const captureRecon = useFetch(() => api.aggregates.captureReconciliation());

  const [gridFilter, setGridFilter] = useState("");

  const healthy = integrity.status === "ok" && integrity.data.integrity_status === "healthy";
  const integrityKnown = integrity.status === "ok";

  const counts: Record<string, number> = {};
  if (obligations.status === "ok") {
    for (const o of obligations.data.obligations as Array<{ status: string }>) counts[o.status] = (counts[o.status] ?? 0) + 1;
  }
  const stat = (state: { status: string }, value: () => React.ReactNode) =>
    state.status === "ok" ? value() : state.status === "error" ? "—" : "…";

  const missionRows = missions.status === "ok" ? missions.data.missions : [];

  return (
    <>
      <CommerceHeroCard
        title="Verified Digital Service Commerce"
        subtitle="Autonomous agent negotiations, cryptographic delivery verification, and human-authorized PayPal settlements."
        badgeText="Autonomous Commerce Engine"
      />

      <div className="card-grid card-grid--kpi" aria-label="Key figures">
        <Stat label="Missions" icon={Target} value={stat(missions, () => missions.data!.missions.length)} sub="Created by buyers" />
        <Stat label="Agents" icon={Bot} value={stat(agents, () => agents.data!.agents.length)} sub="Buyer and provider agents" />
        <Stat label="Payable" icon={HandCoins} value={stat(obligations, () => counts["payable"] ?? 0)} sub="Verified work awaiting settlement" />
        <Stat label="In settlement" icon={Landmark} value={stat(obligations, () => counts["reserved_for_settlement"] ?? 0)} sub={`${counts["settled"] ?? 0} settled`} />
        <Stat
          label="Integrity"
          icon={healthy ? ShieldCheck : ShieldAlert}
          tone={integrityKnown ? (healthy ? "success" : "danger") : undefined}
          value={integrityKnown ? (healthy ? "Healthy" : "Violation") : integrity.status === "error" ? "Unknown" : "…"}
          sub={integrityKnown ? (healthy ? "Ledger balanced, history intact" : "See the Integrity page") : "Checking…"}
        />
      </div>

      <div className="card-grid card-grid--wide">
        <ChartPanel
          title="Obligations by status"
          data={obByStatus.status === "ok" ? obByStatus.data.data : []}
          loading={obByStatus.status === "loading"}
          error={obByStatus.status === "error" ? obByStatus.error : undefined}
          series={[{ type: "pie", angleKey: "count", calloutLabelKey: "status", legendItemKey: "status" }]}
          onSegmentClick={(val) => setGridFilter(val)}
        />
        <ChartPanel
          title="Mission spend vs budget"
          data={missionSpend.status === "ok" ? missionSpend.data.data : []}
          loading={missionSpend.status === "loading"}
          error={missionSpend.status === "error" ? missionSpend.error : undefined}
          series={[
            { type: "bar", xKey: "title", yKey: "budget", yName: "Budget", fill: CHART_COLORS.primary },
            { type: "bar", xKey: "title", yKey: "reserved_budget", yName: "Reserved", fill: CHART_COLORS.violet },
          ]}
          onSegmentClick={(val) => setGridFilter(val)}
        />
        <ChartPanel
          title="Platform activity volume"
          data={eventVolume.status === "ok" ? eventVolume.data.data : []}
          loading={eventVolume.status === "loading"}
          error={eventVolume.status === "error" ? eventVolume.error : undefined}
          series={[{ type: "bar", xKey: "event_type", yKey: "count", yName: "Events", fill: CHART_COLORS.info }]}
          onSegmentClick={(val) => setGridFilter(val)}
        />
        <ChartPanel
          title="Reconciliation outcomes"
          data={captureRecon.status === "ok" ? captureRecon.data.data : []}
          loading={captureRecon.status === "loading"}
          error={captureRecon.status === "error" ? captureRecon.error : undefined}
          series={[{ type: "pie", angleKey: "count", calloutLabelKey: "verdict", legendItemKey: "verdict" }]}
        />
        <ChartPanel
          title="Policy denials by reason"
          data={
            policyDenials.status === "ok"
              ? policyDenials.data.data.map((d: { reason_codes: unknown; count: number }) => ({
                reason: Array.isArray(d.reason_codes) ? d.reason_codes.join(", ") : String(d.reason_codes),
                count: Number(d.count),
              }))
              : []
          }
          loading={policyDenials.status === "loading"}
          error={policyDenials.status === "error" ? policyDenials.error : undefined}
          series={[{ type: "bar", xKey: "reason", yKey: "count", yName: "Denials", fill: CHART_COLORS.warning }]}
        />
        <Card title="Where to next" icon={ClipboardList} description="Common admin tasks, one click away.">
          {missions.status === "ok" && missions.data.missions.length === 0 ? (
            <EmptyState title="No activity yet">Missions appear here once buyers start work.</EmptyState>
          ) : (
            <ul className="getting-started">
              <li><span><a href="#/deliveries">Review deliveries</a> to see why work was verified or rejected.</span></li>
              <li><span><a href="#/settlement">Approve settlement batches</a>. Only a signed-in human can approve a payment.</span></li>
              <li><span><a href="#/integrity">Check integrity</a> to confirm the ledger balances.</span></li>
            </ul>
          )}
          <p className="card-sub"><Icon icon={ShieldCheck} /> Every figure on this page is computed live from the system of record.</p>
        </Card>
      </div>

      <div style={{ marginTop: "var(--space-4)" }}>
        <GridPanel
          title="Missions & Spend Ledger"
          rows={missionRows}
          cols={MISSION_COLS}
          loading={missions.status === "loading"}
          error={missions.status === "error" ? missions.error : undefined}
          quickFilter={gridFilter}
          onQuickFilterChange={setGridFilter}
          getRowId={(p) => (p.data as { id: string }).id}
          badge={<StatusBadge label="real-time ledger" variant="live" />}
        />
      </div>
    </>
  );
};
