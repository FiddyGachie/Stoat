import { FormEvent, useEffect, useState } from "react";
import {
  Activity, Bot, Cpu,
  Layers, LogOut, PlusCircle, RefreshCcw, ShieldCheck,
  TrendingUp, Zap
} from "lucide-react";
import { HelpLinks } from "../components/HelpLinks.js";
import { AgentRun, AgentTrace, api, Mission, Principal, ServiceListing } from "../api.js";
import { PerformanceDashboard } from "../components/PerformanceDashboard.js";
import { Icon } from "../components/ui.js";
import { StatusBadge } from "../components/StatusBadge.js";

const DEFAULT_REVIEW_PROFILE = {
  method: "grounded_verification",
  version: "1.0.0",
  allowed_rules: ["SEC-001", "SEC-002", "SEC-003", "BUG-001", "BUG-002", "PERF-001"],
  allowed_severities: ["low", "medium", "high", "critical"],
  max_findings: 10,
  min_coverage_pct: 100,
};

export function AgentPortal({
  principal,
  onSignOut,
}: {
  principal: Principal;
  onSignOut: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"services" | "runs" | "performance">("services");
  const [services, setServices] = useState<ServiceListing[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [selectedTrace, setSelectedTrace] = useState<AgentTrace | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("0.12");
  const [minPrice, setMinPrice] = useState("");
  const [unit, setUnit] = useState("review");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [serviceResponse, missionResponse, runResponse] = await Promise.all([
        api.services(),
        principal.role === "buyer" ? api.missions() : Promise.resolve({ missions: [] }),
        api.agentRuns(),
      ]);
      setServices(serviceResponse.services.filter((service) => service.provider_id === principal.id));
      setMissions(missionResponse.missions);
      setRuns(runResponse.runs);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load agent data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [principal.id]);

  async function publishService(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.publishService({
        name: name.trim(),
        description: description.trim(),
        category: "code_review",
        unit_price: price,
        ...(minPrice.trim() ? { min_price: minPrice.trim() } : {}),
        execution_mode: "hosted",
        currency: "USD",
        unit: unit.trim(),
        verification_profile: DEFAULT_REVIEW_PROFILE,
      });
      setName("");
      setDescription("");
      setNotice("Service published to your organization's registry.");
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Service could not be published.");
    } finally {
      setBusy(false);
    }
  }

  async function loadTrace(runId: string) {
    setError("");
    try {
      setSelectedTrace(await api.agentRunTrace(runId));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The run trace could not be loaded.");
    }
  }

  return (
    <div className="portal-shell">
      {/* ── Modern Agent Header ────────────────────────────────────────────── */}
      <header className="portal-header">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: 4 }}>
            <span className="badge badge-violet">
              <Icon icon={Bot} /> Autonomous Agent Principal
            </span>
            <span className="card-sub" style={{ fontSize: "var(--text-xs)" }}>
              Role: <strong>{principal.role}</strong> · ID: <code>{principal.id.slice(0, 8)}…</code>
            </span>
          </div>
          <h1 style={{ fontSize: "var(--text-2xl)", fontWeight: 800 }}>{principal.name}</h1>
          <p className="portal-subtitle">
            Autonomous agent workspace for {principal.tenant_name || "Enterprise"} · Scoped role execution
          </p>
        </div>

        <div className="portal-user" style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
          <HelpLinks />
          <button
            type="button"
            className="secondary-button"
            aria-label="Refresh agent workspace"
            onClick={() => void refresh()}
          >
            <Icon icon={RefreshCcw} />
          </button>
          <button type="button" className="secondary-button" onClick={onSignOut}>
            <LogOut className="icon" aria-hidden="true" /> Sign out
          </button>
        </div>
      </header>

      {/* Authority Guard Note */}
      <div className="agent-authority-note">
        <Icon icon={ShieldCheck} />
        <div>
          <strong>Scoped agent session:</strong> Actions are bounded by server-side policy and role permissions.
          All money movements require human approval and PayPal confirmation.
        </div>
      </div>

      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {notice && <p className="notice notice-success" role="status">{notice}</p>}

      {/* ── Navigation Tabs ────────────────────────────────────────────────── */}
      <div className="portal-nav-bar" role="tablist" aria-label="Agent workspace tabs">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "services"}
          className={`portal-nav-tab ${activeTab === "services" ? "active" : ""}`}
          onClick={() => setActiveTab("services")}
        >
          <Icon icon={Layers} /> {principal.role === "provider" ? `Services & Listings (${services.length})` : `Assigned Missions (${missions.length})`}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "runs"}
          className={`portal-nav-tab ${activeTab === "runs" ? "active" : ""}`}
          onClick={() => setActiveTab("runs")}
        >
          <Icon icon={Activity} /> Activity & Traces ({runs.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "performance"}
          className={`portal-nav-tab ${activeTab === "performance" ? "active" : ""}`}
          onClick={() => setActiveTab("performance")}
        >
          <Icon icon={TrendingUp} /> Performance & Earnings
        </button>
      </div>

      {/* ── TAB 1: SERVICES OR MISSIONS ────────────────────────────────────── */}
      {activeTab === "services" && (
        <>
          {principal.role === "provider" ? (
            <div className="portal-columns agent-service-columns">
              <section className="portal-card">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">SERVICE REGISTRATION</p>
                    <h2>Publish a service</h2>
                  </div>
                  <span className="live-label">HOSTED AGENT</span>
                </div>

                <form className="portal-form" onSubmit={(event) => void publishService(event)}>
                  <label>
                    Service name
                    <input
                      required
                      maxLength={120}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="e.g. Grounded Code Review"
                    />
                  </label>

                  <label>
                    Description
                    <textarea
                      required
                      maxLength={2000}
                      rows={3}
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder="Capabilities, supported languages, rules, and SLA."
                    />
                  </label>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)" }}>
                    <label>
                      Price · USD
                      <input
                        required
                        inputMode="decimal"
                        pattern="^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$"
                        value={price}
                        onChange={(event) => setPrice(event.target.value)}
                      />
                    </label>

                    <label>
                      Floor price · USD (optional)
                      <input
                        inputMode="decimal"
                        pattern="^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$"
                        placeholder="Negotiation minimum"
                        value={minPrice}
                        onChange={(event) => setMinPrice(event.target.value)}
                      />
                    </label>
                  </div>
                  <p className="field-note">Buyer agents may negotiate down to your floor price. Buyers never see it directly.</p>

                  <label>
                    Unit
                    <input
                      required
                      maxLength={40}
                      value={unit}
                      onChange={(event) => setUnit(event.target.value)}
                    />
                  </label>

                  <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", marginTop: 4 }}>
                    <span className="badge badge-info">
                      <Icon icon={ShieldCheck} /> 100% Grounded Verification Required
                    </span>
                  </div>

                  <button type="submit" className="primary-button" disabled={busy}>
                    <Icon icon={PlusCircle} /> {busy ? "Publishing…" : "Publish Service"}
                  </button>
                </form>
              </section>

              <section className="portal-card">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">CATALOG</p>
                    <h2>Published services</h2>
                  </div>
                  <span className="count-chip">{services.length} Active</span>
                </div>

                {loading ? (
                  <p className="muted-copy">Loading catalog…</p>
                ) : services.length === 0 ? (
                  <div className="empty-state compact">
                    <Icon icon={Cpu} />
                    <h3>No published services</h3>
                    <p>Publish a service on the left to offer capabilities to buyer agents.</p>
                  </div>
                ) : (
                  <div className="service-list">
                    {services.map((service) => (
                      <article className="service-row" key={service.id}>
                        <div className="service-icon" aria-hidden="true">
                          <Icon icon={Zap} />
                        </div>
                        <div className="service-info">
                          <h3>{service.name}</h3>
                          <p>{service.description}</p>
                          <span className="category-chip">{service.status}</span>
                        </div>
                        <strong className="service-price">
                          ${Number(service.unit_price).toFixed(2)}{" "}
                          <small>{service.currency} / {service.unit}</small>
                        </strong>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>
          ) : (
            <section className="portal-card">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">BUYER AGENT</p>
                  <h2>Assigned missions</h2>
                </div>
                <span className="count-chip">{missions.length} Missions</span>
              </div>
              {loading ? (
                <p className="muted-copy">Loading assignments…</p>
              ) : missions.length === 0 ? (
                <div className="empty-state compact">
                  <h3>No assigned missions</h3>
                  <p>Missions assigned to this buyer agent will appear here.</p>
                </div>
              ) : (
                <div className="mission-list">
                  {missions.map((mission) => (
                    <article className="mission-item" key={mission.id}>
                      <div className="mission-summary">
                        <div>
                          <h3>{mission.title}</h3>
                          <p>{mission.brief}</p>
                        </div>
                        <span className={`status-pill status-${mission.status}`}>{mission.status.replace(/_/g, " ")}</span>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}

      {/* ── TAB 2: AGENT RUNS & TRACES ─────────────────────────────────────── */}
      {activeTab === "runs" && (
        <section className="portal-card agent-traces-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">EXECUTION AUDIT</p>
              <h2>Agent run traces</h2>
            </div>
            <span className="field-note">Immutable execution steps and model costs</span>
          </div>

          {loading ? (
            <p className="muted-copy">Loading agent runs…</p>
          ) : runs.length === 0 ? (
            <div className="empty-state compact">
              <Icon icon={Activity} />
              <h3>No runs recorded</h3>
              <p>Traces appear when this agent executes autonomous tasks.</p>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: selectedTrace ? "1fr 1fr" : "1fr", gap: "var(--space-4)" }}>
              <div className="agent-run-list" style={{ maxHeight: 500, overflowY: "auto" }}>
                {runs.map((run) => (
                  <button
                    type="button"
                    key={run.id}
                    className={`agent-run-row ${selectedTrace?.run.id === run.id ? "active" : ""}`}
                    onClick={() => void loadTrace(run.id)}
                  >
                    <span>
                      <strong style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <StatusBadge
                          label={run.status}
                          variant={run.status === "completed" ? "ok" : run.status === "running" ? "live" : "info"}
                        />
                        {run.role}
                      </strong>
                      <small>{run.started_at ? new Date(run.started_at).toLocaleString() : run.id}</small>
                    </span>
                    <span style={{ textAlign: "right" }}>
                      <strong>{run.steps_count} steps</strong>
                      {run.cost_usd && (
                        <small style={{ color: "var(--color-primary)", display: "block" }}>
                          ${Number(run.cost_usd).toFixed(4)} USD
                        </small>
                      )}
                    </span>
                  </button>
                ))}
              </div>

              {selectedTrace && (
                <div className="trace-detail" style={{ background: "var(--surface-solid)", padding: "var(--space-4)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle)" }}>
                  <div className="section-heading" style={{ marginBottom: "var(--space-3)" }}>
                    <div>
                      <p className="eyebrow">STEP-BY-STEP INSPECTOR</p>
                      <h3>Run {selectedTrace.run.id.slice(0, 12)}…</h3>
                    </div>
                    {selectedTrace.run.terminal_reason?.includes("replay") && (
                      <span className="role-pill">Replayed trace</span>
                    )}
                  </div>

                  {selectedTrace.steps.length === 0 ? (
                    <p className="muted-copy">No discrete steps recorded.</p>
                  ) : (
                    <ol style={{ paddingLeft: "var(--space-4)", display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                      {selectedTrace.steps.map((step) => (
                        <li key={step.step_number} style={{ fontSize: "var(--text-xs)" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <strong>Tool: {step.tool_name}</strong>
                            <StatusBadge
                              label={step.authorization_result}
                              variant={step.authorization_result === "authorized" ? "ok" : "warning"}
                            />
                          </div>
                          {step.error_code && <span className="form-error">{step.error_code}</span>}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* ── TAB 3: PERFORMANCE DASHBOARD ──────────────────────────────────── */}
      {activeTab === "performance" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <PerformanceDashboard mode="self" />
        </div>
      )}
    </div>
  );
}
