import React, { FormEvent, useEffect, useState } from 'react';
import type { ColDef } from 'ag-grid-community';
import {
  Store, Bot, Sparkles, CheckCircle2, ShieldCheck,
  CreditCard, Wallet, Search, ArrowRight, Layers,
  PlusCircle, RefreshCcw, FileText,
  Zap, Clock, ShieldAlert, Cpu
} from 'lucide-react';
import { useFetch } from '../hooks.js';
import { api, MissionQuote, ServiceListing } from '../api.js';
import { GridPanel } from '../components/GridPanel.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { Icon } from '../components/ui.js';
import { NegotiationPanel } from '../components/NegotiationPanel.js';
import { MissionResult } from '../components/MissionResult.js';
import { acceptErrorText, acceptLabel, acceptedNotice, useFundingMode } from '../fundingMode.js';
import { useLiveRefresh } from '../live.js';
import { MissionActions } from '../components/MissionActions.js';
import { ResultsArchive } from '../components/ResultsArchive.js';

const COLS: ColDef[] = [
  { field: 'id', headerName: 'ID', width: 90, valueFormatter: ({ value }) => value ? `${value.substring(0, 8)}…` : '' },
  { field: 'name', headerName: 'Service Name', flex: 2 },
  { field: 'category', headerName: 'Category', flex: 1,
    valueFormatter: ({ value }) => value ? String(value).replace(/_/g, ' ') : '' },
  { field: 'unit_price', headerName: 'Price', width: 130,
    valueFormatter: ({ value, data }) => `${Number(value).toFixed(2)} ${(data as Record<string, string>)['currency'] ?? 'USD'}`,
    cellStyle: { color: 'var(--color-primary)', fontWeight: '600' } },
  { field: 'currency', headerName: 'Currency', width: 90 },
  { field: 'unit', headerName: 'Unit', width: 100 },
  { field: 'status', headerName: 'Status', width: 120,
    cellRenderer: ({ value }: { value: string }) =>
      <StatusBadge label={value} variant={value === 'active' ? 'ok' : 'mocked'} /> },
];

export const ExchangeWorkspace: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'storefront' | 'missions' | 'grid'>('storefront');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  // Data fetching
  const servicesFetch = useFetch(() => api.services(), [refreshKey]);
  const missionsFetch = useFetch(() => api.missions(), [refreshKey]);
  const paypalStatusFetch = useFetch(() => api.paypalStatus(), [refreshKey]);

  // Mission quotes state
  const [quotes, setQuotes] = useState<Record<string, MissionQuote[]>>({});
  const [loadingQuotes, setLoadingQuotes] = useState(false);

  // Create mission state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedService, setSelectedService] = useState<ServiceListing | null>(null);
  const [missionTitle, setMissionTitle] = useState('');
  const [missionBrief, setMissionBrief] = useState('');
  const [missionBudget, setMissionBudget] = useState('1.00');
  const [busy, setBusy] = useState(false);
  const [liveTick, setLiveTick] = useState(0);
  const fundingMode = useFundingMode();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const services = servicesFetch.status === 'ok' ? servicesFetch.data.services : [];
  const missions = missionsFetch.status === 'ok' ? missionsFetch.data.missions : [];

  // Load quotes for all missions whenever missions list updates
  useEffect(() => {
    if (missions.length === 0) return;
    let current = true;
    if (Object.keys(quotes).length === 0) setLoadingQuotes(true);
    Promise.all(
      missions.map(async (m) => {
        try {
          const res = await api.missionQuotes(m.id);
          return [m.id, res.quotes] as const;
        } catch {
          return [m.id, []] as const;
        }
      })
    ).then((entries) => {
      if (current) {
        setQuotes(Object.fromEntries(entries));
        setLoadingQuotes(false);
      }
    });
    return () => { current = false; };
  }, [missions.length, refreshKey, liveTick]);

  const refreshAll = () => {
    setRefreshKey((k) => k + 1);
  };
  // Background refresh: missions and their quotes/agreements, without a loading flash.
  useLiveRefresh(() => {
    missionsFetch.reload();
    setLiveTick((t) => t + 1);
  });

  // Filtered services
  const categories = ['all', ...Array.from(new Set(services.map((s) => s.category)))];
  const filteredServices = services.filter((s) => {
    const matchesCategory = selectedCategory === 'all' || s.category === selectedCategory;
    const matchesSearch = !searchQuery ||
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.description.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  const handleStartMissionWithService = (service: ServiceListing) => {
    setSelectedService(service);
    setMissionTitle(`Run ${service.name} analysis`);
    setMissionBrief(`Execute ${service.name} with standard verification profile. Provider: ${service.provider_id.slice(0, 8)}`);
    setMissionBudget(Number(service.unit_price) > 0 ? service.unit_price : '1.00');
    setShowCreateModal(true);
  };

  const submitCreateMission = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const createdMission = await api.createMission({
        title: missionTitle.trim(),
        brief: missionBrief.trim(),
        budget: missionBudget,
        currency: 'USD',
      });

      // If a service was pre-selected, immediately request a quote
      if (selectedService) {
        await api.requestQuote({
          mission_id: createdMission.id,
          service_id: selectedService.id,
          quantity: 1,
        });
        setNotice(`Mission "${createdMission.title}" launched and quote requested from ${selectedService.name}!`);
      } else {
        setNotice(`Mission "${createdMission.title}" created successfully!`);
      }

      setShowCreateModal(false);
      setSelectedService(null);
      setMissionTitle('');
      setMissionBrief('');
      setActiveTab('missions');
      refreshAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create mission');
    } finally {
      setBusy(false);
    }
  };

  const handleAcceptQuote = async (quoteId: string, proposalId?: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const accepted = await api.acceptQuote(quoteId, proposalId);
      if (accepted.payment?.approve_url) {
        setNotice('Quote accepted! Redirecting to PayPal for checkout approval…');
        window.location.assign(accepted.payment.approve_url);
        return;
      }
      setNotice(fundingMode === 'wallet'
        ? acceptedNotice(fundingMode, accepted as any)
        : 'Quote accepted! Immutable agreement created and provider execution queued.');
      refreshAll();
    } catch (err: unknown) {
      const { text, topUp } = acceptErrorText(err);
      setError(topUp ? `${text} Open Wallet to add funds.` : text);
    } finally {
      setBusy(false);
    }
  };

  const handleRequestQuote = async (missionId: string, serviceId: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.requestQuote({ mission_id: missionId, service_id: serviceId, quantity: 1 });
      setNotice('Quote requested from service.');
      refreshAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not request quote');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="marketplace-container">
      {/* ── Modern Marketplace Hero Banner ─────────────────────────────────── */}
      <div className="marketplace-hero">
        <div className="marketplace-header-row">
          <div className="marketplace-title-group">
            <div className="tech-stack-row">
              <span className="tech-pill tech-paypal">
                <Icon icon={CreditCard} /> PayPal Commerce Native
              </span>
              <span className="tech-pill tech-ai">
                <Icon icon={Sparkles} /> Fireworks AI Powered
              </span>
              <span className="tech-pill tech-grid">
                <Icon icon={Layers} /> AG Grid Enterprise
              </span>
              <span className="tech-pill tech-cloud">
                <Icon icon={Zap} /> Vercel & Supabase Architecture
              </span>
            </div>
            <h2>Autonomous Agent & Mission Marketplace</h2>
            <p>
              Discover and hire specialized autonomous software agents. Benchmark quotes with Fireworks AI,
              settle seamlessly through PayPal Orders & Payouts, and guarantee delivery with deterministic code verification.
            </p>
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setSelectedService(null);
                setMissionTitle('');
                setMissionBrief('');
                setMissionBudget('1.00');
                setShowCreateModal(true);
              }}
            >
              <Icon icon={PlusCircle} /> Post New Mission
            </button>
            <button
              type="button"
              className="btn btn-secondary icon-button"
              aria-label="Refresh marketplace catalog and missions"
              onClick={refreshAll}
            >
              <Icon icon={RefreshCcw} />
            </button>
          </div>
        </div>

        {/* Live Marketplace Telemetry */}
        <div className="marketplace-stats-bar">
          <div className="marketplace-stat-item">
            <span className="marketplace-stat-num">{services.length}</span>
            <span className="marketplace-stat-label">Verified Services</span>
          </div>
          <div className="marketplace-stat-item">
            <span className="marketplace-stat-num">{missions.length}</span>
            <span className="marketplace-stat-label">Active Missions</span>
          </div>
          <div className="marketplace-stat-item">
            <span className="marketplace-stat-num">
              {paypalStatusFetch.status === 'ok' && paypalStatusFetch.data.configured ? (
                <span style={{ color: 'var(--color-success)' }}>Connected ({paypalStatusFetch.data.environment})</span>
              ) : (
                <span style={{ color: 'var(--color-warning)' }}>Ready</span>
              )}
            </span>
            <span className="marketplace-stat-label">PayPal Rail</span>
          </div>
          <div className="marketplace-stat-item">
            <span className="marketplace-stat-num" style={{ color: 'var(--color-primary)' }}>100% Grounded</span>
            <span className="marketplace-stat-label">Delivery Verification</span>
          </div>
        </div>
      </div>

      {/* ── Alerts & Notices ──────────────────────────────────────────────── */}
      {error && (
        <div className="notice notice-error" role="alert">
          <Icon icon={ShieldAlert} />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="notice notice-success" role="status">
          <Icon icon={CheckCircle2} />
          <span>{notice}</span>
        </div>
      )}

      {/* ── Marketplace View Navigation Tabs ──────────────────────────────── */}
      <div className="marketplace-toolbar">
        <div className="segmented-control" role="tablist" aria-label="Marketplace view selection">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'storefront'}
            className={`segmented-btn ${activeTab === 'storefront' ? 'active' : ''}`}
            onClick={() => setActiveTab('storefront')}
          >
            <Icon icon={Store} /> Storefront Catalog ({filteredServices.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'missions'}
            className={`segmented-btn ${activeTab === 'missions' ? 'active' : ''}`}
            onClick={() => setActiveTab('missions')}
          >
            <Icon icon={Bot} /> Missions & Execution ({missions.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'grid'}
            className={`segmented-btn ${activeTab === 'grid' ? 'active' : ''}`}
            onClick={() => setActiveTab('grid')}
          >
            <Icon icon={Layers} /> AG Grid Data Table
          </button>
        </div>

        {activeTab === 'storefront' && (
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="grid-search-wrap">
              <input
                type="text"
                aria-label="Search agent services"
                placeholder="Search services or capabilities…"
                className="grid-search-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <span style={{ position: 'absolute', right: 8, color: 'var(--text-muted)' }}>
                <Icon icon={Search} />
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── TAB 1: E-COMMERCE STOREFRONT VIEW ─────────────────────────────── */}
      {activeTab === 'storefront' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {/* Category Filter Pills */}
          <div className="category-filter-chips" role="group" aria-label="Filter by category">
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                className={`filter-chip ${selectedCategory === cat ? 'active' : ''}`}
                onClick={() => setSelectedCategory(cat)}
              >
                {cat.charAt(0).toUpperCase() + cat.slice(1).replace(/_/g, ' ')}
              </button>
            ))}
          </div>

          {servicesFetch.status === 'loading' ? (
            <div className="empty-state">
              <div className="spinner" />
              <h3>Loading autonomous agent catalog…</h3>
            </div>
          ) : filteredServices.length === 0 ? (
            <div className="empty-state">
              <Icon icon={Store} />
              <h3>No matching services found</h3>
              <p>Try clearing your search query or switch categories to view available agents.</p>
            </div>
          ) : (
            <div className="services-storefront-grid">
              {filteredServices.map((service) => (
                <article className="ecommerce-card" key={service.id}>
                  <div className="ecommerce-card-header">
                    <div className="ecommerce-avatar" aria-hidden="true">
                      {service.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="ecommerce-title-box">
                      <h3 className="ecommerce-service-title">{service.name}</h3>
                      <span className="category-chip" style={{ marginTop: 4 }}>
                        {service.category.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <StatusBadge label={service.status} variant={service.status === 'active' ? 'ok' : 'mocked'} />
                  </div>

                  <p className="ecommerce-service-desc">{service.description}</p>

                  <div className="ecommerce-card-meta">
                    <span className="badge badge-info" title="Deterministic Code Verification">
                      <Icon icon={ShieldCheck} /> Grounded Verified
                    </span>
                    <span className="badge badge-violet" title="Model Execution Mode">
                      <Icon icon={Cpu} /> Hosted Agent
                    </span>
                  </div>

                  <div className="ecommerce-card-footer">
                    <div className="ecommerce-price-display">
                      <span className="ecommerce-price-val">
                        ${Number(service.unit_price).toFixed(2)}
                      </span>
                      <span className="ecommerce-price-unit">
                        {service.currency} per {service.unit}
                      </span>
                    </div>

                    <button
                      type="button"
                      className="btn btn-primary small-button"
                      onClick={() => handleStartMissionWithService(service)}
                    >
                      Hire Agent <Icon icon={ArrowRight} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── TAB 2: MISSIONS LAUNCHPAD & COMPLETION HUB ────────────────────── */}
      {activeTab === 'missions' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>Active Missions & Deliveries</h3>
              <p className="card-sub">
                Track agent performance, negotiate quotes with Fireworks AI, approve PayPal payments, and inspect verified results.
              </p>
            </div>
            <span className="count-chip">{missions.length} Missions</span>
          </div>
          <ResultsArchive collapsible />

          {missionsFetch.status === 'loading' || loadingQuotes ? (
            <div className="empty-state">
              <div className="spinner" />
              <h3>Syncing mission ledger and agent quotes…</h3>
            </div>
          ) : missions.length === 0 ? (
            <div className="empty-state">
              <Icon icon={FileText} />
              <h3>No missions created yet</h3>
              <p>Hire an agent from the Storefront or click "Post New Mission" to get started.</p>
              <button
                type="button"
                className="btn btn-primary"
                style={{ marginTop: 'var(--space-2)' }}
                onClick={() => setShowCreateModal(true)}
              >
                <Icon icon={PlusCircle} /> Post First Mission
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              {missions.map((mission) => {
                const missionQuotes = quotes[mission.id] ?? [];
                const openQuotesCount = missionQuotes.filter((q) => q.status === 'offered' && !q.agreement_id).length;
                const activeAgreement = missionQuotes.find((q) => q.agreement_id);

                return (
                  <article className="mission-pipeline-card" key={mission.id}>
                    {/* Mission Header */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 4 }}>
                          <span className={`status-pill status-${mission.status}`}>
                            {mission.status.replace(/_/g, ' ')}
                          </span>
                          <span className="card-sub" style={{ fontSize: 'var(--text-xs)' }}>
                            ID: <code>{mission.id.slice(0, 8)}…</code>
                          </span>
                        </div>
                        <h4 style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>{mission.title}</h4>
                        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', marginTop: 4, maxWidth: '85ch' }}>
                          {mission.brief}
                        </p>
                      </div>

                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 'var(--text-lg)', fontWeight: 800, color: 'var(--color-primary)' }}>
                          ${Number(mission.budget).toFixed(2)} {mission.currency}
                        </div>
                        <span className="card-sub" style={{ fontSize: 'var(--text-xs)' }}>
                          ${Number(mission.reserved_budget).toFixed(2)} reserved
                        </span>
                      </div>
                    </div>
                    <MissionActions
                      mission={mission}
                      onChanged={refreshAll}
                      onAccept={(quoteId, proposalId) => void handleAcceptQuote(quoteId, proposalId)}
                    />

                    {/* Mission Lifecycle Stage Progress */}
                    <div className="pipeline-status-steps" aria-label="Mission progress stages">
                      <span className="pipeline-step-node completed">
                        <Icon icon={CheckCircle2} /> 1. Mission Created
                      </span>
                      <span className="pipeline-step-separator">➔</span>
                      <span className={`pipeline-step-node ${missionQuotes.length > 0 ? 'completed' : 'current'}`}>
                        {missionQuotes.length > 0 ? <Icon icon={CheckCircle2} /> : <Icon icon={Clock} />}
                        2. Quotes ({missionQuotes.length})
                      </span>
                      <span className="pipeline-step-separator">➔</span>
                      <span className={`pipeline-step-node ${activeAgreement ? 'completed' : openQuotesCount > 0 ? 'current' : ''}`}>
                        {activeAgreement ? <Icon icon={CheckCircle2} /> : <Icon icon={Sparkles} />}
                        3. AI Negotiate / Deal
                      </span>
                      <span className="pipeline-step-separator">➔</span>
                      <span className={`pipeline-step-node ${activeAgreement?.funding_status === 'funded' ? 'completed' : activeAgreement ? 'current' : ''}`}>
                        {activeAgreement?.funding_status === 'funded' ? <Icon icon={CheckCircle2} /> : <Icon icon={CreditCard} />}
                        4. PayPal Payment
                      </span>
                      <span className="pipeline-step-separator">➔</span>
                      <span className={`pipeline-step-node ${activeAgreement?.agreement_status === 'verified' ? 'completed' : activeAgreement?.agreement_status === 'rejected' ? 'rejected' : activeAgreement ? 'current' : ''}`}>
                        {activeAgreement?.agreement_status === 'verified' ? <Icon icon={CheckCircle2} /> : <Icon icon={ShieldCheck} />}
                        5. Grounded Verification
                      </span>
                    </div>

                    {/* Request Quote Dropdown if no agreement yet */}
                    {!activeAgreement && services.length > 0 && (
                      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', background: 'var(--surface-muted)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)' }}>
                        <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-secondary)' }}>
                          Request Quote from Marketplace:
                        </span>
                        <select
                          className="grid-search-input"
                          style={{ flex: 1, maxWidth: 300, background: 'var(--surface-solid)' }}
                          aria-label="Select service to quote"
                          defaultValue=""
                          onChange={(e) => {
                            if (e.target.value) {
                              void handleRequestQuote(mission.id, e.target.value);
                              e.target.value = '';
                            }
                          }}
                        >
                          <option value="" disabled>Select an agent service…</option>
                          {services.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name} · ${Number(s.unit_price).toFixed(2)} {s.currency}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* AI Negotiation Panel */}
                    <NegotiationPanel
                      missionId={mission.id}
                      openQuotes={openQuotesCount}
                      busy={busy}
                      onAccept={(quoteId, proposalId) => void handleAcceptQuote(quoteId, proposalId)}
                    />

                    {/* Quotes List & Actions */}
                    {missionQuotes.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
                        <h5 style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                          Quotes & Deals
                        </h5>
                        {missionQuotes.map((quote) => (
                          <div
                            key={quote.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 'var(--space-3)',
                              padding: 'var(--space-3) var(--space-4)',
                              background: 'var(--surface-solid)',
                              border: '1px solid var(--border-subtle)',
                              borderRadius: 'var(--radius-md)',
                              flexWrap: 'wrap',
                            }}
                          >
                            <div>
                              <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
                                {quote.service_name}
                              </div>
                              <div className="card-sub" style={{ fontSize: 'var(--text-xs)' }}>
                                Price: <strong>${Number(quote.price).toFixed(2)} {quote.currency}</strong> ·
                                Expires: {new Date(quote.expires_at).toLocaleDateString()}
                              </div>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                              {quote.agreement_id ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                                  <span className="badge badge-success">
                                    <Icon icon={CheckCircle2} /> Agreement #{quote.agreement_id.slice(0, 8)}
                                  </span>
                                  {quote.agreement_status && (
                                    <StatusBadge
                                      label={quote.agreement_status.replace(/_/g, ' ')}
                                      variant={quote.agreement_status === 'verified' ? 'ok' : quote.agreement_status === 'rejected' ? 'error' : 'info'}
                                    />
                                  )}
                                  {/* Completed Mission Result Inspector */}
                                  <MissionResult agreementId={quote.agreement_id} />
                                </div>
                              ) : (
                                <>
                                  <StatusBadge label={quote.status} variant={quote.status === 'offered' ? 'info' : 'mocked'} />
                                  {quote.status === 'offered' && (
                                    <button
                                      type="button"
                                      className="btn btn-primary small-button"
                                      disabled={busy}
                                      onClick={() => void handleAcceptQuote(quote.id)}
                                    >
                                      <Icon icon={fundingMode === 'wallet' ? Wallet : CreditCard} /> {acceptLabel(fundingMode)}
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
        </div>
      )}

      {/* ── TAB 3: ENTERPRISE AG GRID VIEW ───────────────────────────────── */}
      {activeTab === 'grid' && (
        <div style={{ height: 600, width: '100%' }}>
          <GridPanel
            title="Marketplace Service Registry"
            rows={services}
            cols={COLS}
            loading={servicesFetch.status === 'loading'}
            error={servicesFetch.status === 'error' ? servicesFetch.error : undefined}
            getRowId={(p) => (p.data as { id: string }).id}
            badge={<StatusBadge label="Enterprise AG Grid" variant="live" />}
          />
        </div>
      )}

      {/* ── MODAL: START MISSION / ORDER SERVICE ─────────────────────────── */}
      {showCreateModal && (
        <div className="scrim" data-open="true" style={{ display: 'grid', placeItems: 'center', padding: 'var(--space-4)' }}>
          <div
            className="glass-card"
            style={{ width: 'min(100%, 560px)', padding: 'var(--space-6)', background: 'var(--surface-solid)', borderRadius: 'var(--radius-lg)' }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-mission-title"
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
              <div>
                <p className="eyebrow">AUTONOMOUS MISSION CREATOR</p>
                <h3 id="modal-mission-title" style={{ fontSize: 'var(--text-xl)', fontWeight: 800 }}>
                  {selectedService ? `Order ${selectedService.name}` : 'Create New Mission'}
                </h3>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close mission modal"
                onClick={() => setShowCreateModal(false)}
              >
                ✕
              </button>
            </div>

            {selectedService && (
              <div style={{ padding: 'var(--space-3)', background: 'var(--color-primary-tint)', borderRadius: 'var(--radius-md)', marginBottom: 'var(--space-4)' }}>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--color-primary)' }}>
                  SELECTED SERVICE
                </div>
                <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
                  {selectedService.name} (${Number(selectedService.unit_price).toFixed(2)} {selectedService.currency} / {selectedService.unit})
                </div>
              </div>
            )}

            <form onSubmit={(e) => void submitCreateMission(e)} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <label>
                Mission Title
                <input
                  required
                  maxLength={160}
                  className="grid-search-input"
                  style={{ width: '100%', marginTop: 4 }}
                  value={missionTitle}
                  onChange={(e) => setMissionTitle(e.target.value)}
                  placeholder="e.g. Audit checkout security and payment gateway"
                />
              </label>

              <label>
                Scope & Acceptance Criteria
                <textarea
                  required
                  rows={4}
                  maxLength={4000}
                  style={{
                    width: '100%',
                    marginTop: 4,
                    padding: 'var(--space-3)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-subtle)',
                    fontFamily: 'var(--font-sans)',
                    fontSize: 'var(--text-sm)',
                  }}
                  value={missionBrief}
                  onChange={(e) => setMissionBrief(e.target.value)}
                  placeholder="Detail the target scope, rules, and acceptance criteria for the autonomous agent."
                />
              </label>

              <label>
                Budget Limit ($ USD)
                <input
                  required
                  inputMode="decimal"
                  pattern="^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$"
                  className="grid-search-input"
                  style={{ width: '100%', marginTop: 4 }}
                  value={missionBudget}
                  onChange={(e) => setMissionBudget(e.target.value)}
                />
              </label>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowCreateModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={busy}
                >
                  {busy ? 'Launching…' : selectedService ? 'Launch & Request Quote' : 'Create Mission'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
