/**
 * Stoat API client.
 *
 * On Render (static site), VITE_API_BASE_URL is baked in at build time and
 * the console makes direct cross-origin requests to stoat-api.onrender.com.
 *
 * In local dev, VITE_API_BASE_URL is empty so we use '' (proxied to localhost
 * via the Vite proxy in vite.config.ts).
 */

// Use the baked-in base URL if set; otherwise use relative paths (local proxy)
const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
const API_BASE = `${BASE}/v1`;

export interface Principal {
  id: string;
  tenant_id: string;
  tenant_name: string;
  data_source: string;
  type: "user" | "agent";
  role: string;
  name: string;
  buyer_agent_id?: string;
}

export interface ServiceListing {
  id: string;
  provider_id: string;
  name: string;
  description: string;
  category: string;
  unit_price: string;
  currency: string;
  unit: string;
  status: string;
}

export interface Mission {
  id: string;
  buyer_id: string;
  title: string;
  brief: string;
  budget: string;
  reserved_budget: string;
  currency: string;
  deadline: string;
  status: string;
  created_at: string;
  /** The completed mission this one replays, if any. */
  replay_of?: string | null;
}

/** One archived, verified result (append-only on the server). */
export interface MissionResultRecord {
  id: string;
  mission_id: string;
  agreement_id: string;
  replay_of: string | null;
  mission_title: string;
  mission_brief: string | null;
  provider_name: string | null;
  price: string | null;
  charged: string | null;
  currency: string | null;
  summary: string | null;
  findings_count: number;
  severity_counts: Record<string, number>;
  findings: {
    severity: string;
    title: string | null;
    rule_id: string;
    file: string;
    line_start: number;
    line_end: number;
    description?: string | null;
    recommendation?: string | null;
  }[];
  files_reviewed: string[] | null;
  artifact_hash: string | null;
  verified_by: string | null;
  model: string | null;
  archived_at: string;
}

export interface MissionReplayResult {
  mission: Mission;
  replay_of: string;
  last_spend: string;
  target_budget: string;
  quote: MissionQuote;
  negotiation: NegotiationResult | null;
  negotiation_error: { code: string; message: string } | null;
}

export interface MissionQuote {
  id: string;
  service_id: string;
  service_name: string;
  price: string;
  currency: string;
  status: string;
  expires_at: string;
  agreement_id?: string | null;
  agreement_status?: string | null;
  funding_status?: string | null;
}

export interface AgentSummary {
  id: string;
  role: string;
  name: string;
  status: string;
  scopes: string[];
  created_at: string;
}

export interface AgentRun {
  id: string;
  agent_id: string;
  role: string;
  mission_id?: string | null;
  model?: string | null;
  steps_count: number;
  cost_usd: string;
  status: string;
  terminal_reason?: string | null;
  started_at: string;
  completed_at?: string | null;
}

export interface AgentTrace {
  run: AgentRun & { terminal_reason?: string | null };
  steps: {
    step_number: number;
    tool_name: string;
    authorization_result: string;
    error_code?: string | null;
  }[];
  proposals: {
    id: string;
    proposal_type: string;
    prompt_hash: string;
    model: string;
    created_at: string;
  }[];
}

function getToken(): string {
  return (
    localStorage.getItem("stoat_token") ??
    (import.meta.env.VITE_API_TOKEN as string | undefined) ??
    ""
  );
}

export const SESSION_EXPIRED_EVENT = "stoat:session-expired";

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts?.headers ?? {}),
    },
  });
  // A 401 on an authenticated call means the session expired or was revoked. Drop the dead
  // token and tell the shell, which returns the user to sign-in with an explanation.
  // Credential endpoints (/auth/*) are excluded: a 401 there is just a wrong password.
  if (res.status === 401 && token && !path.startsWith("/auth/")) {
    localStorage.removeItem("stoat_token");
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    if (body?.error?.message) {
      // Keep the Stoat error code on the Error so screens can show it (R15.14).
      throw Object.assign(new Error(body.error.message), {
        code: body.error.code,
      });
    }
    // A 404 without Stoat's JSON error means the route itself does not exist on that server:
    // almost always an API process started from an older build than this console.
    if (res.status === 404) {
      throw new Error(
        `The API at ${API_BASE} has no ${path.split("?")[0]} route. It is probably running an older build: rebuild it (npm run build) and restart it.`,
      );
    }
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface EarningsByCurrency {
  currency: string;
  payable: string;
  in_settlement: string;
  settled: string;
  payout_pending: string;
  paid: string;
  payout_issue: string;
  reversed: string;
  total_accrued: string;
  obligations: number;
}
export interface AgentPerformance {
  agent: {
    id: string;
    name: string;
    role: string;
    status: string;
    created_at: string;
  };
  runs: {
    total: number;
    completed: number;
    failed: number;
    llm_cost_usd: string;
  };
  deliveries: {
    total: number;
    verified: number;
    rejected: number;
    needs_review: number;
    verification_rate: number | null;
  };
  services: { total: number; active: number };
  agreements_won: number;
  earnings: EarningsByCurrency[];
  spend: Array<{ currency: string; committed: string; agreements: number }>;
}
export interface PerformanceOverview {
  agents: AgentPerformance[];
  summary: {
    agents: number;
    active_agents: number;
    suspended_agents: number;
    deliveries_judged: number;
    verification_rate: number | null;
    earned: Array<{ currency: string; total: string }>;
    committed_spend: Array<{ currency: string; total: string }>;
  };
  earnings_by_day: Array<{ day: string; currency: string; amount: string }>;
}
/* Grid rows are rendered by generic AG Grid column definitions, so their shape is intentionally loose. */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = any;

export interface IntegrityReport {
  integrity_status: "healthy" | "violation_detected";
  computed_at: string;
  metrics: {
    debit_credit_balance: Array<{
      currency: string;
      total_debit: string;
      total_credit: string;
      delta: string;
      balanced: boolean;
    }>;
    hash_chain_gaps: number;
    duplicate_obligations: number;
    duplicate_active_reservations: number;
    orphan_reservations: number;
    batch_sum_mismatches: number;
    unreconciled_captures: number;
    unauthorized_agreements: number;
    paid_without_payout: number;
    duplicate_successful_payouts: number;
    payout_exceeds_obligation: number;
    non_paypal_payments: number;
  };
}
export const api = {
  health: () =>
    apiFetch<{
      status: string;
      version: string;
      llm: {
        mode: "live" | "record" | "replay";
        provider: string;
        model: string;
        key_configured: boolean;
      };
    }>("/health"),
  integrity: () => apiFetch<IntegrityReport>("/integrity"),

  auth: {
    signup: (input: {
      email: string;
      password: string;
      organization_name: string;
    }) =>
      apiFetch<{ access_token: string }>("/auth/signup", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    login: (input: { email: string; password: string }) =>
      apiFetch<{ access_token: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    agentLogin: (input: { agent_id: string; secret: string }) =>
      apiFetch<{ access_token: string }>("/auth/agent/login", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    me: () => apiFetch<Principal>("/auth/me"),
  },

  agentPerformance: () => apiFetch<PerformanceOverview>("/agents/performance"),
  setAgentStatus: (agentId: string, status: "active" | "suspended") =>
    apiFetch<{ agent: { id: string; status: string } }>(
      `/agents/${agentId}/status`,
      {
        method: "POST",
        body: JSON.stringify({ status }),
      },
    ),
  agents: (params?: Record<string, string>) =>
    apiFetch<{ agents: AgentSummary[]; more: boolean }>(
      `/agents?${new URLSearchParams(params ?? "")}`,
    ),
  agentRuns: (params?: Record<string, string>) =>
    apiFetch<{ runs: AgentRun[]; more: boolean }>(
      `/agents/runs?${new URLSearchParams(params ?? "")}`,
    ),
  agentRunTrace: (runId: string) =>
    apiFetch<AgentTrace>(`/agents/runs/${runId}`),

  services: (category?: string) =>
    apiFetch<{ services: ServiceListing[] }>(
      `/services${category ? `?category=${encodeURIComponent(category)}` : ""}`,
    ),

  publishService: (input: {
    name: string;
    description: string;
    category: string;
    execution_mode?: "hosted" | "external";
    min_price?: string;
    unit_price: string;
    currency: string;
    unit: string;
    verification_profile?: Record<string, unknown>;
  }) =>
    apiFetch<ServiceListing>("/services", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createAgent: (input: { name: string; role: "buyer" | "provider" }) =>
    apiFetch<{ agent: AgentSummary; secret: string }>("/agents", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  missions: () => apiFetch<{ missions: Mission[] }>("/missions"),
  createMission: (input: {
    title: string;
    brief: string;
    budget: string;
    currency: string;
  }) =>
    apiFetch<Mission>("/missions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateMission: (missionId: string, input: { title?: string; brief?: string; budget?: string }) =>
    apiFetch<Mission>(`/missions/${missionId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteMission: (missionId: string) =>
    apiFetch<{ id: string; status: string; withdrawn_quotes: number }>(`/missions/${missionId}`, { method: "DELETE" }),
  replayMission: (missionId: string) =>
    apiFetch<MissionReplayResult>(`/missions/${missionId}/replay`, { method: "POST", body: "{}" }),
  missionResults: (missionId?: string) =>
    apiFetch<{ results: MissionResultRecord[] }>(`/mission-results${missionId ? `?mission_id=${missionId}` : ""}`),
  missionQuotes: (missionId: string) =>
    apiFetch<{ quotes: MissionQuote[] }>(`/missions/${missionId}/quotes`),
  requestQuote: (input: {
    mission_id: string;
    service_id: string;
    quantity: number;
  }) =>
    apiFetch<MissionQuote>("/quotes", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  acceptQuote: (quoteId: string, proposalId?: string) =>
    apiFetch<{
      id: string;
      status: string;
      price: string;
      currency: string;
      payment?: { approve_url: string | null; status: string } | null;
      payment_error?: { code: string; message: string } | null;
    }>(`/quotes/${quoteId}/accept`, {
      method: "POST",
      body: JSON.stringify(proposalId ? { proposal_id: proposalId } : {}),
    }),
  events: (params?: Record<string, string>) =>
    apiFetch<{ events: Row[]; more: boolean }>(
      `/events?${new URLSearchParams(params ?? "")}`,
    ),
  deliveries: (params?: Record<string, string>) =>
    apiFetch<{ deliveries: Row[]; more: boolean }>(
      `/deliveries?${new URLSearchParams(params ?? "")}`,
    ),
  obligations: (status?: string) =>
    apiFetch<{ obligations: Row[] }>(
      `/obligations${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  approveBatch: (batchId: string, reason: string) =>
    apiFetch<Row>(`/settlement/batches/${batchId}/approve`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  rejectBatch: (batchId: string, reason: string) =>
    apiFetch<Row>(`/settlement/batches/${batchId}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  settlementBatches: () => apiFetch<{ batches: Row[] }>("/settlement/batches"),
  settlementBatch: (id: string) => apiFetch<Row>(`/settlement/batches/${id}`),
  reconciliation: () => apiFetch<{ records: Row[] }>("/reconciliation"),
  batchProviders: (batchId: string) =>
    apiFetch<{ providers: Row[] }>(`/settlement/batches/${batchId}/payouts`),
  setPayoutRecipient: (
    agentId: string,
    paypalEmail: string,
    consent: boolean,
  ) =>
    apiFetch<{ recipient_masked: string; verification_status: string }>(
      `/agents/${agentId}/payout-account`,
      {
        method: "PUT",
        body: JSON.stringify({ paypal_email: paypalEmail, consent }),
      },
    ),
  verifyPayoutRecipient: (agentId: string, confirmMasked: string) =>
    apiFetch<{ recipient_masked: string; verification_status: string }>(
      `/agents/${agentId}/payout-account/verify`,
      {
        method: "POST",
        body: JSON.stringify({ confirm_masked: confirmMasked }),
      },
    ),
  approvePayout: (batchId: string) =>
    apiFetch<{
      approval_id: string;
      expires_at: string;
      total: string;
      currency: string;
      providers: { name: string; amount: string; recipient_masked: string }[];
    }>(`/settlement/batches/${batchId}/payout-approval`, {
      method: "POST",
      body: "{}",
    }),
  payProviders: (batchId: string, approvalId: string) =>
    apiFetch<{
      payouts: Row[];
      errors: { agent_id: string; code: string; message: string }[];
      replayed: boolean;
    }>(`/settlement/batches/${batchId}/payouts`, {
      method: "POST",
      body: JSON.stringify({ approval_id: approvalId }),
    }),
  refreshPayout: (payoutId: string) =>
    apiFetch<{ payout: Row }>(`/payouts/${payoutId}/refresh`, {
      method: "POST",
      body: "{}",
    }),
  moneyFlow: () =>
    apiFetch<{
      payouts_capability: {
        status: string;
        enabled: boolean;
        reason: string | null;
      };
      flows: Row[];
    }>("/money-flow"),
  agreementResult: (agreementId: string) =>
    apiFetch<AgreementResult>(`/agreements/${agreementId}/result`),
  treasuryPlan: () =>
    apiFetch<TreasuryPlan>("/settlement/treasury-plan", {
      method: "POST",
      body: "{}",
    }),
  negotiate: (missionId: string) =>
    apiFetch<NegotiationResult>(`/missions/${missionId}/negotiate`, {
      method: "POST",
      body: "{}",
    }),
  paymentsDue: () => apiFetch<{ payments: Row[] }>("/payments/due"),
  refreshPayment: (paymentId: string) =>
    apiFetch<{ payment: Row }>(`/payments/${paymentId}/refresh`, {
      method: "POST",
      body: "{}",
    }),
  requestAgreementPayment: (agreementId: string) =>
    apiFetch<{
      payment: { approve_url: string | null; status: string } | null;
    }>(`/agreements/${agreementId}/payment`, { method: "POST", body: "{}" }),
  releaseFundedBatch: (batchId: string) =>
    apiFetch<{
      status: string;
      released: string;
      currency: string;
      note: string;
    }>(`/settlement/batches/${batchId}/release-funded`, {
      method: "POST",
      body: "{}",
    }),
  budgets: {
    create: (input: {
      amount: string;
      currency?: string;
      mission_id?: string;
    }) =>
      apiFetch<{ budget: Row }>("/budgets", {
        method: "POST",
        body: JSON.stringify(input),
      }),

    list: (params?: {
      status?: string;
      mission_id?: string;
      owner_id?: string;
    }) =>
      apiFetch<{ budgets: Row[] }>(
        `/budgets?${new URLSearchParams(Object.entries(params ?? {}).filter(([, v]) => v != null) as [string, string][])}`,
      ),

    analytics: () =>
      apiFetch<{
        by_status: {
          status: string;
          count: number;
          total_amount: string;
          total_debited: string;
          currency: string;
        }[];
        utilization_histogram: { bucket: string; count: number }[];
        daily_debits: {
          day: string;
          currency: string;
          total: string;
          count: number;
        }[];
        top_debit_reasons: {
          reason: string;
          count: number;
          total: string;
          currency: string;
        }[];
      }>("/budgets/analytics"),

    get: (budgetId: string) =>
      apiFetch<{ budget: Row }>(`/budgets/${budgetId}`),

    debits: (budgetId: string) =>
      apiFetch<{ debits: Row[] }>(`/budgets/${budgetId}/debits`),

    /**
     * @deprecated The route is deprecated and money-inert: it debits nothing and rejects any
     * body `amount`. Charges arise only from verified obligations. No amount is accepted here.
     */
    debit: (budgetId: string) =>
      apiFetch<{ deprecated: true; debited: false; message: string }>(
        `/budgets/${budgetId}/debit`,
        { method: "POST", body: "{}" },
      ),

    debitAdvice: (
      budgetId: string,
      input: { amount: string; reason: string },
    ) =>
      apiFetch<{
        run_id: string;
        model: string;
        mode: string;
        replayed: boolean;
        advice: {
          recommendation: string;
          reasoning: string;
          utilization_pct: number;
          warning_message?: string;
          stop_reason?: string;
        };
      }>(`/budgets/${budgetId}/debit-advice`, {
        method: "POST",
        body: JSON.stringify(input),
      }),

    complete: (budgetId: string, missionTitle?: string) =>
      apiFetch<{
        budget: Row;
        agent_prompt: {
          run_id: string;
          prompt: {
            subject: string;
            body: string;
            refund_label: string;
            retain_label: string;
            recommendation: string;
            rationale: string;
          };
        } | null;
      }>(`/budgets/${budgetId}/complete`, {
        method: "POST",
        body: JSON.stringify(
          missionTitle ? { mission_title: missionTitle } : {},
        ),
      }),

    remainderPrompt: (budgetId: string, missionTitle?: string) =>
      apiFetch<{
        run_id: string;
        model: string;
        mode: string;
        replayed: boolean;
        prompt: {
          subject: string;
          body: string;
          refund_label: string;
          retain_label: string;
          recommendation: string;
          rationale: string;
        };
      }>(
        `/budgets/${budgetId}/remainder-prompt${missionTitle ? `?mission_title=${encodeURIComponent(missionTitle)}` : ""}`,
      ),

    decide: (budgetId: string, decision: "refund" | "retain", note?: string) =>
      apiFetch<{ budget: Row; decision: Row }>(`/budgets/${budgetId}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
      }),

    getDecision: (budgetId: string) =>
      apiFetch<{ decision: Row | null }>(`/budgets/${budgetId}/decision`),

    edit: (budgetId: string, input: { amount: string; currency?: string }) =>
      apiFetch<{ budget: Row; replaced: Row }>(`/budgets/${budgetId}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    remove: (budgetId: string) =>
      apiFetch<{ budget: Row; deleted: boolean }>(`/budgets/${budgetId}`, { method: "DELETE" }),
    sync: (budgetId: string) =>
      apiFetch<{ budget: Row }>(`/budgets/${budgetId}/sync`, { method: "POST", body: "{}" }),

    cancel: (budgetId: string) =>
      apiFetch<{ budget: Row }>(`/budgets/${budgetId}/cancel`, {
        method: "POST",
        body: "{}",
      }),
  },

  paymentsAiAssist: (input: {
    question: string;
    mission_id?: string;
    budget_id?: string;
    history?: { role: "user" | "assistant"; content: string }[];
  }) =>
    apiFetch<{
      model: string;
      mode: string;
      replayed: boolean;
      reply: {
        answer: string;
        action_hints: {
          label: string;
          action: string;
          payload?: Record<string, unknown>;
        }[];
        confidence: "high" | "medium" | "low";
        data_used: string[];
      };
    }>("/payments/ai-assist", { method: "POST", body: JSON.stringify(input) }),

  paypalStatus: () =>
    apiFetch<{
      configured: boolean;
      environment: "sandbox" | "live" | null;
      webhook_configured: boolean;
      orders: { status: string };
      payouts: { status: string; enabled: boolean; reason?: string };
    }>("/paypal/status"),
  batchPayment: (batchId: string) =>
    apiFetch<{ payment: Row | null }>(`/settlement/batches/${batchId}/payment`),
  createPayPalOrder: (batchId: string) =>
    apiFetch<{ order_id: string; approve_url: string; status: string }>(
      `/settlement/batches/${batchId}/paypal/create-order`,
      { method: "POST", body: "{}" },
    ),
  capturePayPalOrder: (batchId: string, orderId: string) =>
    apiFetch<{
      capture_id: string;
      status: string;
      amount: string;
      currency: string;
    }>(`/settlement/batches/${batchId}/paypal/capture`, {
      method: "POST",
      body: JSON.stringify({ order_id: orderId }),
    }),
  policyDecisions: (params?: Record<string, string>) =>
    apiFetch<{ decisions: Row[]; more: boolean }>(
      `/policy/decisions?${new URLSearchParams(params ?? "")}`,
    ),
  holds: (params?: Record<string, string>) =>
    apiFetch<{ holds: Row[]; more: boolean }>(
      `/holds?${new URLSearchParams(params ?? "")}`,
    ),
  journal: (params?: Record<string, string>) =>
    apiFetch<{ transactions: Row[]; more: boolean }>(
      `/journal/transactions?${new URLSearchParams(params ?? "")}`,
    ),

  aggregates: {
    obligationsByStatus: () =>
      apiFetch<{ data: Row[] }>("/aggregates/obligations-by-status"),
    missionSpend: () => apiFetch<{ data: Row[] }>("/aggregates/mission-spend"),
    eventVolume: () => apiFetch<{ data: Row[] }>("/aggregates/event-volume"),
    captureReconciliation: () =>
      apiFetch<{ data: Row[] }>("/aggregates/capture-reconciliation"),
    policyDenials: () =>
      apiFetch<{ data: Row[] }>("/aggregates/policy-denials"),
  },
};

/* ── Mission budget wallet ─────────────────────────────────────────────────────
 * Display types for the wallet API. Amounts are decimal strings. No type here carries a recipient,
 * payee or payment source, and no call lets an agent act: the routes refuse agent principals. */

export interface WalletView {
  id: string;
  currency: string;
  status: string;
  paypal_environment: string;
  balance: string;
  reserved: string;
  pending_refund: string;
  available: string;
  deposited: string;
  charged: string;
  refunded: string;
  funding_mode: string;
}
export interface WalletOverview {
  funding_mode: string;
  paypal_environment: string | null;
  supported_currencies?: string[];
  wallets: WalletView[];
}
export interface WalletDeposit {
  id: string;
  wallet_id: string;
  mission_id: string | null;
  is_top_up: boolean;
  status: string;
  amount: string;
  currency: string;
  credited_amount: string;
  paypal_environment: "sandbox" | "live";
  paypal_order_id: string | null;
  approve_url: string | null;
  failure_reason: string | null;
  created_at: string;
}
export interface MissionWallet {
  mission_id: string;
  title: string;
  mission_status: string;
  currency: string;
  budget: string;
  available: string;
  shortfall: string;
  reserved: string;
  charged: string;
  unreserved_funding: string;
  state: string;
}
export interface WalletRefundItem {
  id: string;
  deposit_id: string;
  paypal_capture_id: string;
  amount: string;
  status: string;
  paypal_refund_id: string | null;
  paypal_status: string | null;
  failure_reason: string | null;
  attempts: number;
}
export interface WalletRefund {
  id: string;
  wallet_id: string;
  kind: string;
  mission_id: string | null;
  decision_id: string | null;
  amount: string;
  currency: string;
  status: string;
  actor_user_id: string | null;
  actor_role: string | null;
  reason: string | null;
  paypal_environment: string;
  created_at: string;
  updated_at: string;
  items?: WalletRefundItem[];
}
export interface RemainderDecision {
  id: string;
  mission_id: string;
  wallet_id: string;
  decision: string;
  remainder_amount: string;
  refund_amount: string;
  decided_by: string;
  decided_at: string;
  refund: WalletRefund | null;
}
export interface RemainderPrompt {
  mission_id: string;
  paypal_environment: string | null;
  figures: {
    currency: string;
    budget: string;
    available: string;
    charged: string;
    reserved: string;
    shortfall: string;
    state: string;
  };
  advice: unknown;
  ai_generated: boolean;
  label: string | null;
  fallback_reason: string | null;
  display_only: true;
}
export interface WalletNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: string | null;
  mission_id: string | null;
  link: string | null;
  created_at: string;
  read_at: string | null;
  updated_at: string | null;
  resolved_at: string | null;
}
export interface EconomicEventView {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  sequence: number;
  event_type: string;
  actor_type: string;
  actor_role: string | null;
  actor_id: string | null;
  correlation_id: string | null;
  amount: string | null;
  currency: string | null;
  recorded_at: string;
  paypal_order_id: string | null;
  paypal_capture_id: string | null;
  paypal_refund_id: string | null;
  paypal_payout_batch_id: string | null;
  paypal_request_id: string | null;
}
export interface StatementLine {
  id: string | null;
  wallet_id: string;
  kind: string;
  description: string | null;
  amount: string;
  currency: string;
  balance_after: string | null;
  entity_type: string | null;
  entity_id: string | null;
  paypal_environment: string | null;
  occurred_at: string;
}
export interface WalletStatement {
  wallet_id: string | null;
  currency: string | null;
  paypal_environment: string | null;
  balance?: string;
  lines: StatementLine[];
  next_cursor: string | null;
}
export interface BusinessAccountRow {
  currency: string;
  paypal_funds_received: string;
  wallet_balance_held: string;
  funds_allocated_to_providers: string;
  provider_payouts_completed: string;
  refunds_completed: string;
  platform_revenue: string;
  wallet_balance_sum: string;
  difference: string;
}
export interface TrialBalanceRow {
  currency: string;
  total_debits: string;
  total_credits: string;
  difference: string;
  balanced: boolean;
}

const newKey = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const keyed = (key?: string): Record<string, string> => ({
  "Idempotency-Key": key ?? newKey(),
});
const qs = (params?: Record<string, string | undefined>): string => {
  const entries = Object.entries(params ?? {}).filter(
    ([, v]) => v !== undefined && v !== "",
  ) as [string, string][];
  return entries.length ? `?${new URLSearchParams(entries)}` : "";
};

/** Typed wallet calls. Every call is made by the signed-in person; the server decides what they may do. */
export const walletApi = {
  overview: () => apiFetch<WalletOverview>("/wallet"),
  createWallet: (currency: string) =>
    apiFetch<WalletView>("/wallet", { method: "POST", body: JSON.stringify({ currency }) }),
  deposits: () => apiFetch<{ deposits: WalletDeposit[] }>("/wallet/deposits"),
  deposit: (id: string) => apiFetch<WalletDeposit>(`/wallet/deposits/${id}`),
  refreshDeposit: (id: string) =>
    apiFetch<WalletDeposit>(`/wallet/deposits/${id}/refresh`, {
      method: "POST",
      body: "{}",
    }),
  createDeposit: (input: { amount: string; currency: string }, key?: string) =>
    apiFetch<WalletDeposit>("/wallet/deposits", {
      method: "POST",
      headers: keyed(key),
      body: JSON.stringify(input),
    }),
  missions: () => apiFetch<{ missions: MissionWallet[] }>("/wallet/missions"),
  mission: (id: string) => apiFetch<MissionWallet>(`/wallet/missions/${id}`),
  completeMission: (id: string) =>
    apiFetch<MissionWallet>(`/wallet/missions/${id}/complete`, {
      method: "POST",
      body: "{}",
    }),
  topUp: (
    missionId: string,
    input: { amount: string; currency?: string },
    key?: string,
  ) =>
    apiFetch<WalletDeposit>(`/wallet/missions/${missionId}/top-up`, {
      method: "POST",
      headers: keyed(key),
      body: JSON.stringify(input),
    }),
  remainderPrompt: (missionId: string) =>
    apiFetch<RemainderPrompt>(`/wallet/missions/${missionId}/remainder-prompt`),
  decideRemainder: (
    missionId: string,
    decision: "refund" | "keep",
    key?: string,
  ) =>
    apiFetch<RemainderDecision>(
      `/wallet/missions/${missionId}/remainder-decision`,
      {
        method: "POST",
        headers: keyed(key),
        body: JSON.stringify({ decision }),
      },
    ),
  refunds: () =>
    apiFetch<{ paypal_environment: string | null; refunds: WalletRefund[] }>(
      "/wallet/refunds",
    ),
  refund: (id: string) => apiFetch<WalletRefund>(`/wallet/refunds/${id}`),
  createRefund: (input: { amount: string; currency?: string }, key?: string) =>
    apiFetch<WalletRefund>("/wallet/refunds", {
      method: "POST",
      headers: keyed(key),
      body: JSON.stringify(input),
    }),
  retryRefund: (id: string, key?: string) =>
    apiFetch<WalletRefund>(`/wallet/refunds/${id}/retry`, {
      method: "POST",
      headers: keyed(key),
      body: "{}",
    }),
  events: (params: {
    entity_type: "wallet" | "deposit" | "mission";
    entity_id: string;
    cursor?: string;
  }) =>
    apiFetch<{ events: EconomicEventView[]; next_cursor: string | null }>(
      `/wallet/events${qs(params)}`,
    ),
  statement: (params?: { currency?: string; cursor?: string }) =>
    apiFetch<WalletStatement>(`/wallet/statement${qs(params)}`),
  account: () => apiFetch<Row>("/wallet/account"),
  analytics: (dataset: string, params?: Record<string, string | undefined>) =>
    apiFetch<Row>(`/analytics/wallet/${dataset}${qs(params)}`),
  analyticsChart: (
    chart: string,
    params?: Record<string, string | undefined>,
  ) => apiFetch<Row>(`/analytics/wallet/charts/${chart}${qs(params)}`),
  /** Every authorized row as CSV text, produced by the server (R14.5, R14.11). */
  analyticsCsv: async (dataset: string): Promise<string> => {
    const token = getToken();
    const res = await fetch(`${API_BASE}/analytics/wallet/${dataset}.csv`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string; code?: string };
      };
      throw Object.assign(
        new Error(body?.error?.message ?? `HTTP ${res.status}`),
        { code: body?.error?.code },
      );
    }
    return res.text();
  },

  notifications: (cursor?: string) =>
    apiFetch<{
      notifications: WalletNotification[];
      next_cursor: string | null;
    }>(`/notifications${qs({ cursor })}`),
  unreadCount: () =>
    apiFetch<{ unread_count: number }>("/notifications/unread-count"),
  markRead: (id: string) =>
    apiFetch<{ notification: WalletNotification; unread_count: number }>(
      `/notifications/${id}/read`,
      {
        method: "POST",
        body: "{}",
      },
    ),

  // Operator and supervisor only; the server refuses every other role.
  admin: {
    businessAccount: () => apiFetch<Row>("/admin/business-account"),
    trialBalance: () => apiFetch<Row>("/admin/trial-balance"),
    wallets: (params?: Record<string, string | undefined>) =>
      apiFetch<Row>(`/admin/wallets${qs(params)}`),
    walletStatement: (walletId: string, cursor?: string) =>
      apiFetch<WalletStatement>(
        `/admin/wallets/${walletId}/statement${qs({ cursor })}`,
      ),
    userAccount: (userId: string) =>
      apiFetch<Row>(`/admin/users/${userId}/wallet-account`),
    refund: (
      walletId: string,
      input: { amount: string; reason: string },
      key?: string,
    ) =>
      apiFetch<WalletRefund>(`/admin/wallets/${walletId}/refunds`, {
        method: "POST",
        headers: keyed(key),
        body: JSON.stringify(input),
      }),
    reverseJournal: (transactionId: string, reason: string) =>
      apiFetch<Row>(`/admin/journal/transactions/${transactionId}/reverse`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
    startReconciliation: () =>
      apiFetch<Row>("/admin/reconciliation/runs", {
        method: "POST",
        body: "{}",
      }),
    reconciliationRuns: (params?: Record<string, string | undefined>) =>
      apiFetch<Row>(`/admin/reconciliation/runs${qs(params)}`),
    reconciliationRun: (id: string) =>
      apiFetch<Row>(`/admin/reconciliation/runs/${id}`),
    reconciliationExceptions: (params?: Record<string, string | undefined>) =>
      apiFetch<Row>(`/admin/reconciliation/exceptions${qs(params)}`),
  },
};

export function setToken(token: string) {
  localStorage.setItem("stoat_token", token);
}

export interface NegotiationResult {
  run_id: string;
  model: string;
  mode: string;
  replayed: boolean;
  comparison: {
    proposal_id: string;
    recommended_quote_id: string;
    rationale_summary: string;
  };
  counteroffers: {
    proposal_id: string;
    validation: "passed" | "rejected";
    reason_codes: string[];
    payload: {
      proposed_amount: string;
      currency: string;
      rationale_summary: string;
    } | null;
  }[];
  selection: {
    proposal_id: string;
    quote_id: string;
    provider: string;
    service: string;
    listed_price: string;
    agreed_amount: string;
    currency: string;
    basis: string;
  };
}

/** What the provider delivered, as verified, plus every attempt and the verifier's reasons. */
export interface AgreementResult {
  agreement: {
    id: string;
    status: string;
    price: string;
    currency: string;
    funding_status: string;
  };
  mission: { id: string; title: string; brief: string };
  provider: { id: string; name: string };
  obligation: { id: string; amount: string; status: string } | null;
  result: {
    delivery_id: string;
    verified_by: string;
    artifact_hash: string;
    model: string | null;
    summary: string | null;
    files_reviewed: string[] | null;
    findings: {
      severity: string;
      title: string | null;
      rule_id: string;
      file: string;
      line_start: number;
      line_end: number;
      snippet: string;
      description: string | null;
      recommendation: string | null;
    }[];
  } | null;
  attempts: {
    delivery_id: string;
    revision: number;
    verdict: string;
    reasons: string[];
    checks_passed: number;
    checks_failed: number;
    model: string | null;
  }[];
}

/** The treasury agent's proposal: batches it created (awaiting a person's approval) and the PayPal route for each. */
export interface TreasuryPlan {
  run_id: string | null;
  model: string | null;
  mode: string | null;
  replayed: boolean;
  summary: string;
  batches: {
    batch_id: string;
    status: string;
    total: string;
    currency: string;
    obligation_count: number;
    route: "release_collected_funds" | "collect_via_paypal_order";
    rationale: string;
    next_action: string;
  }[];
  excluded: { obligation_id: string; reason: string }[];
}
