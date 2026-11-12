/**
 * Read_Intent catalog (agentic-commerce design section "Read intents"; R13.1, R13.5, R13.6, R13.13).
 *
 * Each intent is a named, versioned, read-only query with a strict parameter schema, a declared
 * column list, an optional chart shape and a role allowlist. Queries are fixed in code and take
 * the tenant, role and Owner scope from the server-built `ReadContext`; no SQL text is built from
 * model output. The catalog exposes no mutation, approval, payment, capture, refund, payout,
 * recipient or Hold operation, and declares no recipient, email or payee column.
 */
import { Decimal } from "decimal.js";
import { z } from "zod";
import type { DbClient } from "../../db/connection.js";
import {
  alertCounts,
  mandateUsage,
  money,
  paypalFlows,
  proposalCounts,
  spendFacts,
  validateDateRange,
  type AnalyticsScope,
  type DateRange,
} from "./read-models.js";

export const INTENT_CATALOG_VERSION = "1";

export type IntentRole = "owner" | "admin";
export type ColumnType = "string" | "money" | "integer" | "timestamp";
export type Row = Record<string, unknown>;

export interface IntentColumn {
  readonly field: string;
  readonly type: ColumnType;
}

export interface IntentChart {
  readonly type: "bar" | "line" | "donut";
  readonly x: string;
  readonly y: string;
  readonly groupBy?: "currency";
}

/** Server-built context. Nothing here comes from model output. */
export interface ReadContext {
  db: DbClient;
  scope: AnalyticsScope;
  now: Date;
}

export interface ReadIntent<P = any> {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly roles: readonly IntentRole[];
  readonly params: z.ZodType<P>;
  readonly columns: readonly IntentColumn[];
  readonly chart?: IntentChart;
  run(
    ctx: ReadContext,
    params: P,
  ): Promise<{ rows: Row[]; truncated: boolean }>;
}

/** Keys a model may never set; the runner strips them before validation (R13.4). */
export const IGNORED_PARAM_KEYS = [
  "tenant_id",
  "tenant",
  "owner",
  "owner_id",
  "user_id",
  "scope",
] as const;

/** Column names that must never appear in a Read_Intent result (R13.13). */
export const FORBIDDEN_COLUMN_PATTERN = /recipient|email|payee/i;

// ── Parameter schemas ─────────────────────────────────────────────────────────

const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const currencyCode = z.string().regex(/^[A-Z]{3}$/);
const limitParam = z.number().int().min(1).max(10_000);

const windowFields = {
  window: z.enum(["7d", "30d", "90d", "custom"]),
  from: dayString.optional(),
  to: dayString.optional(),
};

/** `custom` needs both dates; a relative window takes none. */
function windowRefine<T extends { window: string; from?: string; to?: string }>(
  p: T,
  ctx: z.RefinementCtx,
): void {
  const custom = p.window === "custom";
  if (custom && (!p.from || !p.to)) {
    ctx.addIssue({
      code: "custom",
      message: "custom window requires from and to",
    });
  }
  if (!custom && (p.from || p.to)) {
    ctx.addIssue({
      code: "custom",
      message: "from and to are only allowed with the custom window",
    });
  }
}

const spendParams = z
  .object({
    ...windowFields,
    currency: currencyCode.optional(),
    limit: limitParam.optional(),
  })
  .strict()
  .superRefine(windowRefine);
const mandateParams = z
  .object({
    status: z
      .enum(["active", "expired", "revoked", "exhausted", "suspended"])
      .optional(),
  })
  .strict();
const proposalParams = z
  .object({ ...windowFields, type: z.string().min(1).max(64).optional() })
  .strict()
  .superRefine(windowRefine);
const openAlertParams = z
  .object({
    severity: z.enum(["low", "medium", "high", "critical"]).optional(),
    detector: z
      .enum([
        "spend_spike",
        "price_outlier",
        "repeated_revision",
        "unusual_provider",
        "wallet_depleting",
        "reconciliation_exception",
      ])
      .optional(),
  })
  .strict();
const alertsByDetectorParams = z
  .object({
    ...windowFields,
    severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  })
  .strict()
  .superRefine(windowRefine);
const holdsParams = z
  .object({
    status: z.string().min(1).max(32).optional(),
    subject_type: z.string().min(1).max(32).optional(),
  })
  .strict();
const paypalParams = z
  .object({
    ...windowFields,
    kind: z.enum(["capture", "refund", "payout"]).optional(),
  })
  .strict()
  .superRefine(windowRefine);

type WindowParams = { window: string; from?: string; to?: string };

/** Relative windows resolve against the server clock, inclusive of today (R13.12). */
export function resolveWindow(p: WindowParams, now: Date): DateRange {
  if (p.window === "custom") return validateDateRange(p.from, p.to);
  const days = p.window === "7d" ? 7 : p.window === "30d" ? 30 : 90;
  const end = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return validateDateRange(iso(end - (days - 1) * 86_400_000), iso(end));
}

// ── Intent implementations ────────────────────────────────────────────────────

type SpendDimension =
  | "mandate_id"
  | "agent_id"
  | "provider_id"
  | "category"
  | "day";

function spendIntent(
  name: string,
  dim: SpendDimension,
  description: string,
  chartType: "bar" | "line",
): ReadIntent {
  return {
    name,
    version: "1",
    description,
    roles: ["owner", "admin"],
    params: spendParams,
    columns: [
      { field: dim, type: "string" },
      { field: "currency", type: "string" },
      { field: "reserved_amount", type: "money" },
      { field: "charged_amount", type: "money" },
      { field: "released_amount", type: "money" },
      { field: "count", type: "integer" },
    ],
    chart: {
      type: chartType,
      x: dim,
      y: "charged_amount",
      groupBy: "currency",
    },
    async run(ctx, p: z.infer<typeof spendParams>) {
      const facts = await spendFacts(
        ctx.db,
        ctx.scope,
        resolveWindow(p, ctx.now),
      );
      const totals = new Map<
        string,
        {
          key: string | null;
          currency: string;
          r: Decimal;
          c: Decimal;
          d: Decimal;
          n: number;
        }
      >();
      for (const f of facts.rows) {
        if (p.currency && f.currency !== p.currency) continue;
        const key = (f as any)[dim] as string | null;
        const id = `${f.currency}\u0000${key ?? ""}`;
        const t = totals.get(id) ?? {
          key,
          currency: f.currency,
          r: new Decimal(0),
          c: new Decimal(0),
          d: new Decimal(0),
          n: 0,
        };
        t.r = t.r.plus(f.reserved_amount);
        t.c = t.c.plus(f.charged_amount);
        t.d = t.d.plus(f.released_amount);
        t.n += f.count;
        totals.set(id, t);
      }
      const rows = [...totals.values()]
        .sort((a, b) =>
          a.currency === b.currency
            ? dim === "day"
              ? (a.key ?? "").localeCompare(b.key ?? "")
              : b.c.comparedTo(a.c) || (a.key ?? "").localeCompare(b.key ?? "")
            : a.currency.localeCompare(b.currency),
        )
        .map((t) => ({
          [dim]: t.key,
          currency: t.currency,
          reserved_amount: t.r.toFixed(),
          charged_amount: t.c.toFixed(),
          released_amount: t.d.toFixed(),
          count: t.n,
        }));
      return { rows, truncated: facts.truncated };
    },
  };
}

const mandateListIntent: ReadIntent = {
  name: "mandate_list",
  version: "1",
  description: "List Mandates with their caps, status and expiry.",
  roles: ["owner", "admin"],
  params: mandateParams,
  columns: [
    { field: "mandate_id", type: "string" },
    { field: "currency", type: "string" },
    { field: "status", type: "string" },
    { field: "per_agreement_max", type: "money" },
    { field: "daily_cap", type: "money" },
    { field: "total_cap", type: "money" },
    { field: "expires_at", type: "timestamp" },
    { field: "created_at", type: "timestamp" },
  ],
  async run(ctx, p: z.infer<typeof mandateParams>) {
    const params: unknown[] = [ctx.scope.tenantId];
    let extra = "";
    if (ctx.scope.ownerUserId) {
      params.push(ctx.scope.ownerUserId);
      extra += ` AND owner_user_id = $${params.length}`;
    }
    if (p.status) {
      params.push(p.status);
      extra += ` AND status = $${params.length}`;
    }
    const res = await ctx.db.query<any>(
      `SELECT id::text AS mandate_id, currency, status,
              per_agreement_max::text AS per_agreement_max, daily_cap::text AS daily_cap,
              total_cap::text AS total_cap, expires_at, created_at
       FROM mandates WHERE tenant_id = $1 ${extra}
       ORDER BY created_at DESC, id`,
      params,
    );
    return {
      rows: res.rows.map((r) => ({
        ...r,
        per_agreement_max: money(r.per_agreement_max),
        daily_cap: money(r.daily_cap),
        total_cap: money(r.total_cap),
        expires_at: toIso(r.expires_at),
        created_at: toIso(r.created_at),
      })),
      truncated: false,
    };
  },
};

const mandateUtilizationIntent: ReadIntent = {
  name: "mandate_utilization",
  version: "1",
  description:
    "Mandate usage against total and daily caps, with remaining headroom.",
  roles: ["owner", "admin"],
  params: mandateParams,
  columns: [
    { field: "mandate_id", type: "string" },
    { field: "currency", type: "string" },
    { field: "status", type: "string" },
    { field: "usage", type: "money" },
    { field: "total_cap", type: "money" },
    { field: "today_usage", type: "money" },
    { field: "daily_cap", type: "money" },
    { field: "remaining", type: "money" },
  ],
  chart: { type: "bar", x: "mandate_id", y: "usage", groupBy: "currency" },
  async run(ctx, p: z.infer<typeof mandateParams>) {
    const r = await mandateUsage(ctx.db, ctx.scope, ctx.now, {
      status: p.status,
    });
    return { rows: r.rows as unknown as Row[], truncated: r.truncated };
  },
};

const proposalOutcomesIntent: ReadIntent = {
  name: "proposal_outcomes",
  version: "1",
  description: "Proposals by type and status with decision latency.",
  roles: ["owner", "admin"],
  params: proposalParams,
  columns: [
    { field: "type", type: "string" },
    { field: "status", type: "string" },
    { field: "count", type: "integer" },
    { field: "min_seconds", type: "integer" },
    { field: "median_seconds", type: "integer" },
    { field: "max_seconds", type: "integer" },
  ],
  chart: { type: "donut", x: "status", y: "count" },
  async run(ctx, p: z.infer<typeof proposalParams>) {
    const r = await proposalCounts(
      ctx.db,
      ctx.scope,
      resolveWindow(p, ctx.now),
    );
    const rows = p.type ? r.rows.filter((x) => x.type === p.type) : r.rows;
    return { rows: rows as unknown as Row[], truncated: r.truncated };
  },
};

const openAlertsIntent: ReadIntent = {
  name: "open_alerts",
  version: "1",
  description: "Currently open Watchdog alerts.",
  roles: ["admin"],
  params: openAlertParams,
  columns: [
    { field: "alert_id", type: "string" },
    { field: "detector", type: "string" },
    { field: "severity", type: "string" },
    { field: "subject_type", type: "string" },
    { field: "mandate_id", type: "string" },
    { field: "first_seen_at", type: "timestamp" },
    { field: "last_seen_at", type: "timestamp" },
  ],
  async run(ctx, p: z.infer<typeof openAlertParams>) {
    const params: unknown[] = [ctx.scope.tenantId];
    let extra = "";
    if (ctx.scope.ownerUserId) {
      params.push(ctx.scope.ownerUserId);
      extra += ` AND owner_user_id = $${params.length}`;
    }
    if (p.severity) {
      params.push(p.severity);
      extra += ` AND severity = $${params.length}`;
    }
    if (p.detector) {
      params.push(p.detector);
      extra += ` AND detector = $${params.length}`;
    }
    const res = await ctx.db.query<any>(
      `SELECT id::text AS alert_id, detector, severity, subject_type,
              mandate_id::text AS mandate_id, first_seen_at, last_seen_at
       FROM watchdog_alerts WHERE tenant_id = $1 AND status = 'open' ${extra}
       ORDER BY first_seen_at DESC, id`,
      params,
    );
    return {
      rows: res.rows.map((r) => ({
        ...r,
        first_seen_at: toIso(r.first_seen_at),
        last_seen_at: toIso(r.last_seen_at),
      })),
      truncated: false,
    };
  },
};

const alertsByDetectorIntent: ReadIntent = {
  name: "alerts_by_detector",
  version: "1",
  description: "Watchdog alert counts by detector and severity.",
  roles: ["admin"],
  params: alertsByDetectorParams,
  columns: [
    { field: "detector", type: "string" },
    { field: "severity", type: "string" },
    { field: "count", type: "integer" },
  ],
  chart: { type: "bar", x: "detector", y: "count" },
  async run(ctx, p: z.infer<typeof alertsByDetectorParams>) {
    const r = await alertCounts(ctx.db, ctx.scope, resolveWindow(p, ctx.now));
    const totals = new Map<
      string,
      { detector: string; severity: string; count: number }
    >();
    for (const a of r.rows) {
      if (p.severity && a.severity !== p.severity) continue;
      const id = `${a.detector}\u0000${a.severity}`;
      const t = totals.get(id) ?? {
        detector: a.detector,
        severity: a.severity,
        count: 0,
      };
      t.count += a.count;
      totals.set(id, t);
    }
    return { rows: [...totals.values()], truncated: r.truncated };
  },
};

const holdsSummaryIntent: ReadIntent = {
  name: "holds_summary",
  version: "1",
  description: "Holds by subject type and status.",
  roles: ["admin"],
  params: holdsParams,
  columns: [
    { field: "subject_type", type: "string" },
    { field: "status", type: "string" },
    { field: "count", type: "integer" },
  ],
  chart: { type: "bar", x: "subject_type", y: "count" },
  async run(ctx, p: z.infer<typeof holdsParams>) {
    const params: unknown[] = [ctx.scope.tenantId];
    let extra = "";
    if (p.status) {
      params.push(p.status);
      extra += ` AND status = $${params.length}`;
    }
    if (p.subject_type) {
      params.push(p.subject_type);
      extra += ` AND scope_type = $${params.length}`;
    }
    const res = await ctx.db.query<any>(
      `SELECT scope_type AS subject_type, status, COUNT(*)::int AS count
       FROM holds WHERE tenant_id = $1 ${extra}
       GROUP BY scope_type, status ORDER BY scope_type, status`,
      params,
    );
    return {
      rows: res.rows.map((r) => ({ ...r, count: Number(r.count) })),
      truncated: false,
    };
  },
};

const paypalFlowsIntent: ReadIntent = {
  name: "paypal_flows",
  version: "1",
  description:
    "PayPal captures, refunds and payouts by kind, status, day and currency.",
  roles: ["admin"],
  params: paypalParams,
  columns: [
    { field: "kind", type: "string" },
    { field: "status", type: "string" },
    { field: "day", type: "string" },
    { field: "currency", type: "string" },
    { field: "count", type: "integer" },
    { field: "amount", type: "money" },
    { field: "fee_amount", type: "money" },
    { field: "fee_state", type: "string" },
  ],
  chart: { type: "bar", x: "day", y: "amount", groupBy: "currency" },
  async run(ctx, p: z.infer<typeof paypalParams>) {
    const r = await paypalFlows(ctx.db, ctx.scope, resolveWindow(p, ctx.now));
    const rows = p.kind ? r.rows.filter((x) => x.kind === p.kind) : r.rows;
    return { rows: rows as unknown as Row[], truncated: r.truncated };
  },
};

function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

// ── Catalog ───────────────────────────────────────────────────────────────────

export const INTENT_CATALOG: readonly ReadIntent[] = Object.freeze([
  spendIntent(
    "spend_by_mandate",
    "mandate_id",
    "Spend grouped by Mandate.",
    "bar",
  ),
  spendIntent(
    "spend_by_agent",
    "agent_id",
    "Spend grouped by buyer agent.",
    "bar",
  ),
  spendIntent(
    "spend_by_provider",
    "provider_id",
    "Spend grouped by provider.",
    "bar",
  ),
  spendIntent(
    "spend_by_category",
    "category",
    "Spend grouped by service category.",
    "bar",
  ),
  spendIntent("spend_by_day", "day", "Spend grouped by UTC day.", "line"),
  mandateListIntent,
  mandateUtilizationIntent,
  proposalOutcomesIntent,
  openAlertsIntent,
  alertsByDetectorIntent,
  holdsSummaryIntent,
  paypalFlowsIntent,
]);

// A catalog that declares a recipient, email or payee column is a programming error.
for (const intent of INTENT_CATALOG) {
  for (const c of intent.columns) {
    if (FORBIDDEN_COLUMN_PATTERN.test(c.field)) {
      throw new Error(
        `Intent ${intent.name} declares forbidden column ${c.field}`,
      );
    }
  }
}

const BY_NAME: ReadonlyMap<string, ReadIntent> = new Map(
  INTENT_CATALOG.map((i) => [i.name, i]),
);

export function isCatalogIntent(name: string): boolean {
  return typeof name === "string" && BY_NAME.has(name);
}

export function getIntent(name: string): ReadIntent | undefined {
  return typeof name === "string" ? BY_NAME.get(name) : undefined;
}

/** Principal role to catalog role. Unknown roles (viewer, agent roles) map to nothing. */
export function catalogRoleFor(role: string): IntentRole | undefined {
  if (role === "owner" || role === "buyer") return "owner";
  if (role === "admin" || role === "operator" || role === "supervisor")
    return "admin";
  return undefined;
}

export function intentsForRole(role: string): ReadIntent[] {
  const r = catalogRoleFor(role);
  return r ? INTENT_CATALOG.filter((i) => i.roles.includes(r)) : [];
}
