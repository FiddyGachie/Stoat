import { FormEvent, useEffect, useState } from "react";
import {
  Bot, CheckCircle2, ChevronRight, Copy, CreditCard,
  FileText, LayoutGrid, LogOut, PlusCircle, RefreshCcw,
  Sparkles, Store, Wallet, Zap
} from "lucide-react";
import { HelpLinks } from "../components/HelpLinks.js";
import { NotificationsBell } from "../components/NotificationsBell.js";
import { PaymentsDue } from "../components/PaymentsDue.js";
import { NegotiationPanel } from "../components/NegotiationPanel.js";
import { MissionResult } from "../components/MissionResult.js";
import { api, AgentSummary, Mission, MissionQuote, Principal, ServiceListing } from "../api.js";
import { PerformanceDashboard } from "../components/PerformanceDashboard.js";
import { Icon } from "../components/ui.js";
import { acceptErrorText, acceptLabel, acceptedNotice, useFundingMode } from "../fundingMode.js";
import { useLiveRefresh } from "../live.js";
import { MissionActions } from "../components/MissionActions.js";
import { ResultsArchive } from "../components/ResultsArchive.js";

type QuoteHistory = Record<string, MissionQuote[]>;

export function BuyerPortal({
  principal,
  onSignOut,
}: {
  principal: Principal;
  onSignOut: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"missions" | "spending" | "agents">("missions");
  const [services, setServices] = useState<ServiceListing[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [quotes, setQuotes] = useState<QuoteHistory>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [missionTitle, setMissionTitle] = useState("");
  const [missionBrief, setMissionBrief] = useState("");
  const [missionBudget, setMissionBudget] = useState("1.00");
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const [busy, setBusy] = useState(false);
  const fundingMode = useFundingMode();
  const [agentName, setAgentName] = useState("");
  const [agentRole, setAgentRole] = useState<"buyer" | "provider">("provider");
  const [newAgentSecret, setNewAgentSecret] = useState("");
  const [newAgentId, setNewAgentId] = useState("");

  async function refresh(silent = false) {
    if (!silent) {
      setLoading(true);
      setError("");
    }
    try {
      const [serviceResponse, missionResponse, agentResponse] = await Promise.all([
        api.services(),
        api.missions(),
        api.agents(),
      ]);
      const quoteResponses = await Promise.all(
        missionResponse.missions.map(async (mission) => [
          mission.id,
          (await api.missionQuotes(mission.id)).quotes,
        ] as const),
      );
      setServices(serviceResponse.services);
      setMissions(missionResponse.missions);
      setAgents(agentResponse.agents);
      setQuotes(Object.fromEntries(quoteResponses));
    } catch (requestError) {
      if (!silent) setError(requestError instanceof Error ? requestError.message : "Could not load organization data.");
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  // Keep missions current: delivery, verification, wallet charge and mission completion all
  // show up without a reload (every 15 s while visible, and at once on a new notification).
  useLiveRefresh(() => { void refresh(true); });

  async function createMission(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const created = await api.createMission({
        title: missionTitle.trim(),
        brief: missionBrief.trim(),
        budget: missionBudget,
        currency: "USD",
      });

      if (selectedServiceId) {
        await api.requestQuote({
          mission_id: created.id,
          service_id: selectedServiceId,
          quantity: 1,
        });
        setNotice("Mission created and quote requested from selected agent service.");
      } else {
        setNotice("Mission created. You can request quotes from available services.");
      }

      setMissionTitle("");
      setMissionBrief("");
      setSelectedServiceId("");
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Mission could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function requestQuote(event: FormEvent<HTMLFormElement>, mission: Mission) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const serviceId = String(formData.get("service_id") ?? "");
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.requestQuote({
        mission_id: mission.id,
        service_id: serviceId,
        quantity: 1,
      });
      setNotice("Quote requested and saved to this mission.");
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Quote could not be requested.");
    } finally {
      setBusy(false);
    }
  }

  async function acceptQuote(quoteId: string, proposalId?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const accepted = await api.acceptQuote(quoteId, proposalId);
      if (accepted.payment?.approve_url) {
        setNotice("Quote accepted. Redirecting to PayPal for checkout approval…");
        window.location.assign(accepted.payment.approve_url);
        return;
      }
      setNotice(acceptedNotice(fundingMode, accepted as any));
      await refresh();
    } catch (requestError) {
      const { text, topUp } = acceptErrorText(requestError);
      setError(topUp ? `${text} Open Wallet to add funds.` : text);
    } finally {
      setBusy(false);
    }
  }

  async function provisionProvider(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    setNewAgentSecret("");
    try {
      const result = await api.createAgent({ name: agentName.trim(), role: agentRole });
      setNewAgentId(result.agent.id);
      setNewAgentSecret(result.secret);
      setAgentName("");
      setNotice("Agent provisioned successfully. Copy secret credential now.");
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Agent could not be provisioned.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="portal-shell">
      {/* ── Modern Buyer Header ────────────────────────────────────────────── */}
      <header className="portal-header">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: 4 }}>
            <span className="badge badge-info">
              <Icon icon={Sparkles} /> Autonomous Buyer Console
            </span>
            <span className="card-sub" style={{ fontSize: "var(--text-xs)" }}>
              Organization: <strong>{principal.tenant_name || "Enterprise"}</strong>
            </span>
          </div>
          <h1 style={{ fontSize: "var(--text-2xl)", fontWeight: 800 }}>{principal.name}</h1>
          <p className="portal-subtitle">
            Create missions, request autonomous agent quotes, authorize PayPal payments, and track verified work.
          </p>
        </div>

        <div className="portal-user" style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" }}>
          <HelpLinks />
          <NotificationsBell />
          <button
            type="button"
            className="secondary-button"
            aria-label="Refresh buyer portal"
            onClick={() => void refresh()}
          >
            <Icon icon={RefreshCcw} />
          </button>
          <a href="#/payments" className="secondary-button" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <LayoutGrid className="icon" aria-hidden="true" style={{ width: 14, height: 14 }} />
            Payments
          </a>
          <a href="#/wallet" className="secondary-button" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Wallet className="icon" aria-hidden="true" style={{ width: 14, height: 14 }} />
            Wallet
          </a>
          <a href="#/payment-journey" className="secondary-button" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Wallet className="icon" aria-hidden="true" style={{ width: 14, height: 14 }} />
            Budgets
          </a>
          <button type="button" className="secondary-button" onClick={onSignOut}>
            <LogOut className="icon" aria-hidden="true" /> Sign out
          </button>
        </div>
      </header>

      {/* ── Feedback Notices ──────────────────────────────────────────────── */}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {notice && <p className="notice notice-success" role="status">{notice}</p>}

      {/* ── Segmented Navigation Tabs ──────────────────────────────────────── */}
      <div className="portal-nav-bar" role="tablist" aria-label="Buyer dashboard views">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "missions"}
          className={`portal-nav-tab ${activeTab === "missions" ? "active" : ""}`}
          onClick={() => setActiveTab("missions")}
        >
          <Icon icon={Store} /> Missions & Marketplace ({missions.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "spending"}
          className={`portal-nav-tab ${activeTab === "spending" ? "active" : ""}`}
          onClick={() => setActiveTab("spending")}
        >
          <Icon icon={Wallet} /> Spending & Financials
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "agents"}
          className={`portal-nav-tab ${activeTab === "agents" ? "active" : ""}`}
          onClick={() => setActiveTab("agents")}
        >
          <Icon icon={Bot} /> Autonomous Team ({agents.length})
        </button>
      </div>

      {/* ── TAB 1: MISSIONS & MARKETPLACE ──────────────────────────────────── */}
      {activeTab === "missions" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
          <div className="portal-columns">
            {/* Mission Launcher */}
            <section className="portal-card mission-create">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">MISSION LAUNCHER</p>
                  <h2>Start a mission</h2>
                </div>
                <span className="live-label">SAVED TO API</span>
              </div>

              <form className="portal-form" onSubmit={(e) => void createMission(e)}>
                <label>
                  Mission title
                  <input
                    maxLength={160}
                    required
                    value={missionTitle}
                    onChange={(event) => setMissionTitle(event.target.value)}
                    placeholder="e.g. Security audit for checkout service"
                  />
                </label>

                <label>
                  What needs to be done?
                  <textarea
                    maxLength={4000}
                    required
                    rows={3}
                    value={missionBrief}
                    onChange={(event) => setMissionBrief(event.target.value)}
                    placeholder="Describe the requested work and acceptance criteria for the agent."
                  />
                </label>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)" }}>
                  <label>
                    Budget <span className="field-note">USD</span>
                    <input
                      inputMode="decimal"
                      pattern="^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$"
                      required
                      value={missionBudget}
                      onChange={(event) => setMissionBudget(event.target.value)}
                    />
                  </label>

                  <label>
                    Service (Optional)
                    <select
                      value={selectedServiceId}
                      onChange={(e) => setSelectedServiceId(e.target.value)}
                    >
                      <option value="">Select a service…</option>
                      {services.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} (${Number(s.unit_price).toFixed(2)})
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <button type="submit" className="primary-button" disabled={busy}>
                  <Icon icon={PlusCircle} /> {busy ? "Launching…" : "Create & Request Quote"}
                </button>
              </form>
            </section>

            {/* Available Services Showcase */}
            <section className="portal-card marketplace-card">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">AGENT CATALOG</p>
                  <h2>Available services</h2>
                </div>
                <span className="count-chip">{services.length} services</span>
              </div>

              {loading ? (
                <p className="muted-copy">Loading organization services…</p>
              ) : services.length === 0 ? (
                <div className="empty-state">
                  <Icon icon={Store} />
                  <h3>No services registered yet</h3>
                  <p>Provision a provider agent below to register code review or security services.</p>
                </div>
              ) : (
                <div className="service-list" style={{ maxHeight: 380, overflowY: "auto" }}>
                  {services.map((service) => (
                    <article className="service-row" key={service.id}>
                      <div className="service-icon" aria-hidden="true">
                        <Icon icon={Zap} />
                      </div>
                      <div className="service-info">
                        <h3>{service.name}</h3>
                        <p>{service.description}</p>
                        <span className="category-chip">{service.category.replace(/_/g, " ")}</span>
                      </div>
                      <div style={{ textAlign: "right", display: "flex", flexDirection: "column", gap: 4 }}>
                        <strong className="service-price">
                          ${Number(service.unit_price).toFixed(2)}{" "}
                          <small>{service.currency}/{service.unit}</small>
                        </strong>
                        <button
                          type="button"
                          className="btn btn-secondary small-button"
                          onClick={() => {
                            setMissionTitle(`Run ${service.name}`);
                            setMissionBrief(`Deliver ${service.name} for current scope.`);
                            setMissionBudget(Number(service.unit_price) > 0 ? service.unit_price : "1.00");
                            setSelectedServiceId(service.id);
                          }}
                        >
                          Use service <Icon icon={ChevronRight} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>

          {/* Active Missions List */}
          <section className="portal-card missions-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">ACTIVE DEALS & MISSIONS</p>
                <h2>Your missions pipeline</h2>
              </div>
              <span className="count-chip">{missions.length} Total</span>
            </div>

            {loading ? (
              <p className="muted-copy">Loading missions…</p>
            ) : missions.length === 0 ? (
              <div className="empty-state compact">
                <Icon icon={FileText} />
                <h3>No missions active yet</h3>
                <p>Create a mission above to receive quotes and start autonomous delivery.</p>
              </div>
            ) : (
              <div className="mission-list">
                {missions.map((mission) => {
                  const missionQuotes = quotes[mission.id] ?? [];
                  const openCount = missionQuotes.filter((q) => q.status === "offered" && !q.agreement_id).length;

                  return (
                    <article className="mission-item" key={mission.id}>
                      <div className="mission-summary">
                        <div>
                          <span className={`status-pill status-${mission.status}`}>
                            {mission.status.replace(/_/g, " ")}
                          </span>
                          <h3>{mission.title}</h3>
                          <p>{mission.brief}</p>
                        </div>
                        <div className="mission-budget">
                          <strong>${Number(mission.budget).toFixed(2)} {mission.currency}</strong>
                          <span>budget · ${Number(mission.reserved_budget).toFixed(2)} reserved</span>
                        </div>
                      </div>
                      <MissionActions
                        mission={mission}
                        onChanged={() => void refresh(true)}
                        onAccept={(quoteId, proposalId) => void acceptQuote(quoteId, proposalId)}
                      />

                      {services.length > 0 && (
                        <form className="request-quote-form" onSubmit={(event) => void requestQuote(event, mission)}>
                          <label>
                            Request a quote
                            <select name="service_id" required defaultValue="">
                              <option value="" disabled>Select a service to quote</option>
                              {services.map((service) => (
                                <option value={service.id} key={service.id}>
                                  {service.name} · ${Number(service.unit_price).toFixed(2)} {service.currency}/{service.unit}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button className="secondary-button" type="submit" disabled={busy}>Get quote</button>
                        </form>
                      )}

                      {/* Fireworks AI Negotiation Panel */}
                      <NegotiationPanel
                        missionId={mission.id}
                        openQuotes={openCount}
                        busy={busy}
                        onAccept={(quoteId, proposalId) => void acceptQuote(quoteId, proposalId)}
                      />

                      {/* Quotes & Agreements */}
                      {missionQuotes.length > 0 && (
                        <div className="quote-list">
                          {missionQuotes.map((quote) => (
                            <div className="quote-row" key={quote.id}>
                              <div>
                                <strong>{quote.service_name}</strong>
                                <span>
                                  ${Number(quote.price).toFixed(2)} {quote.currency} · expires {new Date(quote.expires_at).toLocaleDateString()}
                                </span>
                              </div>
                              <div className="quote-actions">
                                {quote.agreement_id ? (
                                  <>
                                    <span className="status-pill status-accepted" title="Agreement status">
                                      {nextStep(quote.agreement_status, quote.funding_status)}
                                    </span>
                                    {quote.agreement_status && quote.agreement_status !== "accepted" && (
                                      <MissionResult agreementId={quote.agreement_id} />
                                    )}
                                  </>
                                ) : (
                                  <>
                                    <span className={`status-pill status-${quote.status}`}>{quote.status}</span>
                                    {quote.status === "offered" && (
                                      <button
                                        type="button"
                                        className="primary-button small-button"
                                        disabled={busy}
                                        onClick={() => void acceptQuote(quote.id)}
                                      >
                                        <Icon icon={fundingMode === "wallet" ? Wallet : CreditCard} /> {acceptLabel(fundingMode)}
                                      </button>
                                    )}
                                  </>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
          <ResultsArchive />
        </div>
      )}

      {/* ── TAB 2: SPENDING & FINANCIALS ──────────────────────────────────── */}
      {activeTab === "spending" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <PaymentsDue />
          <PerformanceDashboard mode="owner" onChanged={() => void refresh()} />
        </div>
      )}

      {/* ── TAB 3: AGENTS TEAM ────────────────────────────────────────────── */}
      {activeTab === "agents" && (
        <section className="portal-card agents-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">AUTONOMOUS ROSTER</p>
              <h2>Agents</h2>
            </div>
            <span className="count-chip">{agents.length} active records</span>
          </div>

          <div className="agents-layout">
            <div className="agent-roster">
              {agents.map((agent) => (
                <div className="agent-row" key={agent.id}>
                  <div className="agent-avatar">{agent.role === "buyer" ? "B" : "P"}</div>
                  <div>
                    <strong>{agent.name}</strong>
                    <span>{agent.role} · {agent.status}</span>
                  </div>
                  <code>{agent.id.slice(0, 8)}</code>
                </div>
              ))}
            </div>

            {principal.role === "supervisor" && (
              <form className="portal-form provision-form" onSubmit={(event) => void provisionProvider(event)}>
                <h3>Provision an agent</h3>
                <p className="muted-copy">The agent ID and secret are shown once. Share them securely with the operator.</p>

                <label>
                  Agent name
                  <input
                    required
                    maxLength={120}
                    value={agentName}
                    onChange={(event) => setAgentName(event.target.value)}
                    placeholder="e.g. Code review provider"
                  />
                </label>

                <label>
                  Role
                  <select
                    value={agentRole}
                    onChange={(event) => setAgentRole(event.target.value === "buyer" ? "buyer" : "provider")}
                  >
                    <option value="provider">Provider</option>
                    <option value="buyer">Buyer</option>
                  </select>
                </label>

                <button type="submit" className="secondary-button" disabled={busy}>
                  <Icon icon={PlusCircle} /> Create agent
                </button>

                {newAgentSecret && (
                  <div className="credential-reveal" role="status">
                    <strong style={{ color: "var(--color-success)" }}>
                      <Icon icon={CheckCircle2} /> Copy these credentials now
                    </strong>
                    <label>
                      Agent ID
                      <input readOnly value={newAgentId} />
                    </label>
                    <label>
                      One-time secret
                      <input readOnly type="password" value={newAgentSecret} />
                    </label>
                    <button
                      type="button"
                      className="text-button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(`Agent ID: ${newAgentId}\nSecret: ${newAgentSecret}`);
                          setNotice("Agent credentials copied to clipboard.");
                        } catch {
                          setError("Clipboard access denied. Copy credentials manually.");
                        }
                      }}
                    >
                      <Icon icon={Copy} /> Copy credentials
                    </button>
                  </div>
                )}
              </form>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/** One plain-language line for an agreement: where it is and what happens next. */
function nextStep(status?: string | null, funding?: string | null): string {
  switch (status ?? "accepted") {
    case "accepted":
      if (funding === "awaiting_payment" || funding === "unfunded") return "Agreed · approve PayPal payment to start work";
      return "Agreed · provider is executing";
    case "revision_requested":
      return "Revision requested · provider reworking";
    case "verified":
      return "Verified · view delivered results";
    case "rejected":
      return "Delivery rejected · nothing owed";
    case "needs_review":
      return "Needs operator review";
    default:
      return `Agreement · ${status}`;
  }
}
