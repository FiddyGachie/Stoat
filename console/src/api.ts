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

function getToken(): string {
  return (
    localStorage.getItem("stoat_token") ??
    (import.meta.env.VITE_API_TOKEN as string | undefined) ??
    ""
  );
}

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
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => apiFetch<{ status: string; version: string }>("/health"),
  integrity: () => apiFetch<Record<string, unknown>>("/integrity"),

  agents: (params?: Record<string, string>) =>
    apiFetch<{ agents: unknown[]; more: boolean }>(
      `/agents?${new URLSearchParams(params ?? "")}`,
    ),
  agentRuns: (params?: Record<string, string>) =>
    apiFetch<{ runs: unknown[]; more: boolean }>(
      `/agents/runs?${new URLSearchParams(params ?? "")}`,
    ),
  agentRunTrace: (runId: string) => apiFetch<unknown>(`/agents/runs/${runId}`),

  services: (category?: string) =>
    apiFetch<{ services: unknown[] }>(
      `/services${category ? `?category=${encodeURIComponent(category)}` : ""}`,
    ),

  missions: () => apiFetch<{ missions: unknown[] }>("/missions"),
  events: (params?: Record<string, string>) =>
    apiFetch<{ events: unknown[]; more: boolean }>(
      `/events?${new URLSearchParams(params ?? "")}`,
    ),
  deliveries: (params?: Record<string, string>) =>
    apiFetch<{ deliveries: unknown[]; more: boolean }>(
      `/deliveries?${new URLSearchParams(params ?? "")}`,
    ),
  obligations: (status?: string) =>
    apiFetch<{ obligations: unknown[] }>(
      `/obligations${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  settlementBatches: () =>
    apiFetch<{ batches: unknown[] }>("/settlement/batches"),
  settlementBatch: (id: string) =>
    apiFetch<unknown>(`/settlement/batches/${id}`),
  reconciliation: () => apiFetch<{ records: unknown[] }>("/reconciliation"),
  policyDecisions: (params?: Record<string, string>) =>
    apiFetch<{ decisions: unknown[]; more: boolean }>(
      `/policy/decisions?${new URLSearchParams(params ?? "")}`,
    ),
  holds: (params?: Record<string, string>) =>
    apiFetch<{ holds: unknown[]; more: boolean }>(
      `/holds?${new URLSearchParams(params ?? "")}`,
    ),
  journal: (params?: Record<string, string>) =>
    apiFetch<{ transactions: unknown[]; more: boolean }>(
      `/journal/transactions?${new URLSearchParams(params ?? "")}`,
    ),

  aggregates: {
    obligationsByStatus: () =>
      apiFetch<{ data: unknown[] }>("/aggregates/obligations-by-status"),
    missionSpend: () =>
      apiFetch<{ data: unknown[] }>("/aggregates/mission-spend"),
    eventVolume: () =>
      apiFetch<{ data: unknown[] }>("/aggregates/event-volume"),
    captureReconciliation: () =>
      apiFetch<{ data: unknown[] }>("/aggregates/capture-reconciliation"),
    policyDenials: () =>
      apiFetch<{ data: unknown[] }>("/aggregates/policy-denials"),
  },
};

export function setToken(token: string) {
  localStorage.setItem("stoat_token", token);
}
