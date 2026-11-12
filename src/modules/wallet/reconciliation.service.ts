/**
 * ReconciliationService (task 17.1; R11.1-11.7, 11.11-11.15, 9.13-9.15, 9.19, 19.1).
 *
 * Compares what Stoat recorded (captured deposits, refund items, payouts) with what PayPal reports
 * for the same PayPal IDs. Every PayPal figure is fetched at run time through the gateway, outside
 * any database transaction. A local copy is never used as the PayPal figure, and nothing is
 * simulated: an item PayPal cannot confirm after all retries becomes an `unverifiable` exception
 * and the run `incomplete`.
 *
 * Read only for money (R11.12): a run writes only `reconciliation_*` rows, Admin notifications and
 * one Economic_Event. It never changes a Wallet_Balance, Reservation or journal line. The wallet
 * balance check (R9.15) runs for each wallet as part of the run; that check may block a wallet and
 * notify, which is not a balance write.
 *
 * Money boundary (AGENTS.md section 8): `startRun` takes a tenant and, for an Admin run, the
 * Admin's user ID. There is no agent entry point here; route-level guards come with task 17.2.
 *
 * Order of work: insert the run (partial unique index allows one `running` run per tenant) ->
 * read scope -> fetch each item from PayPal (initial call plus up to 3 retries, 30 s each) ->
 * one transaction that writes exceptions, balance checks, trial balance, notifications, the run
 * result and the Economic_Event.
 */
import { Decimal } from "decimal.js";
import { DbClient, getDb, transaction } from "../../db/connection.js";
import { ConflictError } from "../../common/errors.js";
import { EventsService } from "../events/events.service.js";
import {
  getPayPalGateway,
  type GatewayCapture,
  type GatewayPayout,
  type GatewayRefundState,
  type PayPalGateway,
} from "../paypal/paypal.gateway.js";
import { notifyInTx } from "./notification.service.js";
import {
  configuredEnvironment,
  runBalanceChecksForTenant,
} from "./wallet.service.js";

const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";

/** Initial call plus 3 retries (R11.5, R11.6). */
const FETCH_ATTEMPTS = 4;
/** A PayPal call that takes longer than this counts as failed (R11.5). */
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 250;
/** Pending longer than this is a `stale` exception on every run (R11.13). */
const STALE_AFTER_HOURS = 24;

/** PayPal capture statuses meaning the money is held. */
const CAPTURED_STATUSES = new Set([
  "COMPLETED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
]);

export type RunStatus =
  | "running"
  | "clean"
  | "differences"
  | "incomplete"
  | "failed";
export type ExceptionKind = "mismatch" | "unverifiable" | "stale";
export type ItemType = "deposit" | "capture" | "refund" | "payout";

export interface TrialBalanceRow {
  currency: string;
  debit: string;
  credit: string;
  /** debit - credit; zero when the books balance. */
  difference: string;
}

export interface RunCounts {
  orders: number;
  captures: number;
  refunds: number;
  payouts: number;
  new_exceptions: number;
  open_exceptions: number;
  resolved_exceptions: number;
  unverifiable: number;
  /** Per-currency totals Stoat recorded against totals PayPal confirmed (R11.1). */
  totals: Record<
    string,
    {
      captures: { stoat: string; paypal: string };
      refunds: { stoat: string; paypal: string };
      payouts: { stoat: string; paypal: string };
    }
  >;
}

export interface RunSummary {
  id: string;
  tenant_id: string;
  trigger: "schedule" | "admin";
  requested_by: string | null;
  status: RunStatus;
  paypal_environment: string;
  started_at: string;
  finished_at: string | null;
  counts: RunCounts;
  trial_balance: TrialBalanceRow[];
  trial_balance_mismatch: boolean;
  wallet_checks: { checked: number; blocked: number };
}

interface Observation {
  itemType: ItemType;
  paypalId: string;
  kind: ExceptionKind;
  currency: string | null;
  stoat: string | null;
  paypal: string | null;
  difference: string | null;
  detail: Record<string, unknown>;
}

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : String(v);
const key = (type: string, id: string) => `${type}:${id}`;
const dec = (v: string | number | null | undefined) => new Decimal(v ?? 0);

class FetchFailure extends Error {
  constructor(
    readonly code: string,
    readonly attempts: number,
  ) {
    super(code);
  }
}

export interface ReconciliationDeps {
  gateway?: PayPalGateway;
  db?: DbClient;
  /** Pause between retries. Tests pass 0. */
  retryDelayMs?: number;
  /** Per-call timeout. Tests may shorten it. */
  fetchTimeoutMs?: number;
}

/** Per-currency Trial_Balance over all posted journal lines of the tenant (R9.13, R9.14). */
export async function trialBalance(
  db: DbClient,
  tenantId: string,
): Promise<TrialBalanceRow[]> {
  const r = await db.query<{ currency: string; d: string; c: string }>(
    `SELECT jl.currency, COALESCE(SUM(jl.debit), 0)::text AS d, COALESCE(SUM(jl.credit), 0)::text AS c
       FROM journal_lines jl
       JOIN journal_transactions jt ON jt.id = jl.transaction_id
      WHERE jl.tenant_id = $1 AND jt.status = 'posted'
      GROUP BY jl.currency
      ORDER BY jl.currency`,
    [tenantId],
  );
  return r.rows.map((row) => ({
    currency: row.currency,
    debit: dec(row.d).toFixed(),
    credit: dec(row.c).toFixed(),
    difference: dec(row.d).minus(dec(row.c)).toFixed(),
  }));
}

export class ReconciliationService {
  private readonly gatewayOverride?: PayPalGateway;
  private readonly dbOverride?: DbClient;
  private readonly retryDelayMs: number;
  private readonly fetchTimeoutMs: number;

  constructor(deps: ReconciliationDeps = {}) {
    this.gatewayOverride = deps.gateway;
    this.dbOverride = deps.db;
    this.retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.fetchTimeoutMs = deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  }

  private get db(): DbClient {
    return this.dbOverride ?? getDb();
  }

  private get gateway(): PayPalGateway {
    return this.gatewayOverride ?? getPayPalGateway();
  }

  trialBalance(db: DbClient, tenantId: string): Promise<TrialBalanceRow[]> {
    return trialBalance(db, tenantId);
  }

  /**
   * Run one reconciliation for a tenant. Rejects with RECONCILIATION_IN_PROGRESS when a run is
   * already `running`, leaving that run unchanged (R11.11).
   */
  async startRun(
    tenantId: string,
    trigger: "schedule" | "admin",
    requestedBy?: string | null,
  ): Promise<RunSummary> {
    const gateway = this.gateway;
    const environment = gateway.environment ?? configuredEnvironment();
    const runId = await this.insertRun(
      tenantId,
      trigger,
      requestedBy ?? null,
      environment,
    );
    try {
      const scope = await this.loadScope(tenantId, environment);
      const result = await this.compare(gateway, scope);
      return await this.finalize(
        tenantId,
        runId,
        trigger,
        requestedBy ?? null,
        environment,
        result,
      );
    } catch (err) {
      await this.markFailed(runId);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Run row
  // -------------------------------------------------------------------------

  private async insertRun(
    tenantId: string,
    trigger: "schedule" | "admin",
    requestedBy: string | null,
    environment: string,
  ): Promise<string> {
    try {
      const r = await this.db.query<{ id: string }>(
        `INSERT INTO reconciliation_runs (tenant_id, trigger, requested_by, status, paypal_environment)
         VALUES ($1, $2, $3, 'running', $4) RETURNING id`,
        [tenantId, trigger, requestedBy, environment],
      );
      return r.rows[0].id;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (
        e.code === "23505" ||
        /uq_reconciliation_one_running/.test(e.message ?? "")
      ) {
        throw new ConflictError(
          "RECONCILIATION_IN_PROGRESS",
          "A reconciliation run is already in progress for this tenant.",
        );
      }
      throw err;
    }
  }

  private async markFailed(runId: string): Promise<void> {
    try {
      await this.db.query(
        `UPDATE reconciliation_runs SET status = 'failed', finished_at = now()
          WHERE id = $1 AND status = 'running'`,
        [runId],
      );
    } catch (err) {
      console.error(
        "[Reconciliation] could not mark run failed:",
        runId,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Scope (local reads only; these are the Stoat figures)
  // -------------------------------------------------------------------------

  private async loadScope(
    tenantId: string,
    environment: string,
  ): Promise<Scope> {
    const q = <T>(sql: string, p: unknown[]) =>
      this.db.query<T>(sql, p).then((r) => r.rows);
    const [captures, orders, refunds, payouts, staleDeposits, staleRefunds] =
      await Promise.all([
        q<any>(
          `SELECT id, paypal_capture_id, status, amount, currency, captured_amount, captured_currency
           FROM wallet_deposits
          WHERE tenant_id = $1 AND paypal_environment = $2 AND paypal_capture_id IS NOT NULL
          ORDER BY created_at, id`,
          [tenantId, environment],
        ),
        q<any>(
          `SELECT id, paypal_order_id, status, amount, currency
           FROM wallet_deposits
          WHERE tenant_id = $1 AND paypal_environment = $2 AND paypal_order_id IS NOT NULL
            AND paypal_capture_id IS NULL AND status IN ('awaiting_approval', 'awaiting_capture')
          ORDER BY created_at, id`,
          [tenantId, environment],
        ),
        q<any>(
          `SELECT i.id, i.paypal_refund_id, i.status, i.amount, r.currency
           FROM wallet_refund_items i JOIN wallet_refunds r ON r.id = i.refund_id
          WHERE i.tenant_id = $1 AND r.paypal_environment = $2 AND i.paypal_refund_id IS NOT NULL
          ORDER BY i.created_at, i.id`,
          [tenantId, environment],
        ),
        q<any>(
          `SELECT id, provider_batch_id, sender_item_id, status, amount, currency
           FROM payouts
          WHERE tenant_id = $1 AND provider_batch_id IS NOT NULL
            AND status IN ('processing', 'paid', 'failed', 'returned')
          ORDER BY created_at, id`,
          [tenantId],
        ),
        q<any>(
          `SELECT id, paypal_capture_id, paypal_order_id, paypal_request_id, status, amount, currency, created_at
           FROM wallet_deposits
          WHERE tenant_id = $1 AND paypal_environment = $2
            AND status IN ('awaiting_approval', 'awaiting_capture')
            AND created_at < now() - ($3::int * interval '1 hour')`,
          [tenantId, environment, STALE_AFTER_HOURS],
        ),
        q<any>(
          `SELECT i.id, i.paypal_refund_id, i.paypal_request_id, i.status, i.amount, r.currency, i.created_at
           FROM wallet_refund_items i JOIN wallet_refunds r ON r.id = i.refund_id
          WHERE i.tenant_id = $1 AND r.paypal_environment = $2
            AND i.status IN ('submitted', 'pending')
            AND i.created_at < now() - ($3::int * interval '1 hour')`,
          [tenantId, environment, STALE_AFTER_HOURS],
        ),
      ]);
    return { captures, orders, refunds, payouts, staleDeposits, staleRefunds };
  }

  // -------------------------------------------------------------------------
  // PayPal fetch: initial call + 3 retries, 30 s timeout, no transaction open
  // -------------------------------------------------------------------------

  private async fetchWithRetries<T>(fn: () => Promise<T>): Promise<T> {
    let code = "PAYPAL_ERROR";
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          fn(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Object.assign(new Error("timeout"), {
                    code: "PAYPAL_TIMEOUT",
                  }),
                ),
              this.fetchTimeoutMs,
            );
          }),
        ]);
      } catch (err) {
        code =
          typeof (err as { code?: unknown })?.code === "string"
            ? (err as { code: string }).code
            : "PAYPAL_ERROR";
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (attempt < FETCH_ATTEMPTS && this.retryDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.retryDelayMs));
      }
    }
    throw new FetchFailure(code, FETCH_ATTEMPTS);
  }

  // -------------------------------------------------------------------------
  // Comparison (Decimal arithmetic throughout)
  // -------------------------------------------------------------------------

  private async compare(
    gateway: PayPalGateway,
    scope: Scope,
  ): Promise<Comparison> {
    const out: Comparison = {
      observations: [],
      fetchedOk: new Set(),
      counts: { orders: 0, captures: 0, refunds: 0, payouts: 0 },
      totals: {},
    };
    const total = (
      cur: string,
      group: "captures" | "refunds" | "payouts",
      side: "stoat" | "paypal",
      v: Decimal,
    ) => {
      const t = (out.totals[cur] ??= {
        captures: { stoat: dec(0), paypal: dec(0) },
        refunds: { stoat: dec(0), paypal: dec(0) },
        payouts: { stoat: dec(0), paypal: dec(0) },
      });
      t[group][side] = t[group][side].plus(v);
    };
    const unverifiable = (
      itemType: ItemType,
      paypalId: string,
      currency: string | null,
      stoat: string | null,
      detail: Record<string, unknown>,
    ) =>
      out.observations.push({
        itemType,
        paypalId,
        kind: "unverifiable",
        currency,
        stoat,
        paypal: null,
        difference: null,
        detail,
      });
    const fail = (
      itemType: ItemType,
      id: string,
      currency: string | null,
      stoat: string | null,
      err: unknown,
    ) => {
      const f =
        err instanceof FetchFailure ? err : new FetchFailure("PAYPAL_ERROR", 1);
      unverifiable(itemType, id, currency, stoat, {
        reason: "fetch_failed",
        error_code: f.code,
        attempts: f.attempts,
      });
    };
    const mismatch = (
      itemType: ItemType,
      id: string,
      currency: string | null,
      stoat: Decimal | null,
      paypal: Decimal | null,
      detail: Record<string, unknown>,
    ) =>
      out.observations.push({
        itemType,
        paypalId: id,
        kind: "mismatch",
        currency,
        stoat: stoat ? stoat.toFixed() : null,
        paypal: paypal ? paypal.toFixed() : null,
        difference: stoat && paypal ? stoat.minus(paypal).toFixed() : null,
        detail,
      });

    // Captures of deposits Stoat holds a capture ID for.
    for (const d of scope.captures) {
      const id = String(d.paypal_capture_id);
      out.counts.captures++;
      let pp: GatewayCapture;
      try {
        pp = await this.fetchWithRetries(() => gateway.getCapture(id));
      } catch (err) {
        fail("capture", id, d.captured_currency ?? d.currency, null, err);
        continue;
      }
      if (
        pp.amount == null ||
        pp.currency == null ||
        pp.captureStatus == null
      ) {
        unverifiable("capture", id, d.currency, null, {
          reason: "paypal_returned_incomplete_record",
        });
        continue;
      }
      out.fetchedOk.add(key("capture", id));
      const stoatCaptured = d.status === "captured";
      const ppCaptured = CAPTURED_STATUSES.has(pp.captureStatus);
      const stoatCur = String(d.captured_currency ?? d.currency);
      const stoatAmt = stoatCaptured
        ? dec(d.captured_amount ?? d.amount)
        : dec(0);
      const ppAmt = ppCaptured ? dec(pp.amount) : dec(0);
      if (stoatCaptured) total(stoatCur, "captures", "stoat", stoatAmt);
      if (ppCaptured) total(pp.currency, "captures", "paypal", ppAmt);
      const currencyDiffers =
        (stoatCaptured || ppCaptured) && stoatCur !== pp.currency;
      if (
        !stoatAmt.eq(ppAmt) ||
        currencyDiffers ||
        stoatCaptured !== ppCaptured
      ) {
        mismatch(
          "capture",
          id,
          stoatCaptured ? stoatCur : pp.currency,
          stoatAmt,
          ppAmt,
          {
            deposit_id: d.id,
            stoat_status: d.status,
            paypal_status: pp.captureStatus,
            stoat_currency: stoatCur,
            paypal_currency: pp.currency,
          },
        );
      }
    }

    // Orders not yet captured in Stoat: PayPal must not hold money Stoat has not credited.
    for (const d of scope.orders) {
      const id = String(d.paypal_order_id);
      out.counts.orders++;
      let pp: GatewayCapture;
      try {
        pp = await this.fetchWithRetries(() => gateway.getOrder(id));
      } catch (err) {
        fail("deposit", id, d.currency, null, err);
        continue;
      }
      out.fetchedOk.add(key("deposit", id));
      const ppCaptured =
        pp.captureStatus != null && CAPTURED_STATUSES.has(pp.captureStatus);
      if (ppCaptured) {
        if (pp.amount == null || pp.currency == null) {
          unverifiable("deposit", id, d.currency, null, {
            reason: "paypal_returned_incomplete_record",
          });
          out.fetchedOk.delete(key("deposit", id));
          continue;
        }
        total(pp.currency, "captures", "paypal", dec(pp.amount));
        mismatch("deposit", id, pp.currency, dec(0), dec(pp.amount), {
          deposit_id: d.id,
          stoat_status: d.status,
          paypal_order_status: pp.orderStatus,
          paypal_capture_id: pp.captureId,
        });
      }
    }

    // Refund items with a PayPal refund ID.
    for (const it of scope.refunds) {
      const id = String(it.paypal_refund_id);
      out.counts.refunds++;
      let pp: GatewayRefundState;
      try {
        pp = await this.fetchWithRetries(() => gateway.getRefund(id));
      } catch (err) {
        fail("refund", id, it.currency, dec(it.amount).toFixed(), err);
        continue;
      }
      if (pp.amount == null || pp.currency == null) {
        unverifiable("refund", id, it.currency, dec(it.amount).toFixed(), {
          reason: "paypal_returned_incomplete_record",
        });
        continue;
      }
      out.fetchedOk.add(key("refund", id));
      const stoatClass = refundClass(String(it.status));
      const ppClass = refundClass(pp.status);
      const stoatAmt = dec(it.amount);
      const ppAmt = dec(pp.amount);
      if (stoatClass === "COMPLETED")
        total(String(it.currency), "refunds", "stoat", stoatAmt);
      if (ppClass === "COMPLETED")
        total(pp.currency, "refunds", "paypal", ppAmt);
      if (
        !stoatAmt.eq(ppAmt) ||
        it.currency !== pp.currency ||
        stoatClass !== ppClass
      ) {
        mismatch("refund", id, String(it.currency), stoatAmt, ppAmt, {
          refund_item_id: it.id,
          stoat_status: it.status,
          paypal_status: pp.status,
          stoat_currency: it.currency,
          paypal_currency: pp.currency,
        });
      }
    }

    // Payouts: the gateway reports batch and item status only, so the status is what is compared.
    const batchCache = new Map<string, GatewayPayout | FetchFailure>();
    for (const p of scope.payouts) {
      const id = String(p.provider_batch_id);
      out.counts.payouts++;
      let batch = batchCache.get(id);
      if (!batch) {
        try {
          batch = await this.fetchWithRetries(() => gateway.getPayout(id));
        } catch (err) {
          batch =
            err instanceof FetchFailure
              ? err
              : new FetchFailure("PAYPAL_ERROR", 1);
        }
        batchCache.set(id, batch);
      }
      const stoatAmtS = dec(p.amount).toFixed();
      if (batch instanceof FetchFailure) {
        fail("payout", id, String(p.currency), stoatAmtS, batch);
        continue;
      }
      const item =
        batch.items.find((i) => i.senderItemId === p.sender_item_id) ??
        (batch.items.length === 1 ? batch.items[0] : undefined);
      if (!item) {
        unverifiable("payout", id, String(p.currency), stoatAmtS, {
          reason: "item_not_in_paypal_batch",
        });
        continue;
      }
      out.fetchedOk.add(key("payout", id));
      const ppStatus = payoutClass(item.status);
      const stoatStatus = String(p.status);
      if (stoatStatus === "paid")
        total(String(p.currency), "payouts", "stoat", dec(p.amount));
      if (ppStatus === "paid")
        total(String(p.currency), "payouts", "paypal", dec(p.amount));
      if (ppStatus !== stoatStatus) {
        out.observations.push({
          itemType: "payout",
          paypalId: id,
          kind: "mismatch",
          currency: String(p.currency),
          stoat: stoatAmtS,
          paypal: null,
          difference: null,
          detail: {
            payout_id: p.id,
            stoat_status: stoatStatus,
            paypal_item_status: item.status,
            note: "PayPal reports no payout amount through the gateway; status compared",
          },
        });
      }
    }

    // Stale: pending for over 24 hours, on every run until terminal (R11.13). Local state only.
    for (const d of scope.staleDeposits) {
      const id = String(
        d.paypal_capture_id ?? d.paypal_order_id ?? d.paypal_request_id,
      );
      out.observations.push({
        itemType: "deposit",
        paypalId: id,
        kind: "stale",
        currency: String(d.currency),
        stoat: dec(d.amount).toFixed(),
        paypal: null,
        difference: null,
        detail: {
          deposit_id: d.id,
          status: d.status,
          pending_since: iso(d.created_at),
        },
      });
    }
    for (const it of scope.staleRefunds) {
      const id = String(it.paypal_refund_id ?? it.paypal_request_id);
      out.observations.push({
        itemType: "refund",
        paypalId: id,
        kind: "stale",
        currency: String(it.currency),
        stoat: dec(it.amount).toFixed(),
        paypal: null,
        difference: null,
        detail: {
          refund_item_id: it.id,
          status: it.status,
          pending_since: iso(it.created_at),
        },
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Finalize: one transaction
  // -------------------------------------------------------------------------

  private async finalize(
    tenantId: string,
    runId: string,
    trigger: "schedule" | "admin",
    requestedBy: string | null,
    environment: string,
    cmp: Comparison,
  ): Promise<RunSummary> {
    return transaction(async (tx) => {
      // Wallet balance check for every wallet (R9.15, R9.19). May block and notify; never rewrites a balance.
      const checks = await runBalanceChecksForTenant(tx, tenantId);

      const observedKeys = new Set<string>();
      let created = 0;
      for (const o of cmp.observations) {
        observedKeys.add(`${o.itemType}:${o.paypalId}:${o.kind}`);
        const upd = await tx.query(
          `UPDATE reconciliation_exceptions
              SET last_run_id = $5, currency = $6, stoat_amount = $7, paypal_amount = $8,
                  difference = $9, detail = $10::jsonb
            WHERE tenant_id = $1 AND item_type = $2 AND paypal_id = $3 AND kind = $4 AND status = 'open'
            RETURNING id`,
          [
            tenantId,
            o.itemType,
            o.paypalId,
            o.kind,
            runId,
            o.currency,
            o.stoat,
            o.paypal,
            o.difference,
            JSON.stringify(o.detail),
          ],
        );
        if (upd.rows[0]) continue;
        await tx.query(
          `INSERT INTO reconciliation_exceptions
             (tenant_id, first_run_id, last_run_id, item_type, paypal_id, kind, currency,
              stoat_amount, paypal_amount, difference, detail)
           VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
          [
            tenantId,
            runId,
            o.itemType,
            o.paypalId,
            o.kind,
            o.currency,
            o.stoat,
            o.paypal,
            o.difference,
            JSON.stringify(o.detail),
          ],
        );
        created++;
      }

      // Resolve (R11.14): an open exception that no longer differs, history kept.
      const open = await tx.query<{
        id: string;
        item_type: string;
        paypal_id: string;
        kind: string;
      }>(
        `SELECT id, item_type, paypal_id, kind FROM reconciliation_exceptions
          WHERE tenant_id = $1 AND status = 'open'`,
        [tenantId],
      );
      let resolved = 0;
      for (const e of open.rows) {
        if (observedKeys.has(`${e.item_type}:${e.paypal_id}:${e.kind}`))
          continue;
        const cleared =
          e.kind === "stale"
            ? true
            : cmp.fetchedOk.has(key(e.item_type, e.paypal_id));
        if (!cleared) continue;
        await tx.query(
          `UPDATE reconciliation_exceptions
              SET status = 'resolved', resolved_at = now(), resolved_run_id = $2
            WHERE id = $1 AND status = 'open'`,
          [e.id, runId],
        );
        resolved++;
      }
      const stillOpen = open.rows.length - resolved;

      const unverifiable = cmp.observations.filter(
        (o) => o.kind === "unverifiable",
      ).length;
      const differences = cmp.observations.filter(
        (o) => o.kind !== "unverifiable",
      ).length;
      // Clean only when nothing differs and nothing was unreachable (R11.4, R11.7).
      const status: RunStatus =
        unverifiable > 0
          ? "incomplete"
          : differences > 0
            ? "differences"
            : "clean";

      const tb = await trialBalance(tx, tenantId);
      const tbMismatch = tb.some((r) => !dec(r.difference).isZero());

      const totals: RunCounts["totals"] = {};
      for (const [cur, t] of Object.entries(cmp.totals)) {
        totals[cur] = {
          captures: {
            stoat: t.captures.stoat.toFixed(),
            paypal: t.captures.paypal.toFixed(),
          },
          refunds: {
            stoat: t.refunds.stoat.toFixed(),
            paypal: t.refunds.paypal.toFixed(),
          },
          payouts: {
            stoat: t.payouts.stoat.toFixed(),
            paypal: t.payouts.paypal.toFixed(),
          },
        };
      }
      const counts: RunCounts = {
        ...cmp.counts,
        new_exceptions: created,
        open_exceptions: stillOpen + created,
        resolved_exceptions: resolved,
        unverifiable,
        totals,
      };

      // One Admin notification per run listing the new exceptions (R11.3).
      if (created > 0) {
        await notifyInTx(tx, {
          tenantId,
          kind: "reconciliation_exception",
          recipient: { admins: true },
          title: "Reconciliation found exceptions",
          body: `Reconciliation run found ${created} new exception${created === 1 ? "" : "s"}. Review them on the reconciliation page.`,
          entityType: "reconciliation_run",
          entityId: runId,
          eventId: `reconciliation_exception:${runId}`,
        });
      }
      if (tbMismatch) {
        const cur = tb
          .filter((r) => !dec(r.difference).isZero())
          .map((r) => r.currency)
          .join(", ");
        await notifyInTx(tx, {
          tenantId,
          kind: "trial_balance_mismatch",
          recipient: { admins: true },
          title: "Trial balance mismatch",
          body: `Debits and credits differ for ${cur}. Nothing was posted. Review the journal.`,
          entityType: "reconciliation_run",
          entityId: runId,
          eventId: `trial_balance_mismatch:${runId}`,
        });
      }

      const fin = await tx.query<{
        started_at: Date | string;
        finished_at: Date | string;
      }>(
        `UPDATE reconciliation_runs
            SET status = $2, counts = $3::jsonb, trial_balance = $4::jsonb, finished_at = now()
          WHERE id = $1 AND status = 'running'
          RETURNING started_at, finished_at`,
        [runId, status, JSON.stringify(counts), JSON.stringify(tb)],
      );
      if (!fin.rows[0]) {
        // The sweep failed this run while it executed; do not overwrite or record a result.
        throw new ConflictError(
          "RECONCILIATION_RUN_NOT_RUNNING",
          "The run is no longer running.",
        );
      }

      // One Economic_Event per succeeded run, in the same transaction as the result (R19.1).
      await new EventsService(tx).appendEvent({
        tenantId,
        aggregateType: "reconciliation_run",
        aggregateId: runId,
        eventType: "RECONCILIATION_RUN_COMPLETED",
        actorType: trigger === "admin" && requestedBy ? "user" : "system",
        actorId:
          trigger === "admin" && requestedBy ? requestedBy : SYSTEM_ACTOR,
        payload: {
          run_id: runId,
          trigger,
          status,
          paypal_environment: environment,
          counts: {
            orders: counts.orders,
            captures: counts.captures,
            refunds: counts.refunds,
            payouts: counts.payouts,
            new_exceptions: created,
            resolved_exceptions: resolved,
            unverifiable,
          },
          trial_balance_mismatch: tbMismatch,
        },
      });

      return {
        id: runId,
        tenant_id: tenantId,
        trigger,
        requested_by: requestedBy,
        status,
        paypal_environment: environment,
        started_at: iso(fin.rows[0].started_at),
        finished_at: iso(fin.rows[0].finished_at),
        counts,
        trial_balance: tb,
        trial_balance_mismatch: tbMismatch,
        wallet_checks: {
          checked: checks.length,
          blocked: checks.filter((c) => c.outcome === "blocked").length,
        },
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Scope {
  captures: any[];
  orders: any[];
  refunds: any[];
  payouts: any[];
  staleDeposits: any[];
  staleRefunds: any[];
}

interface Comparison {
  observations: Observation[];
  /** `type:id` of items PayPal answered for; only these can clear a mismatch or unverifiable exception. */
  fetchedOk: Set<string>;
  counts: {
    orders: number;
    captures: number;
    refunds: number;
    payouts: number;
  };
  totals: Record<
    string,
    {
      captures: { stoat: Decimal; paypal: Decimal };
      refunds: { stoat: Decimal; paypal: Decimal };
      payouts: { stoat: Decimal; paypal: Decimal };
    }
  >;
}

/** Common class for a refund status on either side. Unknown PayPal statuses stay as reported. */
function refundClass(status: string): string {
  switch (status.toUpperCase()) {
    case "COMPLETED":
      return "COMPLETED";
    case "PLANNED":
    case "SUBMITTED":
    case "PENDING":
      return "PENDING";
    case "FAILED":
    case "CANCELLED":
    case "CANCELED":
      return "FAILED";
    default:
      return status.toUpperCase();
  }
}

/** Map PayPal's per-item payout status to Stoat's payout status (same rule as PayoutService). */
function payoutClass(
  status: string,
): "paid" | "processing" | "failed" | "returned" {
  switch (status) {
    case "SUCCESS":
      return "paid";
    case "FAILED":
    case "BLOCKED":
    case "DENIED":
    case "CANCELED":
      return "failed";
    case "RETURNED":
    case "REFUNDED":
    case "REVERSED":
      return "returned";
    default:
      return "processing";
  }
}

// ---------------------------------------------------------------------------
// Reads and scheduling (task 17.2). Tenant-scoped; no money is touched.
// ---------------------------------------------------------------------------

export async function listRuns(
  db: DbClient,
  tenantId: string,
  limit: number,
  offset: number,
): Promise<{ runs: any[]; hasMore: boolean }> {
  const r = await db.query(
    `SELECT * FROM reconciliation_runs WHERE tenant_id = $1
      ORDER BY started_at DESC, id LIMIT $2 OFFSET $3`,
    [tenantId, limit + 1, offset],
  );
  return { runs: r.rows.slice(0, limit), hasMore: r.rows.length > limit };
}

export async function getRun(
  db: DbClient,
  tenantId: string,
  runId: string,
): Promise<{ run: any; exceptions: any[] } | null> {
  const r = await db.query(
    `SELECT * FROM reconciliation_runs WHERE id = $1 AND tenant_id = $2`,
    [runId, tenantId],
  );
  if (!r.rows[0]) return null;
  const e = await db.query(
    `SELECT * FROM reconciliation_exceptions
      WHERE tenant_id = $1 AND (first_run_id = $2 OR last_run_id = $2 OR resolved_run_id = $2)
      ORDER BY created_at, id`,
    [tenantId, runId],
  );
  return { run: r.rows[0], exceptions: e.rows };
}

export async function listExceptions(
  db: DbClient,
  tenantId: string,
  status: "open" | "resolved" | null,
  limit: number,
  offset: number,
): Promise<{ exceptions: any[]; hasMore: boolean }> {
  const r = await db.query(
    `SELECT * FROM reconciliation_exceptions
      WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`,
    [tenantId, status, limit + 1, offset],
  );
  return {
    exceptions: r.rows.slice(0, limit),
    hasMore: r.rows.length > limit,
  };
}

/**
 * Queue one `wallet_reconciliation` job for each tenant that has wallets and has had none queued
 * within `intervalMs` (R11.8). The job-created-at throttle also covers a run that was refused as
 * already in progress.
 */
export async function enqueueReconciliationJobs(
  db: DbClient,
  intervalMs: number,
): Promise<number> {
  const r = await db.query(
    `INSERT INTO jobs (tenant_id, type, payload, status, priority)
     SELECT t.id, 'wallet_reconciliation', jsonb_build_object('tenant_id', t.id::text), 'queued', 1
       FROM tenants t
      WHERE EXISTS (SELECT 1 FROM wallets w WHERE w.tenant_id = t.id)
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
           WHERE j.type = 'wallet_reconciliation' AND j.tenant_id = t.id
             AND (j.status IN ('queued', 'running')
                  OR j.created_at > now() - ($1::bigint * interval '1 millisecond')))
     RETURNING id`,
    [intervalMs],
  );
  return r.rows.length;
}

/** `wallet_reconciliation` job handler. A run already in progress is not an error. */
export async function handleReconciliationJob(
  db: DbClient,
  payload: { tenant_id?: string },
  gateway?: PayPalGateway,
): Promise<string> {
  const tenantId = payload?.tenant_id;
  if (!tenantId) return "no tenant_id";
  try {
    const run = await new ReconciliationService({ db, gateway }).startRun(
      tenantId,
      "schedule",
    );
    return `reconciliation ${run.status}`;
  } catch (err) {
    if ((err as { code?: string })?.code === "RECONCILIATION_IN_PROGRESS")
      return "a reconciliation run is already in progress";
    throw err;
  }
}
