/**
 * RefundService: plan, submit and finalize wallet refunds (task 14.1; R8.4-8.10, 8.13, 8.16-8.18,
 * 9.5, 16.1, 16.2).
 *
 * Money boundary (AGENTS.md section 8): there is no agent path in this file. Entry points take a
 * human actor's user ID and role, never a payee, recipient, currency or payment state. The wallet
 * balance falls only for an item PayPal confirmed COMPLETED. Order of work:
 *
 *   1. plan + persist (one transaction, inside the wallet lock): oldest capture first, refund
 *      window, REFUND_EXCEEDS_CAPTURES before any PayPal call; refund + `planned` items with
 *      deterministic request IDs;
 *   2. per item: mark `submitted` (own transaction), call PayPal with no transaction open;
 *   3. per item: finalize from the PayPal-reported state (COMPLETED / PENDING / FAILED) under the
 *      wallet lock: ledger `Dr 2103 / Cr 1101` tagged with the wallet, event, notifications and
 *      `recomputeWalletMissions`.
 *
 * `submitted` and `pending` items both count as Pending_Refund in `getBalances`, so Available
 * balance drops as soon as the intent is persisted for a call and never before.
 */
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { DbClient, getDb, transaction } from "../../db/connection.js";
import {
  ConflictError,
  ForbiddenActionError,
  IdempotencyConflictError,
  NotFoundError,
  StoatError,
  ValidationError,
} from "../../common/errors.js";
import {
  PayPalApiError,
  UnconfiguredPayPalGateway,
  getPayPalGateway,
  toPayPalAmount,
  type PayPalGateway,
} from "../paypal/paypal.gateway.js";
import { callWithOneRetry } from "./paypal-call.js";
import {
  appendWalletEvent,
  recordPayPalFailureEvent,
  recordRefusal,
} from "./wallet-events.js";
import {
  deriveRefundRequestId,
  floorAtZero,
  formatMoney,
  parseMoney,
  planRefund,
  roundDownToMinorUnits,
  type RefundCapture,
} from "./wallet-math.js";
import { paypalRefundWindowDays } from "./wallet-config.js";
import { getBalances } from "./wallet.service.js";
import { postJournal } from "./wallet-ledger.js";
import { notifyInTx } from "./notification.service.js";
import {
  recomputeMissionFunding,
  recomputeWalletMissions,
} from "./mission-funding.service.js";
import type { AuthenticatedPrincipal } from "../../common/types.js";

const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";
const OPEN_ITEM = ["planned", "submitted", "pending"];

export type RefundKind = "remainder" | "unlinked" | "admin";
export type RefundActorRole = "owner" | "admin";

export interface PlanRefundInput {
  tenantId: string;
  walletId: string;
  kind: RefundKind;
  /** Decimal string. Validated here: positive, currency minor units, at most Available_Balance. */
  amount: unknown;
  /** Human user performing the action. Never an agent. */
  actorUserId: string;
  actorRole: RefundActorRole;
  reason?: string | null;
  idempotencyKey: string;
  /** Remainder_Decision this refund belongs to; also the request-ID group (R8.6). */
  decisionId?: string | null;
  missionId?: string | null;
  correlationId?: string;
}

export interface RefundItemView {
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

export interface RefundView {
  id: string;
  wallet_id: string;
  kind: string;
  mission_id: string | null;
  decision_id: string | null;
  amount: string;
  currency: string;
  status: string;
  reason: string | null;
  paypal_environment: string;
  created_at: string;
  items: RefundItemView[];
}

export interface DecisionView {
  id: string;
  mission_id: string;
  wallet_id: string;
  decision: "refund" | "keep";
  remainder_amount: string;
  refund_amount: string;
  decided_by: string;
  decided_at: string;
  /** The refund this decision started; null for keep. */
  refund: RefundView | null;
}

const ADMIN_REFUND_ROLES = ["operator", "supervisor"];
/** A `submitted` item younger than this may still have a live call in another process. */
const SUBMITTED_GRACE_SECONDS = 120;

/** What PayPal reported for one refund. The only input that decides an item's outcome. */
export interface PayPalRefundState {
  refundId: string | null;
  status: string;
  /** Present when read through getRefund; compared with the item amount. */
  amount?: string | null;
}

export type ItemOutcome = "completed" | "pending" | "failed" | "unchanged";

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : String(v);

const toItemView = (r: any): RefundItemView => ({
  id: r.id,
  deposit_id: r.deposit_id,
  paypal_capture_id: r.paypal_capture_id,
  amount: formatMoney(String(r.amount)),
  status: r.status,
  paypal_refund_id: r.paypal_refund_id ?? null,
  paypal_status: r.paypal_status ?? null,
  failure_reason: r.failure_reason ?? null,
  attempts: Number(r.attempts ?? 0),
});

const toRefundView = (r: any, items: any[]): RefundView => ({
  id: r.id,
  wallet_id: r.wallet_id,
  kind: r.kind,
  mission_id: r.mission_id ?? null,
  decision_id: r.decision_id ?? null,
  amount: formatMoney(String(r.amount)),
  currency: r.currency,
  status: r.status,
  reason: r.reason ?? null,
  paypal_environment: r.paypal_environment,
  created_at: iso(r.created_at),
  items: items.map(toItemView),
});

/** Map PayPal's refund status to an item outcome. Unknown statuses stay pending (fail closed). */
export function classifyRefundStatus(
  status: unknown,
): "completed" | "pending" | "failed" {
  const s = String(status ?? "").toUpperCase();
  if (s === "COMPLETED") return "completed";
  if (s === "FAILED" || s === "CANCELLED" || s === "CANCELED") return "failed";
  return "pending";
}

export class RefundService {
  private readonly gatewayOverride?: PayPalGateway;
  private readonly dbOverride?: DbClient;

  constructor(deps: { gateway?: PayPalGateway; db?: DbClient } = {}) {
    this.gatewayOverride = deps.gateway;
    this.dbOverride = deps.db;
  }

  private get db(): DbClient {
    return this.dbOverride ?? getDb();
  }

  private get gateway(): PayPalGateway {
    return this.gatewayOverride ?? getPayPalGateway();
  }

  // ---------------------------------------------------------------------------
  // Entry point: plan, then submit every item
  // ---------------------------------------------------------------------------

  /** Plan a refund, then submit each item to PayPal. Repeating an Idempotency-Key returns the original. */
  async refund(input: PlanRefundInput): Promise<RefundView> {
    const correlationId = input.correlationId ?? randomUUID();
    this.assertConfigured();
    const planned = await transaction((tx) =>
      this.planInTx(tx, { ...input, correlationId }),
    );
    if (!planned.created)
      return this.getRefund(input.tenantId, planned.refundId);
    await this.submitRefund(planned.refundId, { correlationId });
    return this.getRefund(input.tenantId, planned.refundId);
  }

  private assertConfigured(): void {
    if (this.gateway instanceof UnconfiguredPayPalGateway) {
      throw new PayPalApiError(
        "PAYPAL_NOT_CONFIGURED",
        "PayPal is not configured. Refunds are unavailable.",
        503,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Plan (inside the wallet lock, inside the caller's transaction)
  // ---------------------------------------------------------------------------

  /**
   * Build and persist a Refund_Plan. Throws before any row is written when the amount is invalid
   * or exceeds eligible captures, so the caller's transaction leaves nothing behind and no PayPal
   * call has happened. Callers that record a Remainder_Decision (task 14.2) pass their own
   * transaction so the decision and the plan commit together.
   */
  async planInTx(
    tx: DbClient,
    input: PlanRefundInput,
  ): Promise<{ refundId: string; created: boolean }> {
    if (input.actorRole !== "owner" && input.actorRole !== "admin") {
      throw new StoatError(
        "FORBIDDEN_ACTION",
        "Only a person can request a refund.",
        403,
      );
    }
    const key = input.idempotencyKey;
    if (typeof key !== "string" || key.length < 1 || key.length > 200) {
      throw new ValidationError(
        "An Idempotency-Key of 1 to 200 characters is required.",
        { field: "idempotency_key" },
      );
    }

    // Wallet lock first (lock order: wallet, then refund items).
    const w = (
      await tx.query(
        `SELECT * FROM wallets WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [input.walletId, input.tenantId],
      )
    ).rows[0];
    if (!w) throw new NotFoundError("Wallet", input.walletId);

    const prior = (
      await tx.query(
        `SELECT * FROM wallet_refunds
          WHERE tenant_id = $1 AND wallet_id = $2 AND idempotency_key = $3`,
        [input.tenantId, input.walletId, key],
      )
    ).rows[0];
    if (prior) {
      const again = parseMoney(input.amount);
      const same =
        again.ok &&
        again.decimal.eq(new Decimal(String(prior.amount))) &&
        prior.kind === input.kind;
      if (!same) throw new IdempotencyConflictError();
      return { refundId: prior.id, created: false };
    }

    const currency = String(w.currency);
    const parsed = parseMoney(input.amount, { positive: true, currency });
    if (!parsed.ok) {
      throw new ValidationError("The refund amount is not valid.", {
        field: "amount",
        reason: parsed.reason,
      });
    }
    const amount = parsed.value;
    if (input.kind === "admin") {
      const r = typeof input.reason === "string" ? input.reason : "";
      if (r.length < 1 || r.length > 500) {
        throw new ValidationError(
          "An Admin refund needs a reason of 1 to 500 characters.",
          { field: "reason" },
        );
      }
    }
    const environment = this.gateway.environment;
    if (String(w.paypal_environment) !== environment) {
      throw new ConflictError(
        "WALLET_ENVIRONMENT_MISMATCH",
        "This wallet belongs to a different PayPal environment than the one configured.",
        { wallet_environment: w.paypal_environment, environment },
      );
    }
    const balances = await getBalances(tx, input.walletId);
    if (parsed.decimal.gt(new Decimal(balances.available))) {
      throw new ValidationError(
        "The refund amount exceeds the Available_Balance.",
        {
          field: "amount",
          reason: "EXCEEDS_AVAILABLE",
          available: balances.available,
        },
      );
    }

    // Captures with unrefunded capacity. Failed items free their capacity again (retry reuses them).
    const caps = await tx.query(
      `SELECT d.id AS deposit_id, d.paypal_capture_id,
              COALESCE(d.captured_at, d.created_at) AS captured_at,
              (d.credited_amount - COALESCE((
                 SELECT SUM(i.amount) FROM wallet_refund_items i
                  WHERE i.deposit_id = d.id AND i.status <> 'failed'), 0))::text AS unrefunded
         FROM wallet_deposits d
        WHERE d.wallet_id = $1 AND d.tenant_id = $2 AND d.status = 'captured'
          AND d.paypal_capture_id IS NOT NULL AND d.currency = $3
          AND d.paypal_environment = $4`,
      [input.walletId, input.tenantId, currency, environment],
    );
    const captures: RefundCapture[] = caps.rows.map((c: any) => ({
      depositId: c.deposit_id,
      captureId: c.paypal_capture_id,
      capturedAt: new Date(c.captured_at),
      unrefunded: String(c.unrefunded),
    }));
    const plan = planRefund(
      captures,
      amount,
      new Date(),
      paypalRefundWindowDays(),
    );
    if (!plan.ok) {
      if (plan.code === "REFUND_EXCEEDS_CAPTURES") {
        throw new ConflictError(
          "REFUND_EXCEEDS_CAPTURES",
          "The refund is more than the eligible PayPal captures can return.",
          plan.details,
        );
      }
      throw new ValidationError("The refund amount is not valid.", {
        field: "amount",
        reason: plan.code,
      });
    }

    const refundId = randomUUID();
    const groupId = input.decisionId ?? refundId;
    await tx.query(
      `INSERT INTO wallet_refunds
         (id, tenant_id, wallet_id, kind, decision_id, mission_id, amount, currency, status,
          actor_user_id, actor_role, reason, idempotency_key, paypal_environment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'planned', $9, $10, $11, $12, $13)`,
      [
        refundId,
        input.tenantId,
        input.walletId,
        input.kind,
        input.decisionId ?? null,
        input.missionId ?? null,
        amount,
        currency,
        input.actorUserId,
        input.actorRole,
        input.reason ?? null,
        key,
        environment,
      ],
    );
    for (const item of plan.items) {
      await tx.query(
        `INSERT INTO wallet_refund_items
           (tenant_id, refund_id, deposit_id, paypal_capture_id, amount, status, paypal_request_id)
         VALUES ($1, $2, $3, $4, $5, 'planned', $6)`,
        [
          input.tenantId,
          refundId,
          item.depositId,
          item.captureId,
          item.amount,
          deriveRefundRequestId(groupId, item.captureId),
        ],
      );
    }
    await appendWalletEvent(tx, {
      tenantId: input.tenantId,
      aggregateType: "wallet",
      aggregateId: input.walletId,
      eventType: "WALLET_REFUND_PLANNED",
      actorRole: input.actorRole,
      actorId: input.actorUserId,
      correlationId: input.correlationId,
      amount,
      currency,
      details: {
        refund_id: refundId,
        kind: input.kind,
        mission_id: input.missionId ?? null,
        decision_id: input.decisionId ?? null,
        items: plan.items.length,
      },
      idempotencyKey: `wallet-refund-planned:${refundId}`,
    });
    return { refundId, created: true };
  }

  // ---------------------------------------------------------------------------
  // Submit (PayPal called with no transaction open)
  // ---------------------------------------------------------------------------

  /** Submit every `planned` item of a refund, oldest first. A PayPal failure fails only that item. */
  async submitRefund(
    refundId: string,
    opts: { correlationId?: string; resumeSubmitted?: boolean } = {},
  ): Promise<void> {
    const items = await this.db.query<{ id: string }>(
      `SELECT i.id FROM wallet_refund_items i JOIN wallet_deposits d ON d.id = i.deposit_id
        WHERE i.refund_id = $1 AND i.status = ANY($2::text[])
        ORDER BY COALESCE(d.captured_at, d.created_at), d.id`,
      [refundId, opts.resumeSubmitted ? ["planned", "submitted"] : ["planned"]],
    );
    for (const { id } of items.rows) {
      await this.submitItem(id, opts);
    }
  }

  /**
   * One item: persist the intent (`submitted`), call PayPal outside any transaction with the
   * deterministic request ID, then finalize from what PayPal reported.
   */
  async submitItem(
    itemId: string,
    opts: { correlationId?: string; resumeSubmitted?: boolean } = {},
  ): Promise<ItemOutcome> {
    this.assertConfigured();
    const gateway = this.gateway;
    const correlationId = opts.correlationId ?? randomUUID();

    const claim = await transaction(async (tx) => {
      const head = (
        await tx.query(
          `SELECT i.id, r.wallet_id FROM wallet_refund_items i
             JOIN wallet_refunds r ON r.id = i.refund_id WHERE i.id = $1`,
          [itemId],
        )
      ).rows[0];
      if (!head) throw new NotFoundError("Refund item", itemId);
      await tx.query(`SELECT id FROM wallets WHERE id = $1 FOR UPDATE`, [
        head.wallet_id,
      ]);
      const item = (
        await tx.query(
          `SELECT * FROM wallet_refund_items WHERE id = $1 FOR UPDATE`,
          [itemId],
        )
      ).rows[0];
      const allowed = opts.resumeSubmitted
        ? ["planned", "submitted"]
        : ["planned"];
      if (!allowed.includes(item.status)) return null;
      const refund = (
        await tx.query(`SELECT * FROM wallet_refunds WHERE id = $1`, [
          item.refund_id,
        ])
      ).rows[0];
      if (refund.paypal_environment !== gateway.environment) {
        throw new ConflictError(
          "WALLET_ENVIRONMENT_MISMATCH",
          "This refund belongs to a different PayPal environment than the one configured.",
        );
      }
      await tx.query(
        `UPDATE wallet_refund_items
            SET status = 'submitted', attempts = attempts + 1, failure_reason = NULL, updated_at = now()
          WHERE id = $1`,
        [itemId],
      );
      await tx.query(
        `UPDATE wallet_refunds SET status = 'processing', updated_at = now() WHERE id = $1`,
        [refund.id],
      );
      return { item, refund };
    });
    if (!claim) return "unchanged";
    const { item, refund } = claim;

    // PayPal call: no database transaction is open (R8.7, R16.9).
    let result: { refundId: string; status: string };
    try {
      result = await callWithOneRetry(
        () =>
          gateway.refundCapture({
            captureId: item.paypal_capture_id,
            amount: toPayPalAmount(formatMoney(String(item.amount), 2)),
            currency: refund.currency,
            requestId: item.paypal_request_id,
            note: "Stoat wallet refund",
          }),
        {
          action: "refund capture",
          correlationId,
          environment: gateway.environment,
          requestId: item.paypal_request_id,
          validate: (r) =>
            !!r &&
            typeof r.refundId === "string" &&
            r.refundId.length > 0 &&
            typeof r.status === "string",
        },
      );
    } catch (err) {
      if (!(err instanceof StoatError)) throw err;
      return this.applyOutcome(
        itemId,
        { refundId: null, status: "FAILED" },
        { correlationId, failureReason: err.code },
      );
    }
    return this.applyOutcome(
      itemId,
      { refundId: result.refundId, status: result.status },
      { correlationId },
    );
  }

  // ---------------------------------------------------------------------------
  // Finalize from PayPal-confirmed state
  // ---------------------------------------------------------------------------

  /**
   * Read PayPal's view of an item that was submitted (or is pending) and apply it. Used by the
   * webhook and the sweep. An item with no PayPal refund ID is re-submitted with the same request
   * ID, which PayPal answers idempotently.
   */
  async syncItem(
    itemId: string,
    opts: { correlationId?: string } = {},
  ): Promise<ItemOutcome> {
    this.assertConfigured();
    const correlationId = opts.correlationId ?? randomUUID();
    const item = (
      await this.db.query(`SELECT * FROM wallet_refund_items WHERE id = $1`, [
        itemId,
      ])
    ).rows[0];
    if (!item) throw new NotFoundError("Refund item", itemId);
    if (item.status !== "pending" && item.status !== "submitted")
      return "unchanged";
    if (!item.paypal_refund_id) {
      return this.submitItem(itemId, { correlationId, resumeSubmitted: true });
    }
    let state: Awaited<ReturnType<PayPalGateway["getRefund"]>>;
    try {
      state = await callWithOneRetry(
        () => this.gateway.getRefund(item.paypal_refund_id),
        {
          action: "read refund",
          correlationId,
          environment: this.gateway.environment,
          requestId: item.paypal_request_id,
          validate: (r) => !!r && typeof r.status === "string",
        },
      );
    } catch (err) {
      // PayPal not reachable now: the item stays as it is and the next sweep tries again.
      if (err instanceof StoatError) return "unchanged";
      throw err;
    }
    return this.applyOutcome(
      itemId,
      { refundId: state.refundId, status: state.status, amount: state.amount },
      { correlationId },
    );
  }

  /**
   * Apply a PayPal-reported state to one item under the wallet lock. COMPLETED reduces the balance
   * through a balanced ledger entry; PENDING keeps the amount out of Available_Balance; FAILED
   * changes nothing but the item. A completed item is never changed again.
   */
  async applyOutcome(
    itemId: string,
    state: PayPalRefundState,
    opts: { correlationId?: string; failureReason?: string } = {},
  ): Promise<ItemOutcome> {
    const correlationId = opts.correlationId ?? randomUUID();
    const kind = classifyRefundStatus(state.status);
    const head = (
      await this.db.query(
        `SELECT i.tenant_id, r.wallet_id FROM wallet_refund_items i
           JOIN wallet_refunds r ON r.id = i.refund_id WHERE i.id = $1`,
        [itemId],
      )
    ).rows[0];
    if (!head) throw new NotFoundError("Refund item", itemId);

    const done = await transaction(async (tx) => {
      await tx.query(`SELECT id FROM wallets WHERE id = $1 FOR UPDATE`, [
        head.wallet_id,
      ]);
      const item = (
        await tx.query(
          `SELECT * FROM wallet_refund_items WHERE id = $1 FOR UPDATE`,
          [itemId],
        )
      ).rows[0];
      const refund = (
        await tx.query(`SELECT * FROM wallet_refunds WHERE id = $1`, [
          item.refund_id,
        ])
      ).rows[0];
      // Another trigger finalized it first: change nothing (idempotent).
      if (item.status === "completed")
        return { outcome: "unchanged" as ItemOutcome };

      const amount = formatMoney(String(item.amount));
      const currency = String(refund.currency);
      const paypal = {
        captureId: item.paypal_capture_id as string,
        refundId: state.refundId,
        requestId: item.paypal_request_id as string,
      };
      const base = {
        tenantId: item.tenant_id as string,
        aggregateType: "wallet" as const,
        aggregateId: head.wallet_id as string,
        actorRole: "system" as const,
        actorId: SYSTEM_ACTOR,
        correlationId,
        currency,
      };
      const details = {
        refund_id: refund.id,
        item_id: item.id,
        deposit_id: item.deposit_id,
        mission_id: refund.mission_id,
        kind: refund.kind,
        paypal_status: state.status,
      };

      // PayPal reports another amount than the one requested: nothing is credited or debited.
      if (
        kind === "completed" &&
        state.amount != null &&
        !new Decimal(String(state.amount)).eq(new Decimal(String(item.amount)))
      ) {
        await tx.query(
          `UPDATE wallet_refund_items
              SET status = 'pending', paypal_refund_id = COALESCE($2, paypal_refund_id),
                  paypal_status = $3, failure_reason = 'amount_mismatch', updated_at = now()
            WHERE id = $1`,
          [itemId, state.refundId, state.status],
        );
        await this.syncRefundStatus(tx, refund.id);
        return { outcome: "pending" as ItemOutcome, mismatch: true, amount };
      }

      if (kind === "completed") {
        await tx.query(
          `UPDATE wallet_refund_items
              SET status = 'completed', paypal_refund_id = COALESCE($2, paypal_refund_id),
                  paypal_status = $3, failure_reason = NULL, completed_at = now(), updated_at = now()
            WHERE id = $1`,
          [itemId, state.refundId, state.status],
        );
        const ev = await appendWalletEvent(tx, {
          ...base,
          eventType: "WALLET_REFUNDED",
          amount,
          paypal,
          details,
          idempotencyKey: `wallet-refund-item:${itemId}:completed`,
        });
        const journal = await postJournal(tx, {
          tenantId: base.tenantId,
          eventId: ev.id,
          reference: `wallet:refund:${itemId}`,
          currency,
          lines: [
            {
              accountCode: "2103",
              side: "debit",
              amount,
              walletId: head.wallet_id,
            },
            { accountCode: "1101", side: "credit", amount },
          ],
        });
        await tx.query(
          `UPDATE wallet_refund_items SET journal_transaction_id = $2 WHERE id = $1`,
          [itemId, journal.transactionId],
        );
        const status = await this.syncRefundStatus(tx, refund.id);
        if (status === "completed") {
          const total = formatMoney(String(refund.amount));
          const w = (
            await tx.query(`SELECT owner_user_id FROM wallets WHERE id = $1`, [
              head.wallet_id,
            ])
          ).rows[0];
          const text = {
            title: "Refund completed",
            body: `${total} ${currency} was refunded to PayPal.`,
            eventId: `refund_completed:${refund.id}`,
            entityType: "wallet_refund",
            entityId: refund.id as string,
            missionId: refund.mission_id as string | null,
          };
          await notifyInTx(tx, {
            tenantId: base.tenantId,
            kind: "refund_completed",
            recipient: { userId: w.owner_user_id },
            ...text,
          });
          await notifyInTx(tx, {
            tenantId: base.tenantId,
            kind: "refund_completed",
            recipient: { admins: true },
            ...text,
            eventId: `refund_completed:${refund.id}:admins`,
          });
        }
        await recomputeWalletMissions(tx, head.wallet_id, refund.mission_id);
        return { outcome: "completed" as ItemOutcome };
      }

      if (kind === "pending") {
        const wasPending = item.status === "pending";
        await tx.query(
          `UPDATE wallet_refund_items
              SET status = 'pending', paypal_refund_id = COALESCE($2, paypal_refund_id),
                  paypal_status = $3, failure_reason = NULL, updated_at = now()
            WHERE id = $1`,
          [itemId, state.refundId, state.status],
        );
        if (!wasPending) {
          await appendWalletEvent(tx, {
            ...base,
            eventType: "WALLET_REFUND_PENDING",
            amount,
            paypal,
            details,
            idempotencyKey: `wallet-refund-item:${itemId}:pending`,
          });
        }
        await this.syncRefundStatus(tx, refund.id);
        return { outcome: "pending" as ItemOutcome };
      }

      // Failed: balance and ledger stay as they were (R8.10).
      const reason =
        opts.failureReason ?? `paypal_${String(state.status).toLowerCase()}`;
      await tx.query(
        `UPDATE wallet_refund_items
            SET status = 'failed', paypal_refund_id = COALESCE($2, paypal_refund_id),
                paypal_status = $3, failure_reason = $4, updated_at = now()
          WHERE id = $1`,
        [itemId, state.refundId, state.status, reason],
      );
      await this.syncRefundStatus(tx, refund.id);
      await notifyInTx(tx, {
        tenantId: base.tenantId,
        kind: "refund_failed",
        recipient: { admins: true },
        title: "Refund failed",
        body: `A refund of ${amount} ${currency} did not complete (${reason}). The wallet balance is unchanged.`,
        eventId: `refund_failed:${itemId}:${item.attempts}`,
        entityType: "wallet_refund",
        entityId: refund.id,
        missionId: refund.mission_id,
      });
      await recomputeWalletMissions(tx, head.wallet_id, refund.mission_id);
      return {
        outcome: "failed" as ItemOutcome,
        failed: { reason, amount, currency, refundId: refund.id as string },
      };
    });

    // Failures are recorded after the transaction, independent of the success path (R19.10).
    if ((done as any).failed) {
      const f = (done as any).failed;
      await recordPayPalFailureEvent({
        tenantId: head.tenant_id,
        aggregateType: "wallet",
        aggregateId: head.wallet_id,
        eventType: "WALLET_REFUND_FAILED",
        actorRole: "system",
        actorId: SYSTEM_ACTOR,
        correlationId,
        amount: f.amount,
        currency: f.currency,
        errorCode: String(f.reason),
        environment: this.gateway.environment,
        details: { refund_id: f.refundId, item_id: itemId },
      }).catch(() => undefined);
    }
    if ((done as any).mismatch) {
      await recordPayPalFailureEvent({
        tenantId: head.tenant_id,
        aggregateType: "wallet",
        aggregateId: head.wallet_id,
        eventType: "WALLET_REFUND_AMOUNT_MISMATCH",
        actorRole: "system",
        actorId: SYSTEM_ACTOR,
        correlationId,
        amount: (done as any).amount,
        errorCode: "amount_mismatch",
        environment: this.gateway.environment,
        details: { item_id: itemId },
      }).catch(() => undefined);
    }
    return done.outcome;
  }

  /** Refund status from its items: completed, partially_completed, failed or processing. */
  private async syncRefundStatus(
    tx: DbClient,
    refundId: string,
  ): Promise<string> {
    const r = (
      await tx.query<{ status: string; n: number }>(
        `SELECT status, count(*)::int AS n FROM wallet_refund_items WHERE refund_id = $1 GROUP BY status`,
        [refundId],
      )
    ).rows;
    const n = (s: string) => r.find((x) => x.status === s)?.n ?? 0;
    const total = r.reduce((a, x) => a + x.n, 0);
    const open = OPEN_ITEM.reduce((a, s) => a + n(s), 0);
    let status: string;
    if (total > 0 && n("completed") === total) status = "completed";
    else if (open > 0) status = "processing";
    else if (n("completed") > 0) status = "partially_completed";
    else status = "failed";
    await tx.query(
      `UPDATE wallet_refunds SET status = $2, updated_at = now() WHERE id = $1`,
      [refundId, status],
    );
    return status;
  }

  // ---------------------------------------------------------------------------
  // Authorization (R8.14, R12.1, R12.8, R12.9): every refusal writes one audit row, no PayPal call
  // ---------------------------------------------------------------------------

  private async refuse(
    principal: AuthenticatedPrincipal,
    operation: string,
    walletId: string | null,
    reasons: string[],
    correlationId?: string,
  ): Promise<never> {
    await recordRefusal(this.db, {
      tenantId: principal.tenantId,
      principal: {
        type: principal.type === "user" ? "user" : "agent",
        id: principal.id,
        role: String(principal.role),
      },
      operation,
      walletId,
      reasons,
      correlationId,
    });
    if (principal.type !== "user") {
      throw new ForbiddenActionError(
        "Agents cannot use wallet operations. A person must perform this action.",
      );
    }
    if (reasons.includes("wallet_not_owned")) {
      throw new StoatError(
        "WALLET_NOT_OWNED",
        "This wallet belongs to another user.",
        403,
      );
    }
    throw new ForbiddenActionError(
      `Role '${principal.role}' is not authorized for this wallet operation.`,
    );
  }

  private async loadWallet(tenantId: string, walletId: string): Promise<any> {
    const w = (
      await this.db.query(
        `SELECT * FROM wallets WHERE id = $1 AND tenant_id = $2`,
        [walletId, tenantId],
      )
    ).rows[0];
    if (!w) throw new NotFoundError("Wallet", walletId);
    return w;
  }

  // ---------------------------------------------------------------------------
  // Remainder decision (R8.3, R8.4, R8.11, R8.14, R8.16, R8.18, R8.19)
  // ---------------------------------------------------------------------------

  /**
   * Record the Owner's choice for a completed mission's Remainder. `keep` makes no PayPal call.
   * `refund` records the decision and the Refund_Plan in one commit, then submits each item.
   * A repeated decision returns the stored one, whatever choice the repeat carries.
   */
  async decideRemainder(input: {
    tenantId: string;
    owner: AuthenticatedPrincipal;
    missionId: string;
    decision: "refund" | "keep";
    /** Refund only. Default: the Remainder rounded down to the currency's minor units. */
    amount?: unknown;
    idempotencyKey: string;
    correlationId?: string;
  }): Promise<DecisionView> {
    const operation = "wallet.remainder.decide";
    const correlationId = input.correlationId ?? randomUUID();
    const m = (
      await this.db.query(
        `SELECT m.id, m.status, m.currency, a.owner_user_id, f.wallet_id
           FROM missions m
           LEFT JOIN agents a ON a.id = m.buyer_id
           LEFT JOIN mission_funding f ON f.mission_id = m.id
          WHERE m.id = $1 AND m.tenant_id = $2`,
        [input.missionId, input.tenantId],
      )
    ).rows[0];
    if (!m) throw new NotFoundError("Mission", input.missionId);

    const reasons: string[] = [];
    if (input.owner.type !== "user") reasons.push("agent_principal");
    if (m.owner_user_id !== input.owner.id) reasons.push("wallet_not_owned");
    if (reasons.length > 0) {
      await this.refuse(
        input.owner,
        operation,
        m.wallet_id ?? null,
        reasons,
        correlationId,
      );
    }
    if (input.decision !== "refund" && input.decision !== "keep") {
      throw new ValidationError("The decision must be refund or keep.", {
        field: "decision",
      });
    }
    const key = input.idempotencyKey;
    if (typeof key !== "string" || key.length < 1 || key.length > 200) {
      throw new ValidationError(
        "An Idempotency-Key of 1 to 200 characters is required.",
        { field: "idempotency_key" },
      );
    }

    const existing = await this.getDecision(input.tenantId, input.missionId);
    if (existing) return existing;
    if (input.decision === "refund") this.assertConfigured();

    const out = await transaction(async (tx) => {
      // recompute locks the funding row, then the wallet (the order every wallet writer uses).
      const snap = await recomputeMissionFunding(tx, input.missionId);
      if (!snap) {
        throw new ConflictError(
          "WALLET_OWNER_UNRESOLVED",
          "The mission has no Owner whose wallet funds it.",
        );
      }
      const again = (
        await tx.query(
          `SELECT id FROM remainder_decisions WHERE mission_id = $1`,
          [input.missionId],
        )
      ).rows[0];
      if (again) return { decisionId: again.id as string, refundId: null };
      if (m.status !== "completed" || snap.state !== "awaiting_decision") {
        throw new ConflictError(
          "MISSION_NOT_AWAITING_DECISION",
          "This mission has no Remainder waiting for a decision.",
          { state: snap.state, mission_status: m.status },
        );
      }
      const currency = String(m.currency).toUpperCase();
      const remainder = floorAtZero(snap.funding);

      let refundAmount = "0";
      if (input.decision === "refund") {
        const raw =
          input.amount === undefined || input.amount === null
            ? roundDownToMinorUnits(remainder, currency)
            : input.amount;
        const parsed = parseMoney(raw, { positive: true, currency });
        if (!parsed.ok) {
          throw new ValidationError("The refund amount is not valid.", {
            field: "amount",
            reason: parsed.reason,
          });
        }
        if (parsed.decimal.gt(new Decimal(remainder))) {
          throw new ValidationError(
            "The refund amount exceeds the Remainder.",
            { field: "amount", reason: "EXCEEDS_REMAINDER", remainder },
          );
        }
        refundAmount = parsed.value;
      }

      const decisionId = (
        await tx.query(
          `INSERT INTO remainder_decisions
             (tenant_id, mission_id, wallet_id, decision, remainder_amount, refund_amount, decided_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            input.tenantId,
            input.missionId,
            snap.walletId,
            input.decision,
            remainder,
            refundAmount,
            input.owner.id,
          ],
        )
      ).rows[0].id as string;

      await appendWalletEvent(tx, {
        tenantId: input.tenantId,
        aggregateType: "mission",
        aggregateId: input.missionId,
        eventType: "MISSION_REMAINDER_DECIDED",
        actorRole: "owner",
        actorId: input.owner.id,
        correlationId,
        amount: refundAmount,
        currency,
        details: {
          decision: input.decision,
          decision_id: decisionId,
          remainder: formatMoney(remainder),
          wallet_id: snap.walletId,
        },
        idempotencyKey: `remainder-decided:${input.missionId}`,
      });

      if (input.decision === "keep") {
        // The Remainder stays in the wallet; funding state moves to closed (R8.3).
        await recomputeMissionFunding(tx, input.missionId);
        return { decisionId, refundId: null };
      }
      const planned = await this.planInTx(tx, {
        tenantId: input.tenantId,
        walletId: snap.walletId,
        kind: "remainder",
        amount: refundAmount,
        actorUserId: input.owner.id,
        actorRole: "owner",
        idempotencyKey: key,
        decisionId,
        missionId: input.missionId,
        correlationId,
      });
      return { decisionId, refundId: planned.refundId, created: true };
    });

    if (out.refundId && (out as any).created) {
      await this.submitRefund(out.refundId, { correlationId });
    }
    return (await this.getDecision(input.tenantId, input.missionId))!;
  }

  async getDecision(
    tenantId: string,
    missionId: string,
  ): Promise<DecisionView | null> {
    const d = (
      await this.db.query(
        `SELECT * FROM remainder_decisions WHERE mission_id = $1 AND tenant_id = $2`,
        [missionId, tenantId],
      )
    ).rows[0];
    if (!d) return null;
    const r = (
      await this.db.query(
        `SELECT id FROM wallet_refunds WHERE decision_id = $1 ORDER BY created_at LIMIT 1`,
        [d.id],
      )
    ).rows[0];
    return {
      id: d.id,
      mission_id: d.mission_id,
      wallet_id: d.wallet_id,
      decision: d.decision,
      remainder_amount: formatMoney(String(d.remainder_amount)),
      refund_amount: formatMoney(String(d.refund_amount)),
      decided_by: d.decided_by,
      decided_at: iso(d.decided_at),
      refund: r ? await this.getRefund(tenantId, r.id) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Unlinked and Admin refunds (R8.15, R12.8, R12.9)
  // ---------------------------------------------------------------------------

  /** Owner refund of Available_Balance not tied to a mission. Same plan, ledger and idempotency rules. */
  async refundUnlinked(input: {
    tenantId: string;
    owner: AuthenticatedPrincipal;
    walletId: string;
    /** Default: the whole Available_Balance rounded down to minor units. */
    amount?: unknown;
    idempotencyKey: string;
    correlationId?: string;
  }): Promise<RefundView> {
    const operation = "wallet.refund.create";
    const w = await this.loadWallet(input.tenantId, input.walletId);
    const reasons: string[] = [];
    if (input.owner.type !== "user") reasons.push("agent_principal");
    if (w.owner_user_id !== input.owner.id) reasons.push("wallet_not_owned");
    if (reasons.length > 0) {
      await this.refuse(
        input.owner,
        operation,
        w.id,
        reasons,
        input.correlationId,
      );
    }
    let amount = input.amount;
    if (amount === undefined || amount === null) {
      const prior = (
        await this.db.query(
          `SELECT id FROM wallet_refunds
            WHERE tenant_id = $1 AND wallet_id = $2 AND idempotency_key = $3`,
          [input.tenantId, w.id, input.idempotencyKey],
        )
      ).rows[0];
      if (prior) return this.getRefund(input.tenantId, prior.id);
      const b = await getBalances(this.db, w.id);
      amount = roundDownToMinorUnits(b.available, String(w.currency));
    }
    return this.refund({
      tenantId: input.tenantId,
      walletId: w.id,
      kind: "unlinked",
      amount,
      actorUserId: input.owner.id,
      actorRole: "owner",
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
    });
  }

  /** Admin refund of an Owner's wallet funds: human operator or supervisor, stated reason, actor recorded. */
  async adminRefund(input: {
    tenantId: string;
    admin: AuthenticatedPrincipal;
    walletId: string;
    amount: unknown;
    reason: unknown;
    idempotencyKey: string;
    correlationId?: string;
  }): Promise<RefundView> {
    const operation = "wallet.refund.admin";
    const w = await this.loadWallet(input.tenantId, input.walletId);
    const reasons: string[] = [];
    if (input.admin.type !== "user") reasons.push("agent_principal");
    else if (!ADMIN_REFUND_ROLES.includes(String(input.admin.role)))
      reasons.push("role_not_allowed");
    const reason = typeof input.reason === "string" ? input.reason : "";
    const reasonOk = reason.trim().length >= 1 && reason.length <= 500;
    if (!reasonOk) reasons.push("reason_missing");
    if (reasons.length > 0) {
      try {
        await this.refuse(
          input.admin,
          operation,
          w.id,
          reasons,
          input.correlationId,
        );
      } catch (err) {
        // A person with the right role who left out the reason gets a validation error.
        if (reasons.length === 1 && reasons[0] === "reason_missing") {
          throw new ValidationError(
            "An Admin refund needs a reason of 1 to 500 characters.",
            { field: "reason" },
          );
        }
        throw err;
      }
    }
    return this.refund({
      tenantId: input.tenantId,
      walletId: w.id,
      kind: "admin",
      amount: input.amount,
      actorUserId: input.admin.id,
      actorRole: "admin",
      reason,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
    });
  }

  // ---------------------------------------------------------------------------
  // Retry (R8.10, R8.11): failed items only, same request IDs
  // ---------------------------------------------------------------------------

  async retryFailed(input: {
    tenantId: string;
    actor: AuthenticatedPrincipal;
    refundId: string;
    correlationId?: string;
  }): Promise<RefundView> {
    const correlationId = input.correlationId ?? randomUUID();
    const operation = "wallet.refund.retry";
    const r = (
      await this.db.query(
        `SELECT r.*, w.owner_user_id AS wallet_owner_id
           FROM wallet_refunds r JOIN wallets w ON w.id = r.wallet_id
          WHERE r.id = $1 AND r.tenant_id = $2`,
        [input.refundId, input.tenantId],
      )
    ).rows[0];
    if (!r) throw new NotFoundError("Refund", input.refundId);

    // The Owner retries their own refunds; only an Admin retries an Admin refund (R12.11).
    const reasons: string[] = [];
    if (input.actor.type !== "user") reasons.push("agent_principal");
    else if (r.kind === "admin") {
      if (!ADMIN_REFUND_ROLES.includes(String(input.actor.role)))
        reasons.push("role_not_allowed");
    } else if (r.wallet_owner_id !== input.actor.id) {
      reasons.push("wallet_not_owned");
    }
    if (reasons.length > 0) {
      await this.refuse(
        input.actor,
        operation,
        r.wallet_id,
        reasons,
        correlationId,
      );
    }
    this.assertConfigured();

    await transaction(async (tx) => {
      await tx.query(`SELECT id FROM wallets WHERE id = $1 FOR UPDATE`, [
        r.wallet_id,
      ]);
      const failed = (
        await tx.query(
          `SELECT * FROM wallet_refund_items
            WHERE refund_id = $1 AND status = 'failed' FOR UPDATE`,
          [r.id],
        )
      ).rows;
      if (failed.length === 0) {
        throw new ConflictError(
          "REFUND_NOTHING_TO_RETRY",
          "This refund has no failed items to retry.",
        );
      }
      if (r.paypal_environment !== this.gateway.environment) {
        throw new ConflictError(
          "WALLET_ENVIRONMENT_MISMATCH",
          "This refund belongs to a different PayPal environment than the one configured.",
        );
      }
      const total = failed.reduce(
        (a: Decimal, i: any) => a.plus(new Decimal(String(i.amount))),
        new Decimal(0),
      );
      const balances = await getBalances(tx, r.wallet_id);
      if (total.gt(new Decimal(balances.available))) {
        throw new ValidationError("The retry exceeds the Available_Balance.", {
          reason: "EXCEEDS_AVAILABLE",
          available: balances.available,
        });
      }
      for (const i of failed) {
        const cap = (
          await tx.query(
            `SELECT (d.credited_amount - COALESCE((
                       SELECT SUM(x.amount) FROM wallet_refund_items x
                        WHERE x.deposit_id = d.id AND x.status <> 'failed'), 0))::text AS free
               FROM wallet_deposits d WHERE d.id = $1`,
            [i.deposit_id],
          )
        ).rows[0];
        if (!cap || new Decimal(cap.free).lt(new Decimal(String(i.amount)))) {
          throw new ConflictError(
            "REFUND_EXCEEDS_CAPTURES",
            "The capture no longer has enough unrefunded funds for this retry.",
          );
        }
      }
      await tx.query(
        `UPDATE wallet_refund_items
            SET status = 'planned', failure_reason = NULL, updated_at = now()
          WHERE refund_id = $1 AND status = 'failed'`,
        [r.id],
      );
      await this.syncRefundStatus(tx, r.id);
      const attempts = failed.reduce(
        (a: number, i: any) => a + Number(i.attempts ?? 0),
        0,
      );
      await appendWalletEvent(tx, {
        tenantId: input.tenantId,
        aggregateType: "wallet",
        aggregateId: r.wallet_id,
        eventType: "WALLET_REFUND_RETRIED",
        actorRole: r.kind === "admin" ? "admin" : "owner",
        actorId: input.actor.id,
        correlationId,
        amount: formatMoney(total),
        currency: r.currency,
        details: { refund_id: r.id, items: failed.length },
        idempotencyKey: `wallet-refund-retry:${r.id}:${attempts}`,
      });
    });

    await this.submitRefund(r.id, { correlationId });
    return this.getRefund(input.tenantId, r.id);
  }

  // ---------------------------------------------------------------------------
  // Sweep (R8.9): re-check what PayPal has not yet settled
  // ---------------------------------------------------------------------------

  /**
   * Re-read every `pending` item and every `submitted` item old enough that no live call can still
   * be running. Only PayPal's reported state changes an item. Run at least every 15 minutes.
   */
  async sweep(
    limit = 100,
  ): Promise<{ checked: number; completed: number; failed: number }> {
    const out = { checked: 0, completed: 0, failed: 0 };
    const items = await this.db.query<{ id: string }>(
      `SELECT id FROM wallet_refund_items
        WHERE status = 'pending'
           OR (status = 'submitted'
               AND updated_at < now() - ($2::int * interval '1 second'))
        ORDER BY updated_at, id
        LIMIT $1`,
      [limit, SUBMITTED_GRACE_SECONDS],
    );
    if (items.rows.length === 0) return out;
    this.assertConfigured();
    for (const { id } of items.rows) {
      try {
        const outcome = await this.syncItem(id);
        out.checked++;
        if (outcome === "completed") out.completed++;
        if (outcome === "failed") out.failed++;
      } catch (err) {
        console.error(
          "[RefundSweep] item failed:",
          id,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  async getRefund(tenantId: string, refundId: string): Promise<RefundView> {
    const r = (
      await this.db.query(
        `SELECT * FROM wallet_refunds WHERE id = $1 AND tenant_id = $2`,
        [refundId, tenantId],
      )
    ).rows[0];
    if (!r) throw new NotFoundError("Refund", refundId);
    const items = (
      await this.db.query(
        `SELECT i.* FROM wallet_refund_items i JOIN wallet_deposits d ON d.id = i.deposit_id
          WHERE i.refund_id = $1 ORDER BY COALESCE(d.captured_at, d.created_at), d.id`,
        [refundId],
      )
    ).rows;
    return toRefundView(r, items);
  }
}
