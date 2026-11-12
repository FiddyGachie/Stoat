import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, Bot, BookOpen, ExternalLink, FileSignature, Landmark, LayoutDashboard, LogOut,
  Bell, Menu, PackageCheck, Receipt, Scale, ShieldCheck, Store, TrendingUp, X, type LucideIcon, ArrowLeftRight, Wallet, LayoutGrid
} from "lucide-react";
import { EconomyWorkspace } from "./workspaces/EconomyWorkspace.js";
import { AgentsWorkspace } from "./workspaces/AgentsWorkspace.js";
import { ExchangeWorkspace } from "./workspaces/ExchangeWorkspace.js";
import { QuotesAgreementsWorkspace } from "./workspaces/QuotesAgreementsWorkspace.js";
import { EventStreamWorkspace } from "./workspaces/EventStreamWorkspace.js";
import { DeliveriesWorkspace } from "./workspaces/DeliveriesWorkspace.js";
import { ObligationsWorkspace } from "./workspaces/ObligationsWorkspace.js";
import { SettlementWorkspace } from "./workspaces/SettlementWorkspace.js";
import { MoneyFlowWorkspace } from "./workspaces/MoneyFlowWorkspace.js";
import { PolicyWorkspace } from "./workspaces/PolicyWorkspace.js";
import { IntegrityWorkspace } from "./workspaces/IntegrityWorkspace.js";
import { PaymentJourneyWorkspace } from "./workspaces/PaymentJourneyWorkspace.js";
import { PaymentsDashboard } from "./workspaces/PaymentsDashboard.js";
import { AgentPortal } from "./workspaces/AgentPortal.js";
import { BuyerPortal } from "./workspaces/BuyerPortal.js";
import { NotificationsBell } from "./components/NotificationsBell.js";
import { WalletWorkspace } from "./workspaces/WalletWorkspace.js";
import { BusinessAccountWorkspace } from "./workspaces/BusinessAccountWorkspace.js";
import { NotificationsWorkspace } from "./workspaces/NotificationsWorkspace.js";
import { PerformanceDashboard } from "./components/PerformanceDashboard.js";
import { useFetch } from "./hooks.js";
import { api, Principal, setToken, SESSION_EXPIRED_EVENT } from "./api.js";
import { StatusBadge } from "./components/StatusBadge.js";
import { AuthScreen } from "./components/AuthScreen.js";
import { BrandLogo, Icon, Loading, PageHeader } from "./components/ui.js";
import { PaymentsDue } from "./components/PaymentsDue.js";

export type WorkspaceId =
  | "economy" | "performance" | "exchange" | "quotes" | "agents" | "deliveries"
  | "obligations" | "settlement" | "payments" | "moneyflow" | "payment-journey" | "events" | "policy" | "integrity"
  | "wallet" | "business-account" | "notifications";

/** `roles`, when set, limits who sees the item and who can open its route. */
interface NavItem { id: WorkspaceId; label: string; icon: LucideIcon; description: string; roles?: readonly string[] }

/** Roles that may open the platform-wide Business account (R15.17). */
const ADMIN_ROLES = ["operator", "supervisor"] as const;
interface NavGroup { label: string; items: NavItem[] }

/** Single source of truth for navigation, page titles and descriptions. */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { id: "economy", label: "Economy", icon: LayoutDashboard, description: "Missions, obligations and platform health at a glance." },
      { id: "performance", label: "Performance", icon: TrendingUp, description: "How each agent is delivering, earning and spending." },
    ],
  },
  {
    label: "Marketplace",
    items: [
      { id: "exchange", label: "Exchange", icon: Store, description: "Services on offer, their prices and how each is verified." },
      { id: "quotes", label: "Quotes & Agreements", icon: FileSignature, description: "Missions, quotes and the immutable agreements they become." },
      { id: "agents", label: "Agents", icon: Bot, description: "Every agent, its status and a full trace of its runs." },
    ],
  },
  {
    label: "Delivery & money",
    items: [
      { id: "deliveries", label: "Deliveries", icon: PackageCheck, description: "Submitted work and the checks that verified or rejected it." },
      { id: "obligations", label: "Obligations", icon: Receipt, description: "Amounts owed for verified work and their status." },
      { id: "moneyflow", label: "Money Flow", icon: ArrowLeftRight, description: "Both PayPal legs of every deal: buyer collection and provider payout, side by side." },
      { id: "settlement", label: "Settlement", icon: Landmark, description: "Batches, human approval, payment and reconciliation." },
      { id: "wallet", label: "Wallet", icon: Wallet, description: "Your balance, deposits and mission budgets, funded through PayPal." },
      { id: "business-account", label: "Business account", icon: Landmark, description: "Platform-wide PayPal funds, wallet balances, refunds and reconciliation.", roles: ADMIN_ROLES },
    ],
  },
  {
    label: "Trust & audit",
    items: [
      { id: "events", label: "Event Stream", icon: Activity, description: "The append-only record of everything that happened." },
      { id: "policy", label: "Policy & Trust", icon: Scale, description: "Policy decisions, holds and approvals." },
      { id: "integrity", label: "Integrity", icon: ShieldCheck, description: "Live proof that the ledger balances and history is intact." },
    ],
  },
];

const ALL_ITEMS = NAV_GROUPS.flatMap((g) => g.items);
const EXTRA_ITEMS: NavItem[] = [
  { id: "payments", label: "Payments Dashboard", icon: LayoutGrid, description: "Set mission spend, view analytics, connect PayPal, top up, request refunds — AI-assisted." },
  { id: "payment-journey", label: "Payment Journey", icon: Wallet, description: "Pre-approve spending budgets, hold funds via PayPal, track micro-debits, and decide on remainders." },
  { id: "notifications", label: "Notifications", icon: Bell, description: "Wallet and mission updates addressed to you." },
];
/** Can this principal see and open the item? Items without `roles` are open to every signed-in person. */
const canOpen = (item: NavItem, role: string | undefined): boolean =>
  !item.roles || (role !== undefined && item.roles.includes(role));
const ROUTABLE_ITEMS = [...ALL_ITEMS, ...EXTRA_ITEMS];
const DEFAULT_ID: WorkspaceId = "economy";
const isWorkspaceId = (value: string): value is WorkspaceId => ROUTABLE_ITEMS.some((i) => i.id === value);

/** The model mode the server reports. Replay means stored real answers, never a live call. */
function LlmBadge() {
  const health = useFetch(() => api.health());
  if (health.status !== "ok") return null;
  const { mode, key_configured } = health.data.llm;
  if (mode !== "replay" && !key_configured) return <StatusBadge label="model not configured" variant="warning" />;
  if (mode === "replay") return <StatusBadge label="replay mode" variant="replayed" />;
  return <StatusBadge label={mode === "record" ? "live model (recorded)" : "live model"} variant="live" />;
}
/** Shows which PayPal environment the API is really talking to. No guesswork, no build flags. */
function PayPalBadge() {
  const status = useFetch(() => api.paypalStatus());
  if (status.status !== "ok") return null;
  const s = status.data;
  if (!s.configured) return <StatusBadge label="paypal not configured" variant="warning" />;
  return <StatusBadge label={`paypal ${s.environment}`} variant={s.environment === "live" ? "live" : "info"} />;
}

const WORKSPACES: Record<WorkspaceId, React.ReactNode> = {
  economy: <EconomyWorkspace />,
  performance: <PerformanceDashboard mode="operator" />,
  exchange: <ExchangeWorkspace />,
  quotes: <QuotesAgreementsWorkspace />,
  agents: <AgentsWorkspace />,
  deliveries: <DeliveriesWorkspace />,
  obligations: <ObligationsWorkspace />,
  moneyflow: <MoneyFlowWorkspace />,
  settlement: <SettlementWorkspace />,
  events: <EventStreamWorkspace />,
  policy: <PolicyWorkspace />,
  integrity: <IntegrityWorkspace />,
  payments: <PaymentsDashboard />,
  "payment-journey": <PaymentJourneyWorkspace />,
  wallet: <WalletWorkspace />,
  "business-account": <BusinessAccountWorkspace />,
  notifications: <NotificationsWorkspace />,
};

/** Hash routing: every screen has a shareable URL and the browser Back button works. */
function useHashRoute(): [WorkspaceId, (id: WorkspaceId) => void] {
  const read = (): WorkspaceId => {
    const raw = window.location.hash.replace(/^#\/?/, "");
    return isWorkspaceId(raw) ? raw : DEFAULT_ID;
  };
  const [route, setRoute] = useState<WorkspaceId>(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const go = useCallback((id: WorkspaceId) => { window.location.hash = `/${id}`; }, []);
  return [route, go];
}

export default function App() {
  const [token, setTokenState] = useState(() => localStorage.getItem("stoat_token") ?? "");
  const [apiStatus, setApiStatus] = useState<"unknown" | "ok" | "error">("unknown");
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [authError, setAuthError] = useState("");
  const [sessionNotice, setSessionNotice] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [active, go] = useHashRoute();
  const mainRef = useRef<HTMLElement>(null);

  // Verify the stored session whenever the token changes.
  useEffect(() => {
    if (!token) return;
    let current = true;
    setPrincipal(null);
    setApiStatus("unknown");
    setAuthError("");
    api.auth.me()
      .then((me) => { if (current) { setPrincipal(me); setApiStatus("ok"); } })
      .catch((error: Error) => { if (current) { setAuthError(error.message); setApiStatus("error"); } });
    return () => { current = false; };
  }, [token]);

  // An expired or revoked session returns the user to sign-in with an explanation.
  useEffect(() => {
    const onExpired = () => {
      setTokenState("");
      setPrincipal(null);
      setApiStatus("unknown");
      setSessionNotice("Your session expired. Please sign in again.");
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  const role = principal?.type === "user" ? principal.role : undefined;
  // A route the person's role may not open falls back to the default screen.
  const routed = ROUTABLE_ITEMS.find((i) => i.id === active);
  const activeItem = routed && canOpen(routed, role) ? routed : ALL_ITEMS[0];

  // On every route change: close the drawer, set the tab title, and move focus to the page
  // heading so keyboard and screen-reader users land at the top of the new screen.
  useEffect(() => {
    setNavOpen(false);
    document.title = `${activeItem.label} · Stoat`;
    document.getElementById("page-title")?.focus({ preventScroll: true });
    mainRef.current?.scrollTo?.({ top: 0 });
    window.scrollTo({ top: 0 });
  }, [activeItem.id, activeItem.label, principal]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setNavOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  const signOut = () => {
    setToken("");
    setTokenState("");
    setPrincipal(null);
    setApiStatus("unknown");
    setAuthError("");
    setSessionNotice("");
  };

  if (!token) {
    return (
      <AuthScreen
        key={sessionNotice}
        onAuthenticated={(t) => { setSessionNotice(""); setToken(t); setTokenState(t); }}
        initialError={sessionNotice || undefined}
      />
    );
  }

  if (apiStatus === "unknown") {
    return <main className="auth-page"><Loading label="Connecting to Stoat…" /></main>;
  }

  if (apiStatus === "error") {
    return (
      <AuthScreen
        key={`${token}:${authError}`}
        onAuthenticated={(t) => { setToken(t); setTokenState(t); }}
        initialError={`Could not verify this session: ${authError}`}
      />
    );
  }

  // buyer role → BuyerPortal, UNLESS they have navigated to a payment workspace via hash
  const paymentWorkspaces: WorkspaceId[] = ["payments", "payment-journey", "moneyflow", "settlement", "wallet", "notifications"];
  if (principal?.type === "user" && principal.role === "buyer" && !paymentWorkspaces.includes(activeItem.id)) {
    return <BuyerPortal principal={principal} onSignOut={signOut} />;
  }
  if (principal?.type === "agent") return <AgentPortal principal={principal} onSignOut={signOut} />;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("page-title")?.focus(); }}>
        Skip to content
      </a>

      <div className="topbar">
        <button
          type="button"
          className="icon-button"
          aria-label="Open navigation menu"
          aria-expanded={navOpen}
          aria-controls="primary-nav"
          onClick={() => setNavOpen(true)}
        >
          <Icon icon={Menu} />
        </button>
        <span className="topbar-title">{activeItem.label}</span>
        <NotificationsBell className="notif-bell-mobile" />
      </div>

      <div className="scrim" data-open={navOpen} onClick={() => setNavOpen(false)} aria-hidden="true" />

      <aside className="sidebar" id="primary-nav" data-open={navOpen} aria-label="Primary">
        <div className="brand">
          <BrandLogo />
          <div>
            <div className="brand-name">Stoat</div>
            <div className="brand-meta">Operator console · {principal?.role}</div>
          </div>
          {navOpen && (
            <button type="button" className="icon-button" style={{ marginLeft: "auto" }} aria-label="Close navigation menu" onClick={() => setNavOpen(false)}>
              <Icon icon={X} />
            </button>
          )}
        </div>

        <div className="mode-badges" aria-label="Data sources">
          <LlmBadge />
          <PayPalBadge />
          {principal?.data_source === "seeded_demo" && <StatusBadge label="seeded demo data" variant="seeded" />}
          {principal?.data_source === "live" && <StatusBadge label="live tenant data" variant="live" />}
        </div>

        <nav aria-label="Workspaces">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.label} role="group" aria-label={group.label}>
              <div className="nav-label" aria-hidden="true">{group.label}</div>
              {group.items.filter((item) => canOpen(item, role)).map((item) => (
                <a
                  key={item.id}
                  className="nav-item"
                  href={`#/${item.id}`}
                  aria-current={item.id === activeItem.id ? "page" : undefined}
                  onClick={(e) => { e.preventDefault(); go(item.id); }}
                >
                  <Icon icon={item.icon} />
                  {item.label}
                </a>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <NotificationsBell className="notif-bell-desktop notif-bell-up" />
          <a className="nav-item" href="/docs/user-guide.html" target="_blank" rel="noopener noreferrer">
            <Icon icon={BookOpen} /> User guide <ExternalLink className="icon" aria-hidden="true" style={{ marginLeft: "auto", width: 14, height: 14 }} />
          </a>
          <a className="nav-item" href="/docs/admin-guide.html" target="_blank" rel="noopener noreferrer">
            <Icon icon={BookOpen} /> Admin guide <ExternalLink className="icon" aria-hidden="true" style={{ marginLeft: "auto", width: 14, height: 14 }} />
          </a>
          <button type="button" className="btn btn-secondary btn-block" onClick={signOut}>
            <Icon icon={LogOut} /> Sign out
          </button>
        </div>
      </aside>

      <main id="main" className="main" ref={mainRef} aria-labelledby="page-title">
        <div className="page">
          <PageHeader icon={activeItem.icon} title={activeItem.label} description={activeItem.description} />
          <PaymentsDue />
          {WORKSPACES[activeItem.id]}
        </div>
      </main>
    </div>
  );
}
