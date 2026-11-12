/**
 * Payments analytics read models (agentic-commerce design section 5).
 *
 * Every function is a tenant-scoped, parameterized, read-only aggregate. Column lists are
 * explicit (never `SELECT *`); no query selects `payouts.paypal_email` or any recipient, payee
 * or email column. No model output feeds any figure. Amounts leave as Decimal_Amount strings,
 * grouped per currency; nothing is summed across currencies.
 */
import { Decimal } from "decimal.js";
import type { DbClient } from "../../db/connection.js";
import { ForbiddenActionError } from "../../common/errors.js";
import type { AuthenticatedPrincipal } from "../../common/types.js";
import { InvalidDateRangeError } from "../agentic/commerce-errors.js";

export const ANALYTICS_ROLES = ["buyer", "operator", "supervisor"] as const;
export const ADMIN_ANALYTICS_ROLES = new Set(["operator", "supervisor"]);
export const MAX_RANGE_DAYS = 366;
export const GRID_ROW_CAP = 10_000;

/** Server-side scope. `ownerUserId` is set for an Owner and absent for an Admin. */
export interface AnalyticsScope {
  tenantId: string;
  role: string;
  ownerUserId?: string;
}

export interface DateRange {
  from: string;
  to: string;
}

export interface FactResult<R> {
  rows: R[];
  truncated: boolean;
  rowCountTotal: number;
}

/** Human roles buyer/operator/supervisor only; an agent, viewer or other role is refused. */
export function scopeFromPrincipal(
  principal: Pick<AuthenticatedPrincipal, "id" | "tenantId" | "type" | "role">,
): AnalyticsScope {
  if (
    principal.type !== "user" ||
    !(ANALYTICS_ROLES as readonly string[]).includes(principal.role)
  ) {
    throw new ForbiddenActionError();
  }
  return {
    tenantId: principal.tenantId,
    role: principal.role,
    ...(ADMIN_ANALYTICS_ROLES.has(principal.role)
      ? {}
      : { ownerUserId: principal.id }),
  };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDay(value: unknown): number {
  if (typeof value !== "string") throw new InvalidDateRangeError();
  const m = DATE_RE.exec(value);
  if (!m) throw new InvalidDateRangeError();
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const dt = new Date(ms);
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    throw new InvalidDateRangeError();
  }
  return ms;
}

/** Valid dates, start not after end, 1 to 366 days inclusive. */
export function validateDateRange(from: unknown, to: unknown): DateRange {
  const a = parseDay(from);
  const b = parseDay(to);
  if (a > b) throw new InvalidDateRangeError();
  const days = Math.round((b - a) / 86_400_000) + 1;
  if (days < 1 || days > MAX_RANGE_DAYS) throw new InvalidDateRangeError();
  return { from: from as string, to: to as string };
}

/** Decimal_Amount string without exponent or padding. */
export function money(value: unknown): string {
  return new Decimal(String(value ?? 0)).toFixed();
}

function moneyOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : money(value);
}

function cap<R>(rows: R[], limit = GRID_ROW_CAP): FactResult<R> {
  return {
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
    rowCountTotal: rows.length,
  };
}

const DAY = (col: string) => `(${col} AT TIME ZONE 'UTC')::date`;

// ── Spend facts ───────────────────────────────────────────────────────────────

export interface SpendFactRow {
  currency: string;
  mandate_id: string | null;
  agent_id: string;
  provider_id: string;
  category: string;
  day: string;
  reserved_amount: string;
  charged_amount: string;
  released_amount: string;
  count: number;
}

export async function spendFacts(
  db: DbClient,
  scope: AnalyticsScope,
  range: DateRange,
): Promise<FactResult<SpendFactRow>> {
  const params: unknown[] = [scope.tenantId, range.from, range.to];
  let owner = "";
  if (scope.ownerUserId) {
    params.push(scope.ownerUserId);
    owner = "AND w.owner_user_id = $4";
  }
  const joins = (alias: "r" | "c", agreementCol: string) => `
      JOIN wallets w ON w.id = ${alias}.wallet_id AND w.tenant_id = ${alias}.tenant_id
      JOIN agreements a ON a.id = ${alias}.${agreementCol}
      JOIN quotes q ON q.id = a.quote_id
      JOIN services s ON s.id = q.service_id`;
  const sql = `
    WITH facts AS (
      SELECT r.currency, a.mandate_id, a.buyer_id AS agent_id, a.provider_id, s.category,
             ${DAY("r.created_at")} AS day,
             r.amount AS reserved, 0::numeric AS charged, 0::numeric AS released, 1 AS cnt
      FROM wallet_reservations r ${joins("r", "agreement_id")}
      WHERE r.tenant_id = $1 ${owner}
      UNION ALL
      SELECT r.currency, a.mandate_id, a.buyer_id, a.provider_id, s.category,
             ${DAY("r.closed_at")}, 0::numeric, 0::numeric, r.amount, 0
      FROM wallet_reservations r ${joins("r", "agreement_id")}
      WHERE r.tenant_id = $1 ${owner} AND r.status = 'released' AND r.closed_at IS NOT NULL
      UNION ALL
      SELECT c.currency, a.mandate_id, a.buyer_id, a.provider_id, s.category,
             ${DAY("c.created_at")}, 0::numeric, c.amount, c.released_difference, 0
      FROM wallet_charges c ${joins("c", "agreement_id")}
      WHERE c.tenant_id = $1 ${owner}
    )
    SELECT currency, mandate_id::text AS mandate_id, agent_id::text AS agent_id,
           provider_id::text AS provider_id, category, to_char(day, 'YYYY-MM-DD') AS day,
           SUM(reserved)::text AS reserved_amount, SUM(charged)::text AS charged_amount,
           SUM(released)::text AS released_amount, SUM(cnt)::int AS count
    FROM facts
    WHERE day >= $2::date AND day <= $3::date
    GROUP BY currency, mandate_id, agent_id, provider_id, category, day
    ORDER BY currency, day, mandate_id NULLS FIRST, agent_id, provider_id, category`;
  const res = await db.query<any>(sql, params);
  return cap(
    res.rows.map((r) => ({
      currency: r.currency,
      mandate_id: r.mandate_id ?? null,
      agent_id: r.agent_id,
      provider_id: r.provider_id,
      category: r.category,
      day: r.day,
      reserved_amount: money(r.reserved_amount),
      charged_amount: money(r.charged_amount),
      released_amount: money(r.released_amount),
      count: Number(r.count),
    })),
  );
}

// ── Mandate usage ─────────────────────────────────────────────────────────────

export interface MandateUsageRow {
  mandate_id: string;
  currency: string;
  usage: string;
  total_cap: string;
  today_usage: string;
  daily_cap: string;
  remaining: string;
  status: string;
}

/** Same rules as `mandate-usage.ts`: active and charged Reservations, current UTC day. */
export async function mandateUsage(
  db: DbClient,
  scope: AnalyticsScope,
  now = new Date(),
  filter: { status?: string } = {},
): Promise<FactResult<MandateUsageRow>> {
  const midnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  const params: unknown[] = [scope.tenantId, midnight];
  let extra = "";
  if (scope.ownerUserId) {
    params.push(scope.ownerUserId);
    extra += ` AND m.owner_user_id = $${params.length}`;
  }
  if (filter.status) {
    params.push(filter.status);
    extra += ` AND m.status = $${params.length}`;
  }
  const res = await db.query<any>(
    `SELECT m.id::text AS mandate_id, m.currency, m.status,
            m.total_cap::text AS total_cap, m.daily_cap::text AS daily_cap,
            COALESCE(SUM(r.amount), 0)::text AS usage,
            COALESCE(SUM(r.amount) FILTER (WHERE r.created_at >= $2), 0)::text AS today_usage
     FROM mandates m
     LEFT JOIN wallet_reservations r
       ON r.mandate_id = m.id AND r.status IN ('active', 'charged')
     WHERE m.tenant_id = $1 ${extra}
     GROUP BY m.id, m.currency, m.status, m.total_cap, m.daily_cap, m.created_at
     ORDER BY m.currency, m.created_at, m.id`,
    params,
  );
  return cap(
    res.rows.map((r) => {
      const usage = new Decimal(r.usage);
      const today = new Decimal(r.today_usage);
      const remaining = Decimal.max(
        0,
        Decimal.min(
          new Decimal(r.total_cap).minus(usage),
          new Decimal(r.daily_cap).minus(today),
        ),
      );
      return {
        mandate_id: r.mandate_id,
        currency: r.currency,
        usage: usage.toFixed(),
        total_cap: money(r.total_cap),
        today_usage: today.toFixed(),
        daily_cap: money(r.daily_cap),
        remaining: remaining.toFixed(),
        status: r.status,
      };
    }),
  );
}

// ── Alerts, holds, proposals ──────────────────────────────────────────────────

export interface AlertCountRow {
  detector: string;
  severity: string;
  status: string;
  day: string;
  count: number;
}

export async function alertCounts(
  db: DbClient,
  scope: AnalyticsScope,
  range: DateRange,
): Promise<FactResult<AlertCountRow>> {
  const params: unknown[] = [scope.tenantId, range.from, range.to];
  let owner = "";
  if (scope.ownerUserId) {
    params.push(scope.ownerUserId);
    owner = "AND owner_user_id = $4";
  }
  const res = await db.query<any>(
    `SELECT detector, severity, status, to_char(${DAY("first_seen_at")}, 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS count
     FROM watchdog_alerts
     WHERE tenant_id = $1 ${owner}
       AND ${DAY("first_seen_at")} >= $2::date AND ${DAY("first_seen_at")} <= $3::date
     GROUP BY detector, severity, status, ${DAY("first_seen_at")}
     ORDER BY day, detector, severity, status`,
    params,
  );
  return cap(res.rows.map((r) => ({ ...r, count: Number(r.count) })));
}

export interface LatencyCountRow {
  type: string;
  status: string;
  count: number;
  min_seconds: number | null;
  median_seconds: number | null;
  max_seconds: number | null;
}

function latencyRows(rows: any[]): LatencyCountRow[] {
  const num = (v: unknown) =>
    v === null || v === undefined ? null : Number(v);
  return rows.map((r) => ({
    type: r.type,
    status: r.status,
    count: Number(r.count),
    min_seconds: num(r.min_seconds),
    median_seconds: num(r.median_seconds),
    max_seconds: num(r.max_seconds),
  }));
}

/** Holds by subject type and status, with latency from placement to release. */
export async function holdCounts(
  db: DbClient,
  scope: AnalyticsScope,
  range: DateRange,
): Promise<FactResult<LatencyCountRow>> {
  const params: unknown[] = [scope.tenantId, range.from, range.to];
  // An Owner sees only Holds on their own Reservations.
  let owner = "";
  if (scope.ownerUserId) {
    params.push(scope.ownerUserId);
    owner = `AND h.scope_type = 'reservation' AND EXISTS (
      SELECT 1 FROM wallet_reservations r JOIN wallets w
        ON w.id = r.wallet_id AND w.tenant_id = r.tenant_id
      WHERE r.id = h.scope_id AND r.tenant_id = h.tenant_id AND w.owner_user_id = $4)`;
  }
  const res = await db.query<any>(
    `SELECT h.scope_type AS type, h.status, COUNT(*)::int AS count,
            MIN(EXTRACT(EPOCH FROM (h.released_at - h.placed_at)))
              FILTER (WHERE h.released_at IS NOT NULL) AS min_seconds,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (h.released_at - h.placed_at)))
              FILTER (WHERE h.released_at IS NOT NULL) AS median_seconds,
            MAX(EXTRACT(EPOCH FROM (h.released_at - h.placed_at)))
              FILTER (WHERE h.released_at IS NOT NULL) AS max_seconds
     FROM holds h
     WHERE h.tenant_id = $1 ${owner}
       AND ${DAY("h.placed_at")} >= $2::date AND ${DAY("h.placed_at")} <= $3::date
     GROUP BY h.scope_type, h.status
     ORDER BY h.scope_type, h.status`,
    params,
  );
  return cap(latencyRows(res.rows));
}

/** Proposals by type and status, with latency from creation to decision. */
export async function proposalCounts(
  db: DbClient,
  scope: AnalyticsScope,
  range: DateRange,
): Promise<FactResult<LatencyCountRow>> {
  const params: unknown[] = [scope.tenantId, range.from, range.to];
  let owner = "";
  if (scope.ownerUserId) {
    params.push(scope.ownerUserId);
    owner = "AND owner_user_id = $4";
  }
  const res = await db.query<any>(
    `SELECT proposal_type AS type, status, COUNT(*)::int AS count,
            MIN(EXTRACT(EPOCH FROM (decided_at - created_at)))
              FILTER (WHERE decided_at IS NOT NULL) AS min_seconds,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (decided_at - created_at)))
              FILTER (WHERE decided_at IS NOT NULL) AS median_seconds,
            MAX(EXTRACT(EPOCH FROM (decided_at - created_at)))
              FILTER (WHERE decided_at IS NOT NULL) AS max_seconds
     FROM proposals
     WHERE tenant_id = $1 ${owner}
       AND ${DAY("created_at")} >= $2::date AND ${DAY("created_at")} <= $3::date
     GROUP BY proposal_type, status
     ORDER BY proposal_type, status`,
    params,
  );
  return cap(latencyRows(res.rows));
}

// ── PayPal flows ──────────────────────────────────────────────────────────────

export type FeeState = "known" | "partial" | "unknown";

export interface PaypalFlowRow {
  kind: "capture" | "refund" | "payout";
  status: string;
  day: string;
  currency: string;
  count: number;
  amount: string;
  fee_amount: string | null;
  fee_state: FeeState;
  fee_missing_count?: number;
}

/**
 * Captures carry a stored fee; refunds and payouts have none, so their fee_state is `unknown`
 * and `fee_amount` is null, never "0". Payouts are Admin-only and never expose the recipient.
 */
export async function paypalFlows(
  db: DbClient,
  scope: AnalyticsScope,
  range: DateRange,
): Promise<FactResult<PaypalFlowRow>> {
  const params: unknown[] = [scope.tenantId, range.from, range.to];
  let ownerDep = "";
  let ownerRef = "";
  let payoutBranch = `
      UNION ALL
      SELECT 'payout' AS kind, p.status, ${DAY("p.created_at")} AS day, p.currency,
             p.amount AS amount, NULL::numeric AS fee
      FROM payouts p
      WHERE p.tenant_id = $1`;
  if (scope.ownerUserId) {
    params.push(scope.ownerUserId);
    ownerDep = "AND d.owner_user_id = $4";
    ownerRef = "AND w.owner_user_id = $4";
    payoutBranch = "";
  }
  const res = await db.query<any>(
    `WITH flows AS (
       SELECT 'capture' AS kind, d.status, ${DAY("d.captured_at")} AS day,
              COALESCE(d.captured_currency, d.currency) AS currency,
              COALESCE(d.captured_amount, 0) AS amount, d.paypal_fee AS fee
       FROM wallet_deposits d
       WHERE d.tenant_id = $1 ${ownerDep} AND d.captured_at IS NOT NULL
       UNION ALL
       SELECT 'refund', i.status, ${DAY("i.created_at")}, f.currency, i.amount, NULL::numeric
       FROM wallet_refund_items i
       JOIN wallet_refunds f ON f.id = i.refund_id AND f.tenant_id = i.tenant_id
       JOIN wallets w ON w.id = f.wallet_id AND w.tenant_id = f.tenant_id
       WHERE i.tenant_id = $1 ${ownerRef}
       ${payoutBranch}
     )
     SELECT kind, status, to_char(day, 'YYYY-MM-DD') AS day, currency,
            COUNT(*)::int AS count, SUM(amount)::text AS amount,
            SUM(fee)::text AS fee_amount, COUNT(fee)::int AS fee_known
     FROM flows
     WHERE day >= $2::date AND day <= $3::date
     GROUP BY kind, status, day, currency
     ORDER BY currency, day, kind, status`,
    params,
  );
  return cap(
    res.rows.map((r) => {
      const count = Number(r.count);
      const known = Number(r.fee_known);
      const state: FeeState =
        known === 0 ? "unknown" : known === count ? "known" : "partial";
      const row: PaypalFlowRow = {
        kind: r.kind,
        status: r.status,
        day: r.day,
        currency: r.currency,
        count,
        amount: money(r.amount),
        fee_amount: state === "unknown" ? null : moneyOrNull(r.fee_amount),
        fee_state: state,
      };
      if (state === "partial") row.fee_missing_count = count - known;
      return row;
    }),
  );
}
