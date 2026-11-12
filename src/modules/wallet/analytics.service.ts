/**
 * Wallet analytics (task 20.1; R14.1, R14.2, R14.3, R14.5, R14.8, R14.11).
 *
 * Read-only, typed grid datasets and chart datasets over the wallet tables and the ledger.
 *  - Paging is keyset based on (timestamp, id), so following `next_cursor` returns every
 *    authorized row exactly once even while new rows arrive. Pages hold at most 500 rows.
 *  - Scope: an Owner sees only rows of wallets that Owner owns. An Admin sees every wallet of
 *    the Admin's own tenant. Every query is filtered by the tenant first.
 *  - Money is a Decimal_Amount string. Rows carry `currency` and `paypal_environment`.
 *  - CSV is generated server side from the same pages, covers all authorized rows and neutralizes
 *    spreadsheet formulas with `csvSafeCell`.
 *  - Money boundary: no column here reads a payout recipient (`paypal_email` is never selected),
 *    and nothing here writes.
 */
import { Decimal } from "decimal.js";
import type { DbClient } from "../../db/connection.js";
import { ValidationError } from "../../common/errors.js";
import { csvEscape, csvSafeCell } from "./wallet-math.js";
import {
  configuredEnvironment,
  type PayPalEnvironment,
} from "./wallet.service.js";

export const MAX_ANALYTICS_PAGE = 500;

export const ANALYTICS_DATASETS = [
  "deposits",
  "reservations",
  "charges",
  "refunds",
  "payouts",
  "notifications",
  "reconciliation-exceptions",
  "ledger-lines",
  "statements",
] as const;
export type AnalyticsDataset = (typeof ANALYTICS_DATASETS)[number];

export const ANALYTICS_CHARTS = [
  "balance-over-time",
  "flows-per-day",
  "charges-per-mission",
  "budget-utilization",
  "deposit-status",
  "reconciliation-differences",
] as const;
export type AnalyticsChart = (typeof ANALYTICS_CHARTS)[number];

export const isAnalyticsDataset = (v: unknown): v is AnalyticsDataset =>
  typeof v === "string" &&
  (ANALYTICS_DATASETS as readonly string[]).includes(v);
export const isAnalyticsChart = (v: unknown): v is AnalyticsChart =>
  typeof v === "string" && (ANALYTICS_CHARTS as readonly string[]).includes(v);

/** Who is asking. `tenantId` and `userId` always come from the authenticated principal. */
export interface AnalyticsScope {
  tenantId: string;
  userId: string;
  /** operator or supervisor of `tenantId`: sees every wallet of the tenant */
  admin: boolean;
}

export type ColumnType = "string" | "money" | "timestamp" | "integer";
export interface AnalyticsColumn {
  name: string;
  type: ColumnType;
}
export type AnalyticsRow = Record<string, string | null>;

export interface DatasetPage {
  dataset: AnalyticsDataset;
  paypal_environment: PayPalEnvironment;
  columns: AnalyticsColumn[];
  rows: AnalyticsRow[];
  next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// Dataset definitions
// ---------------------------------------------------------------------------

const col = (name: string, type: ColumnType = "string"): AnalyticsColumn => ({
  name,
  type,
});
const ISO = (c: string) =>
  `to_char(${c} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const DAY = (c: string) => `to_char(${c} AT TIME ZONE 'UTC','YYYY-MM-DD')`;

/**
 * Inner selects expose `_ts` (timestamptz sort key), `id` (uuid tie-break) and the columns.
 * Params: $1 tenant, $2 user, $3 admin, $4 default environment.
 */
interface DatasetDef {
  columns: AnalyticsColumn[];
  inner: string;
}

const DEFS: Record<AnalyticsDataset, DatasetDef> = {
  deposits: {
    columns: [
      col("id"),
      col("wallet_id"),
      col("mission_id"),
      col("status"),
      col("amount", "money"),
      col("credited_amount", "money"),
      col("currency"),
      col("paypal_order_id"),
      col("paypal_capture_id"),
      col("paypal_environment"),
      col("created_at", "timestamp"),
    ],
    inner: `SELECT d.created_at AS _ts, d.id::text AS id, d.wallet_id::text AS wallet_id,
                   d.mission_id::text AS mission_id, d.status, d.amount::text AS amount,
                   d.credited_amount::text AS credited_amount, d.currency, d.paypal_order_id,
                   d.paypal_capture_id, d.paypal_environment, ${ISO("d.created_at")} AS created_at
              FROM wallet_deposits d
             WHERE d.tenant_id = $1 AND ($3::boolean OR d.owner_user_id = $2)`,
  },
  reservations: {
    columns: [
      col("id"),
      col("wallet_id"),
      col("mission_id"),
      col("agreement_id"),
      col("status"),
      col("amount", "money"),
      col("currency"),
      col("release_reason"),
      col("paypal_environment"),
      col("created_at", "timestamp"),
      col("closed_at", "timestamp"),
    ],
    inner: `SELECT r.created_at AS _ts, r.id::text AS id, r.wallet_id::text AS wallet_id,
                   r.mission_id::text AS mission_id, r.agreement_id::text AS agreement_id, r.status,
                   r.amount::text AS amount, r.currency, r.release_reason,
                   w.paypal_environment, ${ISO("r.created_at")} AS created_at,
                   ${ISO("r.closed_at")} AS closed_at
              FROM wallet_reservations r JOIN wallets w ON w.id = r.wallet_id
             WHERE r.tenant_id = $1 AND ($3::boolean OR w.owner_user_id = $2)`,
  },
  charges: {
    columns: [
      col("id"),
      col("wallet_id"),
      col("mission_id"),
      col("obligation_id"),
      col("agreement_id"),
      col("amount", "money"),
      col("released_difference", "money"),
      col("currency"),
      col("reason_code"),
      col("paypal_environment"),
      col("created_at", "timestamp"),
    ],
    inner: `SELECT c.created_at AS _ts, c.id::text AS id, c.wallet_id::text AS wallet_id,
                   c.mission_id::text AS mission_id, c.obligation_id::text AS obligation_id,
                   c.agreement_id::text AS agreement_id, c.amount::text AS amount,
                   c.released_difference::text AS released_difference, c.currency, c.reason_code,
                   w.paypal_environment, ${ISO("c.created_at")} AS created_at
              FROM wallet_charges c JOIN wallets w ON w.id = c.wallet_id
             WHERE c.tenant_id = $1 AND ($3::boolean OR w.owner_user_id = $2)`,
  },
  refunds: {
    columns: [
      col("id"),
      col("wallet_id"),
      col("mission_id"),
      col("kind"),
      col("status"),
      col("amount", "money"),
      col("currency"),
      col("paypal_refund_ids"),
      col("paypal_environment"),
      col("created_at", "timestamp"),
    ],
    inner: `SELECT r.created_at AS _ts, r.id::text AS id, r.wallet_id::text AS wallet_id,
                   r.mission_id::text AS mission_id, r.kind, r.status, r.amount::text AS amount,
                   r.currency,
                   COALESCE((SELECT string_agg(i.paypal_refund_id, ';' ORDER BY i.created_at, i.id)
                               FROM wallet_refund_items i
                              WHERE i.refund_id = r.id AND i.paypal_refund_id IS NOT NULL), '') AS paypal_refund_ids,
                   r.paypal_environment, ${ISO("r.created_at")} AS created_at
              FROM wallet_refunds r JOIN wallets w ON w.id = r.wallet_id
             WHERE r.tenant_id = $1 AND ($3::boolean OR w.owner_user_id = $2)`,
  },
  // The payout recipient (`paypal_email`) is deliberately not selected. An Owner sees a payout
  // only when every obligation paid to that provider in the batch belongs to the Owner's missions.
  payouts: {
    columns: [
      col("id"),
      col("batch_id"),
      col("agent_id"),
      col("status"),
      col("amount", "money"),
      col("currency"),
      col("provider_batch_id"),
      col("provider_item_id"),
      col("provider_item_status"),
      col("failure_reason"),
      col("paypal_environment"),
      col("created_at", "timestamp"),
      col("paid_at", "timestamp"),
    ],
    inner: `SELECT p.created_at AS _ts, p.id::text AS id, p.batch_id::text AS batch_id,
                   p.agent_id::text AS agent_id, p.status, p.amount::text AS amount, p.currency,
                   p.provider_batch_id, p.provider_item_id, p.provider_item_status, p.failure_reason,
                   $4::text AS paypal_environment, ${ISO("p.created_at")} AS created_at,
                   ${ISO("p.paid_at")} AS paid_at
              FROM payouts p
             WHERE p.tenant_id = $1
               AND ($3::boolean OR (
                     EXISTS (SELECT 1 FROM settlement_batch_items sbi
                               JOIN obligations o ON o.id = sbi.obligation_id
                               JOIN missions m ON m.id = o.mission_id
                               JOIN agents a ON a.id = m.buyer_id
                              WHERE sbi.batch_id = p.batch_id AND o.provider_id = p.agent_id
                                AND a.owner_user_id = $2)
                 AND NOT EXISTS (SELECT 1 FROM settlement_batch_items sbi
                               JOIN obligations o ON o.id = sbi.obligation_id
                               JOIN missions m ON m.id = o.mission_id
                               JOIN agents a ON a.id = m.buyer_id
                              WHERE sbi.batch_id = p.batch_id AND o.provider_id = p.agent_id
                                AND a.owner_user_id IS DISTINCT FROM $2)))`,
  },
  notifications: {
    columns: [
      col("id"),
      col("recipient_user_id"),
      col("kind"),
      col("title"),
      col("body"),
      col("entity_type"),
      col("entity_id"),
      col("mission_id"),
      col("paypal_environment"),
      col("created_at", "timestamp"),
      col("read_at", "timestamp"),
      col("resolved_at", "timestamp"),
    ],
    inner: `SELECT n.created_at AS _ts, n.id::text AS id, n.recipient_user_id::text AS recipient_user_id,
                   n.kind, n.title, n.body, n.entity_type, n.entity_id::text AS entity_id,
                   n.mission_id::text AS mission_id, $4::text AS paypal_environment,
                   ${ISO("n.created_at")} AS created_at, ${ISO("n.read_at")} AS read_at,
                   ${ISO("n.resolved_at")} AS resolved_at
              FROM notifications n
             WHERE n.tenant_id = $1 AND ($3::boolean OR n.recipient_user_id = $2)`,
  },
  // Reconciliation is tenant-wide business data with no wallet owner: Admin only.
  "reconciliation-exceptions": {
    columns: [
      col("id"),
      col("item_type"),
      col("paypal_id"),
      col("kind"),
      col("status"),
      col("currency"),
      col("stoat_amount", "money"),
      col("paypal_amount", "money"),
      col("difference", "money"),
      col("first_run_id"),
      col("last_run_id"),
      col("paypal_environment"),
      col("created_at", "timestamp"),
      col("resolved_at", "timestamp"),
    ],
    inner: `SELECT e.created_at AS _ts, e.id::text AS id, e.item_type, e.paypal_id, e.kind, e.status,
                   e.currency, e.stoat_amount::text AS stoat_amount,
                   e.paypal_amount::text AS paypal_amount, e.difference::text AS difference,
                   e.first_run_id::text AS first_run_id, e.last_run_id::text AS last_run_id,
                   COALESCE(rr.paypal_environment, $4::text) AS paypal_environment,
                   ${ISO("e.created_at")} AS created_at, ${ISO("e.resolved_at")} AS resolved_at
              FROM reconciliation_exceptions e
              LEFT JOIN reconciliation_runs rr ON rr.id = e.last_run_id
             WHERE e.tenant_id = $1 AND $3::boolean AND $2::uuid IS NOT NULL`,
  },
  "ledger-lines": {
    columns: [
      col("id"),
      col("transaction_id"),
      col("reference"),
      col("transaction_status"),
      col("account_code"),
      col("account_name"),
      col("wallet_id"),
      col("debit", "money"),
      col("credit", "money"),
      col("currency"),
      col("paypal_environment"),
      col("effective_at", "timestamp"),
    ],
    inner: `SELECT jt.effective_at AS _ts, jl.id::text AS id, jl.transaction_id::text AS transaction_id,
                   jt.reference, jt.status AS transaction_status, a.account_code, a.name AS account_name,
                   jl.wallet_id::text AS wallet_id, jl.debit::text AS debit, jl.credit::text AS credit,
                   jl.currency, COALESCE(w.paypal_environment, $4::text) AS paypal_environment,
                   ${ISO("jt.effective_at")} AS effective_at
              FROM journal_lines jl
              JOIN journal_transactions jt ON jt.id = jl.transaction_id
              JOIN accounts a ON a.id = jl.account_id
              LEFT JOIN wallets w ON w.id = jl.wallet_id
             WHERE jl.tenant_id = $1 AND ($3::boolean OR w.owner_user_id = $2)`,
  },
  // Wallet statements: every movement on account 2103, with the exact running balance per wallet.
  statements: {
    columns: [
      col("id"),
      col("wallet_id"),
      col("kind"),
      col("reference"),
      col("amount", "money"),
      col("balance_after", "money"),
      col("currency"),
      col("paypal_environment"),
      col("effective_at", "timestamp"),
    ],
    inner: `SELECT jt.effective_at AS _ts, jl.id::text AS id, jl.wallet_id::text AS wallet_id,
                   CASE WHEN jt.reference LIKE 'wallet:deposit:%' THEN 'deposit'
                        WHEN jt.reference LIKE 'wallet:charge:%' THEN 'charge'
                        WHEN jt.reference LIKE 'wallet:refund:%' THEN 'refund'
                        WHEN jt.reference LIKE 'reversal:%' THEN 'reversal'
                        ELSE 'adjustment' END AS kind,
                   jt.reference, (jl.credit - jl.debit)::text AS amount,
                   (SUM(jl.credit - jl.debit) OVER (
                       PARTITION BY jl.wallet_id
                       ORDER BY jt.effective_at, jt.posting_seq, jl.sequence, jl.id))::text AS balance_after,
                   jl.currency, w.paypal_environment, ${ISO("jt.effective_at")} AS effective_at
              FROM journal_lines jl
              JOIN journal_transactions jt ON jt.id = jl.transaction_id
              JOIN accounts a ON a.id = jl.account_id
              JOIN wallets w ON w.id = jl.wallet_id
             WHERE jl.tenant_id = $1 AND a.account_code = '2103'
               AND ($3::boolean OR w.owner_user_id = $2) AND $4::text IS NOT NULL`,
  },
};

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(t: string, id: string): string {
  return Buffer.from(JSON.stringify({ t, i: id })).toString("base64url");
}

function decodeCursor(cursor: unknown): { t: string; i: string } | null {
  if (cursor === undefined || cursor === null || cursor === "") return null;
  const bad = () => new ValidationError("Invalid cursor.", { field: "cursor" });
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(cursor))
    throw bad();
  try {
    const o = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      o &&
      typeof o.t === "string" &&
      ISO_RE.test(o.t) &&
      typeof o.i === "string" &&
      UUID_RE.test(o.i)
    )
      return { t: o.t, i: o.i };
  } catch {
    /* fall through */
  }
  throw bad();
}

function clampLimit(limit: unknown): number {
  if (limit === undefined || limit === null || limit === "")
    return MAX_ANALYTICS_PAGE;
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1)
    throw new ValidationError("limit must be a positive integer.", {
      field: "limit",
    });
  return Math.min(n, MAX_ANALYTICS_PAGE);
}

const normMoney = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Decimal(String(v)).toFixed();

// ---------------------------------------------------------------------------
// Grid datasets
// ---------------------------------------------------------------------------

export interface DatasetQuery {
  cursor?: string | null;
  /** at most 500; larger values are clamped */
  limit?: number;
  /** default environment label for rows that do not carry one */
  environment?: PayPalEnvironment;
}

export async function queryDataset(
  db: DbClient,
  scope: AnalyticsScope,
  dataset: AnalyticsDataset,
  q: DatasetQuery = {},
): Promise<DatasetPage> {
  if (!isAnalyticsDataset(dataset))
    throw new ValidationError("Unknown analytics dataset.", {
      field: "dataset",
    });
  const def = DEFS[dataset];
  const limit = clampLimit(q.limit);
  const cursor = decodeCursor(q.cursor);
  const env = q.environment ?? configuredEnvironment();

  const names = def.columns.map((c) => `s.${c.name}`).join(", ");
  const sql = `SELECT ${names}, s._ts_text
     FROM (SELECT x.*, ${ISO("x._ts")} AS _ts_text FROM (${def.inner}) x) s
    WHERE $1::uuid IS NOT NULL AND $2::uuid IS NOT NULL AND $3::boolean IS NOT NULL AND $4::text IS NOT NULL
      AND (NOT $5::boolean OR (s._ts, s.id::uuid) > ($6::timestamptz, $7::uuid))
    ORDER BY s._ts ASC, s.id::uuid ASC
    LIMIT $8`;
  const r = await db.query<Record<string, unknown>>(sql, [
    scope.tenantId,
    scope.userId,
    scope.admin,
    env,
    cursor !== null,
    cursor?.t ?? null,
    cursor?.i ?? null,
    limit + 1,
  ]);
  const page = r.rows.slice(0, limit);
  const rows = page.map((row) => {
    const out: AnalyticsRow = {};
    for (const c of def.columns) {
      const v = row[c.name];
      out[c.name] =
        c.type === "money"
          ? normMoney(v)
          : v === null || v === undefined
            ? null
            : String(v);
    }
    return out;
  });
  const last = page[page.length - 1] as Record<string, unknown> | undefined;
  return {
    dataset,
    paypal_environment: env,
    columns: def.columns,
    rows,
    next_cursor:
      r.rows.length > limit && last
        ? encodeCursor(String(last._ts_text), String(last.id))
        : null,
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export const csvLine = (cells: unknown[]): string =>
  cells.map((c) => csvEscape(csvSafeCell(c))).join(",") + "\r\n";

/**
 * Streams every authorized row as CSV chunks (header first), one page at a time. Money cells are
 * Decimal_Amount strings; each row carries its currency and PayPal environment where the dataset
 * has them. Cells starting with =, +, - or @ are prefixed so spreadsheets do not evaluate them.
 */
export async function* exportDatasetCsv(
  db: DbClient,
  scope: AnalyticsScope,
  dataset: AnalyticsDataset,
  opts: { pageSize?: number; environment?: PayPalEnvironment } = {},
): AsyncGenerator<string, void, undefined> {
  let cursor: string | null = null;
  let headerSent = false;
  do {
    const page: DatasetPage = await queryDataset(db, scope, dataset, {
      cursor,
      limit: opts.pageSize ?? MAX_ANALYTICS_PAGE,
      environment: opts.environment,
    });
    if (!headerSent) {
      yield csvLine(page.columns.map((c) => c.name));
      headerSent = true;
    }
    if (page.rows.length > 0) {
      let chunk = "";
      for (const row of page.rows)
        chunk += csvLine(page.columns.map((c) => row[c.name]));
      yield chunk;
    }
    cursor = page.next_cursor;
  } while (cursor !== null);
}

/** Convenience for small callers and tests: the whole CSV as one string. */
export async function exportDatasetCsvText(
  db: DbClient,
  scope: AnalyticsScope,
  dataset: AnalyticsDataset,
  opts: { pageSize?: number; environment?: PayPalEnvironment } = {},
): Promise<string> {
  let out = "";
  for await (const chunk of exportDatasetCsv(db, scope, dataset, opts))
    out += chunk;
  return out;
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

export type ChartPoint = Record<string, string | null>;
export interface ChartResult {
  chart: AnalyticsChart;
  paypal_environment: PayPalEnvironment;
  points: ChartPoint[];
}

const sortBy = (a: ChartPoint, b: ChartPoint, keys: string[]) => {
  for (const k of keys) {
    const x = a[k] ?? "";
    const y = b[k] ?? "";
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

export async function queryChart(
  db: DbClient,
  scope: AnalyticsScope,
  chart: AnalyticsChart,
  opts: { environment?: PayPalEnvironment } = {},
): Promise<ChartResult> {
  if (!isAnalyticsChart(chart))
    throw new ValidationError("Unknown analytics chart.", { field: "chart" });
  const env = opts.environment ?? configuredEnvironment();
  const params = [scope.tenantId, scope.userId, scope.admin, env];
  const ownerScope = `w.paypal_environment = $4 AND ($3::boolean OR w.owner_user_id = $2)`;
  let points: ChartPoint[] = [];

  switch (chart) {
    case "balance-over-time": {
      const r = await db.query<{ currency: string; day: string; net: string }>(
        `SELECT jl.currency, ${DAY("jt.effective_at")} AS day, SUM(jl.credit - jl.debit)::text AS net
           FROM journal_lines jl
           JOIN journal_transactions jt ON jt.id = jl.transaction_id
           JOIN accounts a ON a.id = jl.account_id
           JOIN wallets w ON w.id = jl.wallet_id
          WHERE jl.tenant_id = $1 AND a.account_code = '2103' AND ${ownerScope}
          GROUP BY 1, 2 ORDER BY 1, 2`,
        params,
      );
      const running = new Map<string, Decimal>();
      for (const row of r.rows) {
        const next = (running.get(row.currency) ?? new Decimal(0)).plus(
          row.net,
        );
        running.set(row.currency, next);
        points.push({
          date: row.day,
          currency: row.currency,
          balance: next.toFixed(),
          paypal_environment: env,
        });
      }
      break;
    }
    case "flows-per-day": {
      const dep = await db.query<{
        currency: string;
        day: string;
        amount: string;
      }>(
        `SELECT d.currency, ${DAY("d.captured_at")} AS day, SUM(d.credited_amount)::text AS amount
           FROM wallet_deposits d JOIN wallets w ON w.id = d.wallet_id
          WHERE d.tenant_id = $1 AND d.status = 'captured' AND d.captured_at IS NOT NULL AND ${ownerScope}
          GROUP BY 1, 2`,
        params,
      );
      const ref = await db.query<{
        currency: string;
        day: string;
        amount: string;
      }>(
        `SELECT r.currency, ${DAY("i.completed_at")} AS day, SUM(i.amount)::text AS amount
           FROM wallet_refund_items i
           JOIN wallet_refunds r ON r.id = i.refund_id
           JOIN wallets w ON w.id = r.wallet_id
          WHERE i.tenant_id = $1 AND i.status = 'completed' AND i.completed_at IS NOT NULL AND ${ownerScope}
          GROUP BY 1, 2`,
        params,
      );
      const byKey = new Map<string, ChartPoint>();
      const slot = (currency: string, day: string) => {
        const k = `${currency}|${day}`;
        let p = byKey.get(k);
        if (!p) {
          p = {
            date: day,
            currency,
            deposits: "0",
            refunds: "0",
            paypal_environment: env,
          };
          byKey.set(k, p);
        }
        return p;
      };
      for (const x of dep.rows)
        slot(x.currency, x.day).deposits = normMoney(x.amount);
      for (const x of ref.rows)
        slot(x.currency, x.day).refunds = normMoney(x.amount);
      points = [...byKey.values()].sort((a, b) =>
        sortBy(a, b, ["currency", "date"]),
      );
      break;
    }
    case "charges-per-mission": {
      const r = await db.query<{
        mission_id: string;
        title: string;
        currency: string;
        charged: string;
      }>(
        `SELECT c.mission_id::text AS mission_id, m.title, c.currency, SUM(c.amount)::text AS charged
           FROM wallet_charges c
           JOIN wallets w ON w.id = c.wallet_id
           JOIN missions m ON m.id = c.mission_id
          WHERE c.tenant_id = $1 AND ${ownerScope}
          GROUP BY c.mission_id, m.title, c.currency
          ORDER BY SUM(c.amount) DESC, c.mission_id
          LIMIT ${MAX_ANALYTICS_PAGE}`,
        params,
      );
      points = r.rows.map((x) => ({
        mission_id: x.mission_id,
        mission_title: x.title,
        currency: x.currency,
        charged: normMoney(x.charged),
        paypal_environment: env,
      }));
      break;
    }
    case "budget-utilization": {
      const r = await db.query<{
        id: string;
        title: string;
        currency: string;
        budget: string;
        charged: string;
        reserved: string;
      }>(
        `SELECT m.id::text AS id, m.title, m.currency, m.budget::text AS budget,
                COALESCE((SELECT SUM(c.amount) FROM wallet_charges c WHERE c.mission_id = m.id), 0)::text AS charged,
                COALESCE((SELECT SUM(r2.amount) FROM wallet_reservations r2
                           WHERE r2.mission_id = m.id AND r2.status = 'active'), 0)::text AS reserved
           FROM missions m
          WHERE m.tenant_id = $1
            AND EXISTS (SELECT 1 FROM wallet_reservations r
                          JOIN wallets w ON w.id = r.wallet_id
                         WHERE r.mission_id = m.id AND ${ownerScope})
          ORDER BY m.created_at, m.id
          LIMIT ${MAX_ANALYTICS_PAGE}`,
        params,
      );
      points = r.rows.map((x) => {
        const budget = new Decimal(x.budget);
        const used = new Decimal(x.charged).plus(x.reserved);
        return {
          mission_id: x.id,
          mission_title: x.title,
          currency: x.currency,
          budget: budget.toFixed(),
          charged: new Decimal(x.charged).toFixed(),
          reserved: new Decimal(x.reserved).toFixed(),
          utilization_percent: budget.isZero()
            ? "0"
            : used
                .div(budget)
                .times(100)
                .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
                .toFixed(),
          paypal_environment: env,
        };
      });
      break;
    }
    case "deposit-status": {
      const r = await db.query<{
        status: string;
        currency: string;
        n: string;
        amount: string;
      }>(
        `SELECT d.status, d.currency, count(*)::text AS n, SUM(d.amount)::text AS amount
           FROM wallet_deposits d JOIN wallets w ON w.id = d.wallet_id
          WHERE d.tenant_id = $1 AND ${ownerScope}
          GROUP BY d.status, d.currency ORDER BY d.currency, d.status`,
        params,
      );
      points = r.rows.map((x) => ({
        status: x.status,
        currency: x.currency,
        count: x.n,
        amount: normMoney(x.amount),
        paypal_environment: env,
      }));
      break;
    }
    case "reconciliation-differences": {
      // tenant-wide business data: an Owner gets an empty series, never another user's figures
      if (!scope.admin) break;
      const r = await db.query<{
        day: string;
        currency: string;
        n: string;
        net: string;
        gross: string;
      }>(
        `SELECT ${DAY("e.created_at")} AS day, COALESCE(e.currency, '') AS currency, count(*)::text AS n,
                COALESCE(SUM(e.difference), 0)::text AS net,
                COALESCE(SUM(ABS(e.difference)), 0)::text AS gross
           FROM reconciliation_exceptions e
           LEFT JOIN reconciliation_runs rr ON rr.id = e.last_run_id
          WHERE e.tenant_id = $1 AND $2::uuid IS NOT NULL AND $3::boolean
            AND COALESCE(rr.paypal_environment, $4::text) = $4::text
          GROUP BY 1, 2 ORDER BY 1, 2`,
        params,
      );
      points = r.rows.map((x) => ({
        date: x.day,
        currency: x.currency || null,
        exceptions: x.n,
        net_difference: normMoney(x.net),
        absolute_difference: normMoney(x.gross),
        paypal_environment: env,
      }));
      break;
    }
  }
  return { chart, paypal_environment: env, points };
}
