/**
 * DepositService: create a wallet Deposit as a real PayPal order (task 8.1).
 *
 * Money boundary (AGENTS.md section 8): only a human Owner reaches this code. Agent principals are
 * refused, and so is any payee, recipient or payment-source field. The amount, currency and
 * mission come from the Owner's request and are validated here; PayPal-confirmed facts, not
 * claims, decide what is later credited (capture is a later task).
 *
 * Order of work: validate everything -> persist a `creating` row (own transaction) -> call PayPal
 * with no transaction open -> store the order as `awaiting_approval` (own transaction).
 */
import { randomUUID } from "node:crypto";
import { DbClient, getDb, transaction } from "../../db/connection.js";
import type { AuthenticatedPrincipal } from "../../common/types.js";
import {
  ForbiddenActionError,
  IdempotencyConflictError,
  NotFoundError,
  StoatError,
  ValidationError,
} from "../../common/errors.js";
import {
  PayPalApiError,
  PayPalGateway,
  UnconfiguredPayPalGateway,
  getPayPalGateway,
  toPayPalAmount,
} from "../paypal/paypal.gateway.js";
import { callWithOneRetry } from "./paypal-call.js";
import {
  appendWalletEvent,
  recordPayPalFailureEvent,
  recordRefusal,
} from "./wallet-events.js";
import {
  depositRequestHash,
  deriveDepositRequestId,
  formatMoney,
  parseMoney,
} from "./wallet-math.js";
import { serializeDeposit, type DepositView } from "./wallet-serializers.js";
import { getOrCreateWallet } from "./wallet.service.js";
import { getFundingMode } from "./funding-mode.js";
import { walletCurrencies, walletMaxDeposit } from "./wallet-config.js";
import { notifyInTx } from "./notification.service.js";
import { postJournal } from "./wallet-ledger.js";
import { recomputeWalletMissions } from "./mission-funding.service.js";
import { Decimal } from "decimal.js";
import type { GatewayCapture } from "../paypal/paypal.gateway.js";

/** An order never approved lapses after this long (R3.10). */
export const DEPOSIT_ORDER_TTL_MS = 3 * 60 * 60 * 1000;
/** Sweep attempts that fail transiently before `deposit_stuck` is raised (R3.17). */
export const DEPOSIT_MAX_SWEEP_ATTEMPTS = 10;
/** A `creating` row older than this is recovered by the sweep (task 8.1 left it behind). */
export const DEPOSIT_CREATING_STALE_MS = 2 * 60 * 1000;

const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";
const TERMINAL = new Set([
  "captured",
  "mismatch",
  "failed",
  "cancelled",
  "expired",
  "creation_failed",
]);

export type CaptureSource = "return" | "webhook" | "sweep";

export interface CaptureByOrderInput {
  orderId: string;
  /** Tenant of the receiving request when known; a deposit of another tenant is treated as unknown. */
  tenantId?: string;
  /** `custom_id` reported by PayPal for the order, when the trigger carries it. */
  customId?: string | null;
  source: CaptureSource;
  correlationId?: string;
}

const isTransientError = (err: unknown): boolean => {
  if (!(err instanceof PayPalApiError)) return false;
  if (err.code === "PAYPAL_UNREACHABLE") return true;
  if (err.code === "PAYPAL_REQUEST_REJECTED") {
    const s = Number(
      (err.details as Record<string, unknown> | undefined)?.paypal_status,
    );
    return Number.isFinite(s) && s >= 500;
  }
  return false;
};
const isNotFoundError = (err: unknown): boolean =>
  err instanceof PayPalApiError &&
  Number(
    (err.details as Record<string, unknown> | undefined)?.paypal_status,
  ) === 404;

export interface CreateDepositInput {
  tenantId: string;
  /** The authenticated principal; must be a human user. Identity is never read from the body. */
  owner: AuthenticatedPrincipal;
  amount: unknown;
  currency: unknown;
  missionId?: string | null;
  idempotencyKey: unknown;
  returnOrigin?: string;
  buyerUserAgent?: string;
  correlationId?: string;
  /** Set only by server-side top-up code (task 12.2), never from a client field. */
  isTopUp?: boolean;
}

export type { DepositView };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORBIDDEN_FIELD_RE = /payee|recipient|payment[_-]?source|receiver/i;

export const toDepositView = serializeDeposit;

/**
 * A top-up that ended without a credit (cancelled, failed or expired) tells the Owner once
 * (R7.11). Funding state and balance are untouched: no recompute, no ledger entry. The event ID is
 * per deposit, so a repeated trigger cannot send a second notice.
 */
async function notifyTopUpIncomplete(
  tx: DbClient,
  d: {
    id: string;
    tenant_id: string;
    owner_user_id: string;
    mission_id: string | null;
    is_top_up: boolean;
    amount: unknown;
    currency: string;
  },
  outcome: "cancelled" | "failed" | "expired",
): Promise<void> {
  if (!d.is_top_up) return;
  await notifyInTx(tx, {
    tenantId: d.tenant_id,
    kind: "topup_incomplete",
    recipient: { userId: d.owner_user_id },
    title: "Top-up not completed",
    body: `Your top-up of ${formatMoney(String(d.amount))} ${d.currency} ${
      outcome === "failed"
        ? "failed"
        : outcome === "expired"
          ? "expired"
          : "was cancelled"
    }. Nothing was added to your wallet and the mission funding is unchanged.`,
    eventId: `topup_incomplete:${d.id}`,
    entityType: "wallet_deposit",
    entityId: d.id,
    missionId: d.mission_id,
  });
}

export class DepositService {
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

  async createDeposit(input: CreateDepositInput): Promise<DepositView> {
    const { tenantId, owner } = input;

    // 1. Agent principals never create deposits (Money_Boundary). One audit row, no deposit.
    if (owner.type !== "user") {
      await recordRefusal(this.db, {
        tenantId,
        principal: { type: "agent", id: owner.id, role: String(owner.role) },
        operation: "wallet.deposit.create",
        reasons: ["agent_direct_request"],
        correlationId: input.correlationId,
      });
      throw new ForbiddenActionError(
        "Agents cannot create deposits. A person must fund the wallet.",
      );
    }
    if (owner.tenantId !== tenantId) throw new NotFoundError("Mission");

    // 2. No payee or recipient of any kind (R2.14). Checked on the raw input object.
    for (const key of Object.keys(
      input as unknown as Record<string, unknown>,
    )) {
      if (FORBIDDEN_FIELD_RE.test(key)) {
        throw new ValidationError(
          "A deposit cannot set a payee or payout recipient.",
          { field: key },
        );
      }
    }

    // 3. Field validation (R2.1 to R2.3, R16.10). No row, no PayPal call on failure.
    const key = input.idempotencyKey;
    if (typeof key !== "string" || key.length < 1 || key.length > 200) {
      throw new ValidationError(
        "An Idempotency-Key of 1 to 200 characters is required.",
        { field: "idempotency_key" },
      );
    }
    const currency =
      typeof input.currency === "string" ? input.currency.toUpperCase() : "";
    if (!walletCurrencies().includes(currency)) {
      throw new ValidationError(
        "This currency is not supported for deposits.",
        {
          field: "currency",
          supported: walletCurrencies(),
        },
      );
    }
    const parsed = parseMoney(input.amount, { positive: true, currency });
    if (!parsed.ok) {
      throw new ValidationError("The deposit amount is not valid.", {
        field: "amount",
        reason: parsed.reason,
      });
    }
    if (parsed.decimal.gt(walletMaxDeposit())) {
      throw new ValidationError(
        "The deposit amount exceeds the maximum per deposit.",
        {
          field: "amount",
          reason: "EXCEEDS_MAX_DEPOSIT",
          max: walletMaxDeposit(),
        },
      );
    }
    const amount = parsed.value;
    // Final gate: PayPal's own two-decimal rule.
    const paypalAmount = toPayPalAmount(amount, "Deposit amount");

    // 4. Mission ownership (R2.12, R2.13): same generic answer for missing and foreign missions.
    let missionId: string | null = null;
    if (input.missionId !== undefined && input.missionId !== null) {
      if (
        typeof input.missionId !== "string" ||
        !UUID_RE.test(input.missionId)
      ) {
        throw new NotFoundError("Mission");
      }
      const m = await this.db.query<{ id: string; currency: string }>(
        `SELECT m.id, m.currency
           FROM missions m JOIN agents a ON a.id = m.buyer_id
          WHERE m.id = $1 AND m.tenant_id = $2 AND a.tenant_id = $2 AND a.owner_user_id = $3`,
        [input.missionId, tenantId, owner.id],
      );
      if (!m.rows[0]) throw new NotFoundError("Mission");
      if (m.rows[0].currency !== currency) {
        throw new ValidationError(
          "The deposit currency must match the mission currency.",
          { field: "currency" },
        );
      }
      missionId = m.rows[0].id;
    }

    // 5. Funding mode (R17.3): wallet deposits exist only in wallet mode.
    if ((await getFundingMode(this.db, tenantId)) !== "wallet") {
      throw new StoatError(
        "WALLET_NOT_ENABLED",
        "The wallet is not enabled for this workspace.",
        409,
      );
    }

    // 6. PayPal configured (R2.7): before any insert or call. No simulated outcome.
    const gateway = this.gateway;
    if (gateway instanceof UnconfiguredPayPalGateway) {
      throw new PayPalApiError(
        "PAYPAL_NOT_CONFIGURED",
        "PayPal is not configured. Deposits are unavailable.",
        503,
      );
    }
    const environment = gateway.environment;

    // 7. Intent first, in its own transaction (R2.9, R2.10).
    const requestHash = depositRequestHash(amount, currency, missionId);
    const requestId = deriveDepositRequestId(tenantId, owner.id, key);
    const wallet = await getOrCreateWallet(this.db, {
      tenantId,
      ownerUserId: owner.id,
      currency,
      environment,
    });
    const depositId = randomUUID();
    const intent = await transaction(async (tx) => {
      const ins = await tx.query(
        `INSERT INTO wallet_deposits
           (id, tenant_id, wallet_id, owner_user_id, mission_id, is_top_up, provider, amount, currency,
            status, idempotency_key, request_hash, paypal_request_id, paypal_environment, return_origin)
         VALUES ($1, $2, $3, $4, $5, $6, 'paypal', $7, $8, 'creating', $9, $10, $11, $12, $13)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          depositId,
          tenantId,
          wallet.id,
          owner.id,
          missionId,
          !!input.isTopUp,
          amount,
          currency,
          key,
          requestHash,
          requestId,
          environment,
          input.returnOrigin ?? null,
        ],
      );
      if (ins.rows[0]) return { row: ins.rows[0], created: true };
      const ex = await tx.query(
        `SELECT * FROM wallet_deposits
          WHERE tenant_id = $1 AND owner_user_id = $2 AND idempotency_key = $3`,
        [tenantId, owner.id, key],
      );
      return { row: ex.rows[0], created: false };
    });

    if (!intent.created) {
      // Same key: same parameters return the original, anything else conflicts. No PayPal call.
      if (!intent.row || intent.row.request_hash !== requestHash) {
        throw new IdempotencyConflictError();
      }
      return toDepositView(intent.row);
    }

    // 8. PayPal call: no database transaction is open (R16.9).
    const correlationId = input.correlationId ?? randomUUID();
    let order;
    try {
      order = await callWithOneRetry(
        () =>
          gateway.createOrder({
            amount: paypalAmount,
            currency,
            customId: `wallet:${depositId}`,
            invoiceId: `WALLET-${depositId}`,
            description: "Stoat wallet deposit",
            requestId,
            buyerUserAgent: input.buyerUserAgent,
          }),
        {
          action: "create deposit order",
          correlationId,
          environment,
          requestId,
          validate: (o) => !!o && typeof o.id === "string" && o.id.length > 0,
        },
      );
    } catch (err) {
      const code = err instanceof StoatError ? err.code : "PAYPAL_BAD_RESPONSE";
      await this.markCreationFailed(depositId, tenantId, owner.id, code);
      await recordPayPalFailureEvent({
        tenantId,
        aggregateType: "wallet_deposit",
        aggregateId: depositId,
        eventType: "DEPOSIT_CREATION_FAILED",
        actorRole: "owner",
        actorId: owner.id,
        correlationId,
        amount,
        currency,
        errorCode: code,
        environment,
        paypal: { requestId },
      }).catch(() => undefined);
      throw err;
    }

    // 9. No approval URL: not an awaiting_approval deposit (R2.6).
    if (!order.approveUrl) {
      await this.markCreationFailed(
        depositId,
        tenantId,
        owner.id,
        "PAYPAL_BAD_RESPONSE",
      );
      await recordPayPalFailureEvent({
        tenantId,
        aggregateType: "wallet_deposit",
        aggregateId: depositId,
        eventType: "DEPOSIT_CREATION_FAILED",
        actorRole: "owner",
        actorId: owner.id,
        correlationId,
        amount,
        currency,
        errorCode: "PAYPAL_BAD_RESPONSE",
        environment,
        paypal: { orderId: order.id, requestId },
      }).catch(() => undefined);
      throw new PayPalApiError(
        "PAYPAL_BAD_RESPONSE",
        "PayPal did not return an approval link for this deposit.",
        502,
        { environment, correlation_id: correlationId, request_id: requestId },
      );
    }

    // 10. Store order, approval URL and environment; event in the same transaction (R2.5).
    const row = await transaction(async (tx) => {
      const upd = await tx.query(
        `UPDATE wallet_deposits
            SET status = 'awaiting_approval', paypal_order_id = $2, approve_url = $3,
                paypal_environment = $4, updated_at = now()
          WHERE id = $1 AND status = 'creating'
          RETURNING *`,
        [depositId, order.id, order.approveUrl, environment],
      );
      if (!upd.rows[0]) {
        const cur = await tx.query(
          `SELECT * FROM wallet_deposits WHERE id = $1`,
          [depositId],
        );
        return cur.rows[0];
      }
      await appendWalletEvent(tx, {
        tenantId,
        aggregateType: "wallet_deposit",
        aggregateId: depositId,
        eventType: "DEPOSIT_ORDER_CREATED",
        actorRole: "owner",
        actorId: owner.id,
        correlationId,
        amount,
        currency,
        paypal: { orderId: order.id, requestId },
        details: {
          wallet_id: wallet.id,
          mission_id: missionId,
          paypal_environment: environment,
        },
      });
      return upd.rows[0];
    });
    return toDepositView(row);
  }

  // ---------------------------------------------------------------------------
  // Capture, sync, expiry and sweep (task 8.2)
  //
  // Money boundary: these paths run only from the PayPal return, the verified webhook and the
  // sweep. No agent value (amount, currency, capture, state) is read anywhere here. What is
  // credited is what PayPal reported, and only when it equals what the Owner asked for.
  // PayPal is always called with no database transaction open (R16.9).
  // ---------------------------------------------------------------------------

  /** Capture (or synchronise) the deposit that owns this PayPal order. Null = order rejected. */
  async captureByOrder(
    input: CaptureByOrderInput,
  ): Promise<DepositView | null> {
    const correlationId = input.correlationId ?? randomUUID();
    const row = await this.resolveByOrder(input, correlationId);
    if (!row) return null;
    return this.drive(row, input.source, "capture", correlationId);
  }

  /** Poll PayPal for one deposit and apply what it reports. Used by the sweep and manual refresh. */
  async syncDeposit(
    depositId: string,
    source: CaptureSource = "sweep",
    correlationId: string = randomUUID(),
  ): Promise<DepositView> {
    const r = await this.db.query(
      `SELECT * FROM wallet_deposits WHERE id = $1`,
      [depositId],
    );
    if (!r.rows[0]) throw new NotFoundError("Deposit");
    return this.drive(r.rows[0], source, "poll", correlationId);
  }

  /** The Owner cancelled at PayPal. Only an order still awaiting approval can be cancelled. */
  async cancelByOrder(
    input: Omit<CaptureByOrderInput, "source">,
  ): Promise<DepositView | null> {
    const correlationId = input.correlationId ?? randomUUID();
    const row = await this.resolveByOrder(
      { ...input, source: "return" },
      correlationId,
    );
    if (!row) return null;
    if (row.status !== "awaiting_approval") return toDepositView(row);
    const updated = await transaction(async (tx) => {
      const cur = (
        await tx.query(
          `SELECT * FROM wallet_deposits WHERE id = $1 FOR UPDATE`,
          [row.id],
        )
      ).rows[0];
      if (!cur || cur.status !== "awaiting_approval") return cur;
      const upd = (
        await tx.query(
          `UPDATE wallet_deposits SET status = 'cancelled', failure_reason = 'cancelled_by_buyer',
                  updated_at = now() WHERE id = $1 RETURNING *`,
          [row.id],
        )
      ).rows[0];
      await appendWalletEvent(tx, {
        tenantId: row.tenant_id,
        aggregateType: "wallet_deposit",
        aggregateId: row.id,
        eventType: "DEPOSIT_CANCELLED",
        actorRole: "system",
        actorId: SYSTEM_ACTOR,
        correlationId,
        amount: formatMoney(String(row.amount)),
        currency: row.currency,
        paypal: { orderId: row.paypal_order_id },
      });
      await notifyTopUpIncomplete(tx, upd, "cancelled");
      return upd;
    });
    return toDepositView(updated);
  }

  /**
   * One sweep tick: recover stale `creating` rows, then sync every open deposit. Per-deposit
   * failures are counted inside `drive`; they never stop the rest of the sweep.
   */
  async sweep(): Promise<{ synced: number; recovered: number }> {
    if (this.gateway instanceof UnconfiguredPayPalGateway)
      return { synced: 0, recovered: 0 };
    const recovered = await this.recoverStaleCreating();
    const open = await this.db.query<{ id: string }>(
      `SELECT id FROM wallet_deposits
        WHERE status IN ('awaiting_approval', 'awaiting_capture') AND paypal_environment = $1
        ORDER BY created_at LIMIT 100`,
      [this.gateway.environment],
    );
    let synced = 0;
    for (const { id } of open.rows) {
      try {
        await this.syncDeposit(id, "sweep");
        synced += 1;
      } catch {
        /* counted in drive(); continue with the next deposit */
      }
    }
    return { synced, recovered };
  }

  /**
   * A `creating` row that outlived its request (crash between insert and PayPal call). Replay
   * createOrder with the SAME PayPal request ID: PayPal returns the original order, so no second
   * order exists. Abandoned rows older than the order TTL end as creation_failed.
   */
  async recoverStaleCreating(): Promise<number> {
    const gateway = this.gateway;
    if (gateway instanceof UnconfiguredPayPalGateway) return 0;
    const stale = await this.db.query(
      `SELECT * FROM wallet_deposits
        WHERE status = 'creating' AND paypal_environment = $1
          AND created_at < now() - ($2::int * interval '1 millisecond')
        ORDER BY created_at LIMIT 50`,
      [gateway.environment, DEPOSIT_CREATING_STALE_MS],
    );
    let recovered = 0;
    for (const row of stale.rows) {
      const correlationId = randomUUID();
      if (
        Date.now() - new Date(row.created_at).getTime() >
        DEPOSIT_ORDER_TTL_MS
      ) {
        await this.markCreationFailed(
          row.id,
          row.tenant_id,
          row.owner_user_id,
          "abandoned",
        );
        continue;
      }
      try {
        const amount = formatMoney(String(row.amount));
        const order = await callWithOneRetry(
          () =>
            gateway.createOrder({
              amount: toPayPalAmount(amount, "Deposit amount"),
              currency: row.currency,
              customId: `wallet:${row.id}`,
              invoiceId: `WALLET-${row.id}`,
              description: "Stoat wallet deposit",
              requestId: row.paypal_request_id,
            }),
          {
            action: "recover deposit order",
            correlationId,
            environment: gateway.environment,
            requestId: row.paypal_request_id,
            validate: (o) => !!o && typeof o.id === "string" && o.id.length > 0,
          },
        );
        if (!order.approveUrl) {
          await this.markCreationFailed(
            row.id,
            row.tenant_id,
            row.owner_user_id,
            "PAYPAL_BAD_RESPONSE",
          );
          continue;
        }
        await transaction(async (tx) => {
          const upd = await tx.query(
            `UPDATE wallet_deposits
                SET status = 'awaiting_approval', paypal_order_id = $2, approve_url = $3,
                    paypal_environment = $4, updated_at = now()
              WHERE id = $1 AND status = 'creating' RETURNING id`,
            [row.id, order.id, order.approveUrl, gateway.environment],
          );
          if (!upd.rows[0]) return;
          await appendWalletEvent(tx, {
            tenantId: row.tenant_id,
            aggregateType: "wallet_deposit",
            aggregateId: row.id,
            eventType: "DEPOSIT_ORDER_CREATED",
            actorRole: "system",
            actorId: SYSTEM_ACTOR,
            correlationId,
            amount,
            currency: row.currency,
            paypal: { orderId: order.id, requestId: row.paypal_request_id },
            details: { wallet_id: row.wallet_id, recovered: true },
          });
        });
        recovered += 1;
      } catch (err) {
        // Transient: try again next tick. Anything else will never succeed.
        if (!isTransientError(err)) {
          const code =
            err instanceof StoatError ? err.code : "PAYPAL_BAD_RESPONSE";
          await this.markCreationFailed(
            row.id,
            row.tenant_id,
            row.owner_user_id,
            code,
          );
        }
      }
    }
    return recovered;
  }

  /** Find the deposit for an order, or audit the refusal and return null (R3.16). */
  private async resolveByOrder(
    input: CaptureByOrderInput,
    correlationId: string,
  ): Promise<any | null> {
    const orderId = typeof input.orderId === "string" ? input.orderId : "";
    const r = orderId
      ? await this.db.query(
          `SELECT * FROM wallet_deposits WHERE paypal_order_id = $1`,
          [orderId],
        )
      : { rows: [] as any[] };
    const row = r.rows[0];
    const reasons: string[] = [];
    if (!row) reasons.push("unknown_order");
    else {
      if (input.tenantId && row.tenant_id !== input.tenantId)
        reasons.push("tenant_mismatch");
      if (input.customId && input.customId !== `wallet:${row.id}`)
        reasons.push("custom_id_mismatch");
      if (row.paypal_environment !== this.gateway.environment)
        reasons.push("environment_mismatch");
    }
    if (reasons.length === 0) return row;

    const tenantId = input.tenantId ?? row?.tenant_id;
    if (tenantId) {
      await recordRefusal(this.db, {
        tenantId,
        principal: { type: "system", id: SYSTEM_ACTOR, role: input.source },
        operation: "wallet.deposit.capture",
        walletId: row && row.tenant_id === tenantId ? row.wallet_id : null,
        reasons,
        correlationId,
      }).catch(() => undefined);
    } else {
      // No tenant to attach an audit row to (audit_logs.tenant_id is required).
      console.warn(
        JSON.stringify({
          event: "wallet_capture_rejected",
          reasons,
          correlation_id: correlationId,
        }),
      );
    }
    return null;
  }

  /** Run one trigger for one deposit: PayPal call (no transaction), then apply under locks. */
  private async drive(
    row: any,
    source: CaptureSource,
    mode: "capture" | "poll",
    correlationId: string,
  ): Promise<DepositView> {
    // Terminal states (R3.18) and rows that have no order yet: no PayPal call, no change.
    if (
      TERMINAL.has(row.status) ||
      row.status === "creating" ||
      !row.paypal_order_id
    ) {
      return toDepositView(row);
    }
    const gateway = this.gateway;
    const environment = gateway.environment;
    const requestId = `wallet-cap-${row.id}`;
    const call = <T>(
      action: string,
      fn: () => Promise<T>,
      validate?: (r: any) => boolean,
    ) =>
      callWithOneRetry(fn, {
        action,
        correlationId,
        environment,
        requestId,
        validate,
      });
    const validCapture = (c: any) => !!c && typeof c === "object";

    let cap: GatewayCapture | null = null;
    try {
      if (row.status === "awaiting_capture" && row.paypal_capture_id) {
        cap = await call(
          "read capture",
          () => gateway.getCapture(row.paypal_capture_id),
          validCapture,
        );
      } else {
        if (mode === "poll") {
          let order: GatewayCapture | null = null;
          try {
            order = await call(
              "read order",
              () => gateway.getOrder(row.paypal_order_id),
              validCapture,
            );
          } catch (err) {
            if (isNotFoundError(err) && row.status === "awaiting_approval") {
              return await this.expire(row, "order_not_found", correlationId);
            }
            throw err;
          }
          const os = String(order!.orderStatus ?? "").toUpperCase();
          if (os === "VOIDED" && row.status === "awaiting_approval") {
            return await this.expire(row, "order_voided", correlationId);
          }
          if (os === "COMPLETED" && order!.captureId) {
            cap = order;
          } else if (os !== "APPROVED" && os !== "COMPLETED") {
            // Not approved yet. A never-approved order lapses after 3 hours (R3.10).
            if (
              row.status === "awaiting_approval" &&
              Date.now() - new Date(row.created_at).getTime() >
                DEPOSIT_ORDER_TTL_MS
            ) {
              return await this.expire(
                row,
                "not_approved_in_time",
                correlationId,
              );
            }
            return await this.touch(row);
          }
        }
        if (!cap) {
          cap = await call(
            "capture order",
            () => gateway.captureOrder(row.paypal_order_id, requestId),
            validCapture,
          );
        }
      }
    } catch (err) {
      if (isTransientError(err) && source === "sweep") {
        await this.recordTransientFailure(row, correlationId).catch(
          () => undefined,
        );
      }
      // PayPal says "not yet" (for example the buyer has not approved): leave the deposit as is.
      if (
        !isTransientError(err) &&
        !isNotFoundError(err) &&
        err instanceof PayPalApiError
      ) {
        const fresh = await this.db.query(
          `SELECT * FROM wallet_deposits WHERE id = $1`,
          [row.id],
        );
        return toDepositView(fresh.rows[0] ?? row);
      }
      throw err;
    }

    return this.apply(row.id, cap!, source, correlationId, requestId);
  }

  /** Apply a PayPal-reported capture under a deposit then wallet lock, re-checking the status. */
  private async apply(
    depositId: string,
    cap: GatewayCapture,
    source: CaptureSource,
    correlationId: string,
    requestId: string,
  ): Promise<DepositView> {
    const outcome = await transaction(async (tx) => {
      const d = (
        await tx.query(
          `SELECT * FROM wallet_deposits WHERE id = $1 FOR UPDATE`,
          [depositId],
        )
      ).rows[0];
      if (!d) throw new NotFoundError("Deposit");
      // Another trigger got here first: return its terminal state, change nothing (R3.11, R3.18).
      if (TERMINAL.has(d.status)) return { row: d, rejected: false };
      await tx.query(`SELECT id FROM wallets WHERE id = $1 FOR UPDATE`, [
        d.wallet_id,
      ]);

      const amount = formatMoney(String(d.amount));
      const base = {
        tenantId: d.tenant_id,
        aggregateType: "wallet_deposit" as const,
        aggregateId: d.id,
        actorRole: "system" as const,
        actorId: SYSTEM_ACTOR,
        correlationId,
        currency: d.currency as string,
      };
      const ids = {
        orderId: d.paypal_order_id as string,
        captureId: cap.captureId,
        requestId,
      };
      const link = {
        entityType: "wallet_deposit",
        entityId: d.id,
        missionId: d.mission_id,
      };

      // A capture that names another deposit is not ours: refuse, change nothing.
      if (cap.customId && cap.customId !== `wallet:${d.id}`)
        return { row: d, rejected: true };

      const status = String(cap.captureStatus ?? "").toUpperCase();
      let capturedAmount: Decimal | null = null;
      try {
        if (cap.amount != null) capturedAmount = new Decimal(cap.amount);
      } catch {
        capturedAmount = null;
      }

      // --- failed: no capture ID, DECLINED or FAILED (R3.7) ---
      if (!cap.captureId || status === "DECLINED" || status === "FAILED") {
        const reason = !cap.captureId ? "no_capture_id" : status.toLowerCase();
        const row = (
          await tx.query(
            `UPDATE wallet_deposits SET status = 'failed', failure_reason = $2,
                    capture_attempts = 0, last_checked_at = now(), updated_at = now()
              WHERE id = $1 RETURNING *`,
            [d.id, reason],
          )
        ).rows[0];
        await appendWalletEvent(tx, {
          ...base,
          eventType: "DEPOSIT_FAILED",
          amount,
          paypal: ids,
          details: { reason, source },
        });
        if (d.is_top_up) {
          await notifyTopUpIncomplete(tx, d, "failed");
        } else {
          await notifyInTx(tx, {
            tenantId: d.tenant_id,
            kind: "deposit_failed",
            recipient: { userId: d.owner_user_id },
            title: "Deposit failed",
            body: `Your deposit of ${amount} ${d.currency} did not complete. Nothing was added to your wallet.`,
            eventId: `deposit_failed:${d.id}`,
            ...link,
          });
        }
        return { row, rejected: false };
      }

      // --- completed ---
      if (status === "COMPLETED") {
        const matches =
          capturedAmount !== null &&
          capturedAmount.eq(new Decimal(String(d.amount))) &&
          String(cap.currency ?? "").toUpperCase() === d.currency;

        if (!matches) {
          // R3.5: no credit, no ledger entry, Admin notice with both figures.
          const shown = capturedAmount
            ? capturedAmount.toFixed()
            : "unreadable";
          const row = (
            await tx.query(
              `UPDATE wallet_deposits SET status = 'mismatch', paypal_capture_id = $2,
                      captured_amount = $3, captured_currency = $4, failure_reason = 'amount_or_currency_mismatch',
                      capture_attempts = 0, last_checked_at = now(), updated_at = now()
                WHERE id = $1 RETURNING *`,
              [
                d.id,
                cap.captureId,
                capturedAmount ? capturedAmount.toFixed() : null,
                cap.currency ?? null,
              ],
            )
          ).rows[0];
          await appendWalletEvent(tx, {
            ...base,
            eventType: "DEPOSIT_MISMATCH",
            amount,
            paypal: ids,
            details: {
              expected_amount: amount,
              expected_currency: d.currency,
              captured_amount: shown,
              captured_currency: cap.currency ?? null,
              source,
            },
          });
          await notifyInTx(tx, {
            tenantId: d.tenant_id,
            kind: "deposit_mismatch",
            recipient: { admins: true },
            title: "Deposit amount mismatch",
            body: `Deposit ${d.id} expected ${amount} ${d.currency} but PayPal captured ${shown} ${cap.currency ?? "unknown"}. The wallet was not credited.`,
            eventId: `deposit_mismatch:${d.id}`,
            ...link,
          });
          return { row, rejected: false };
        }

        // R3.4: captured + credit + balanced ledger entry, one transaction.
        const credited = capturedAmount!.toFixed();
        let fee: Decimal | null = null;
        try {
          if (cap.paypalFee != null) fee = new Decimal(cap.paypalFee);
        } catch {
          fee = null;
        }
        if (fee && (fee.lte(0) || fee.gt(capturedAmount!))) fee = null;

        const row = (
          await tx.query(
            `UPDATE wallet_deposits
                SET status = 'captured', paypal_capture_id = $2, captured_amount = $3,
                    captured_currency = $4, credited_amount = $3, paypal_fee = $5,
                    captured_at = now(), failure_reason = NULL, capture_attempts = 0,
                    last_checked_at = now(), updated_at = now()
              WHERE id = $1 RETURNING *`,
            [
              d.id,
              cap.captureId,
              credited,
              d.currency,
              fee ? fee.toFixed() : null,
            ],
          )
        ).rows[0];
        const ev = await appendWalletEvent(tx, {
          ...base,
          eventType: "DEPOSIT_CAPTURED",
          amount: credited,
          paypal: ids,
          details: { wallet_id: d.wallet_id, mission_id: d.mission_id, source },
        });
        await postJournal(tx, {
          tenantId: d.tenant_id,
          eventId: ev.id,
          reference: `wallet:deposit:${d.id}`,
          currency: d.currency,
          lines: [
            { accountCode: "1101", side: "debit", amount: credited },
            {
              accountCode: "2103",
              side: "credit",
              amount: credited,
              walletId: d.wallet_id,
            },
          ],
        });
        if (fee) {
          const feeEv = await appendWalletEvent(tx, {
            ...base,
            eventType: "DEPOSIT_FEE_RECORDED",
            amount: fee.toFixed(),
            paypal: ids,
            details: { wallet_id: d.wallet_id },
          });
          await postJournal(tx, {
            tenantId: d.tenant_id,
            eventId: feeEv.id,
            reference: `wallet:deposit-fee:${d.id}`,
            currency: d.currency,
            lines: [
              { accountCode: "5101", side: "debit", amount: fee.toFixed() },
              { accountCode: "1101", side: "credit", amount: fee.toFixed() },
            ],
          });
        }
        await notifyInTx(tx, {
          tenantId: d.tenant_id,
          kind: "deposit_captured",
          recipient: { userId: d.owner_user_id },
          title: "Deposit received",
          body: `${formatMoney(credited)} ${d.currency} was added to your wallet.`,
          eventId: `deposit_captured:${d.id}:owner`,
          ...link,
        });
        await notifyInTx(tx, {
          tenantId: d.tenant_id,
          kind: "deposit_captured",
          recipient: { admins: true },
          title: "Wallet deposit captured",
          body: `Deposit ${d.id} by owner ${d.owner_user_id}: ${formatMoney(credited)} ${d.currency}, PayPal capture ${cap.captureId}.`,
          eventId: `deposit_captured:${d.id}:admins`,
          ...link,
        });
        // R7.9, R7.10: the credit can lift missions out of depletion; same transaction.
        await recomputeWalletMissions(tx, d.wallet_id, d.mission_id);
        return { row, rejected: false };
      }

      // --- PENDING (or any other non-final status): wait, never credit (R3.6) ---
      const wasApproval = d.status === "awaiting_approval";
      const row = (
        await tx.query(
          `UPDATE wallet_deposits
              SET status = 'awaiting_capture',
                  paypal_capture_id = COALESCE(paypal_capture_id, $2),
                  capture_attempts = 0, last_checked_at = now(), updated_at = now()
            WHERE id = $1 RETURNING *`,
          [d.id, cap.captureId],
        )
      ).rows[0];
      if (wasApproval) {
        await appendWalletEvent(tx, {
          ...base,
          eventType: "DEPOSIT_AWAITING_CAPTURE",
          amount,
          paypal: ids,
          details: { capture_status: status || null, source },
        });
      }
      return { row, rejected: false };
    });

    if (outcome.rejected) {
      await recordRefusal(this.db, {
        tenantId: outcome.row.tenant_id,
        principal: { type: "system", id: SYSTEM_ACTOR, role: source },
        operation: "wallet.deposit.capture",
        walletId: outcome.row.wallet_id,
        reasons: ["custom_id_mismatch"],
        correlationId,
      }).catch(() => undefined);
    }
    return toDepositView(outcome.row);
  }

  /** Expire an unapproved deposit (R3.10). Re-checks the status under the lock. */
  private async expire(
    row: any,
    reason: string,
    correlationId: string,
  ): Promise<DepositView> {
    const updated = await transaction(async (tx) => {
      const cur = (
        await tx.query(
          `SELECT * FROM wallet_deposits WHERE id = $1 FOR UPDATE`,
          [row.id],
        )
      ).rows[0];
      if (!cur || cur.status !== "awaiting_approval") return cur ?? row;
      const upd = (
        await tx.query(
          `UPDATE wallet_deposits SET status = 'expired', failure_reason = $2,
                  last_checked_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
          [row.id, reason],
        )
      ).rows[0];
      await appendWalletEvent(tx, {
        tenantId: row.tenant_id,
        aggregateType: "wallet_deposit",
        aggregateId: row.id,
        eventType: "DEPOSIT_EXPIRED",
        actorRole: "system",
        actorId: SYSTEM_ACTOR,
        correlationId,
        amount: formatMoney(String(row.amount)),
        currency: row.currency,
        paypal: { orderId: row.paypal_order_id },
        details: { reason },
      });
      await notifyTopUpIncomplete(tx, upd, "expired");
      return upd;
    });
    return toDepositView(updated);
  }

  /** PayPal answered and the deposit is still open: reset the transient-failure streak. */
  private async touch(row: any): Promise<DepositView> {
    const r = await this.db.query(
      `UPDATE wallet_deposits SET capture_attempts = 0, last_checked_at = now()
        WHERE id = $1 AND status IN ('awaiting_approval', 'awaiting_capture') RETURNING *`,
      [row.id],
    );
    return toDepositView(r.rows[0] ?? row);
  }

  /** Count one failed sweep attempt; raise `deposit_stuck` once at 10 (R3.17). */
  private async recordTransientFailure(
    row: any,
    correlationId: string,
  ): Promise<void> {
    await transaction(async (tx) => {
      const cur = (
        await tx.query(
          `SELECT * FROM wallet_deposits WHERE id = $1 FOR UPDATE`,
          [row.id],
        )
      ).rows[0];
      if (!cur || TERMINAL.has(cur.status)) return;
      const attempts = Number(cur.capture_attempts) + 1;
      await tx.query(
        `UPDATE wallet_deposits SET capture_attempts = $2, last_checked_at = now(), updated_at = now()
          WHERE id = $1`,
        [row.id, attempts],
      );
      if (attempts >= DEPOSIT_MAX_SWEEP_ATTEMPTS) {
        if (attempts === DEPOSIT_MAX_SWEEP_ATTEMPTS) {
          await appendWalletEvent(tx, {
            tenantId: cur.tenant_id,
            aggregateType: "wallet_deposit",
            aggregateId: cur.id,
            eventType: "DEPOSIT_STUCK",
            actorRole: "system",
            actorId: SYSTEM_ACTOR,
            correlationId,
            currency: cur.currency,
            paypal: { orderId: cur.paypal_order_id },
            details: { attempts },
          });
        }
        await notifyInTx(tx, {
          tenantId: cur.tenant_id,
          kind: "deposit_stuck",
          recipient: { admins: true },
          title: "Deposit stuck",
          body: `Deposit ${cur.id} could not be confirmed with PayPal after ${DEPOSIT_MAX_SWEEP_ATTEMPTS} attempts.`,
          eventId: `deposit_stuck:${cur.id}`,
          entityType: "wallet_deposit",
          entityId: cur.id,
          missionId: cur.mission_id,
        });
      }
    });
  }

  private async markCreationFailed(
    depositId: string,
    tenantId: string,
    ownerId: string,
    reason: string,
  ): Promise<void> {
    await transaction(async (tx) => {
      await tx.query(
        `UPDATE wallet_deposits
            SET status = 'creation_failed', failure_reason = $2, updated_at = now()
          WHERE id = $1 AND tenant_id = $3 AND owner_user_id = $4 AND status = 'creating'`,
        [depositId, reason, tenantId, ownerId],
      );
    });
  }
}
