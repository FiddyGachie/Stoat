/**
 * Mission Budget Wallet: event and audit helpers (Requirement 19).
 *
 * - appendWalletEvent(tx, ...): one Economic_Event for a succeeded outcome, written through the
 *   caller's transaction while the wallet or deposit row lock is held. Nothing is caught here, so
 *   a failed append rolls back the caller's state change (R19.1, R19.3).
 * - recordPayPalFailureEvent(...): failed PayPal operation, own transaction, independent of the
 *   success path (R19.10). Call it OUTSIDE any open transaction (PGlite serialises transactions,
 *   so nesting would wait on itself).
 * - recordRefusal(db, ...): exactly one audit_logs row per refused request, listing every
 *   applicable reason, in its own transaction (R19.4, R19.11). Same calling rule.
 */
import { randomUUID } from "node:crypto";
import { transaction, type DbClient } from "../../db/connection.js";
import { EventsService } from "../events/events.service.js";
import { StoatError } from "../../common/errors.js";

export type WalletAggregateType = "wallet" | "wallet_deposit" | "mission";
export type WalletActorRole = "owner" | "admin" | "agent" | "system";

export interface PayPalIds {
  orderId?: string | null;
  captureId?: string | null;
  refundId?: string | null;
  payoutBatchId?: string | null;
  requestId?: string | null;
}

export interface WalletEventInput {
  tenantId: string;
  aggregateType: WalletAggregateType;
  aggregateId: string;
  eventType: string;
  actorRole: WalletActorRole;
  actorId: string;
  correlationId?: string;
  amount?: string;
  currency?: string;
  paypal?: PayPalIds;
  /** Extra non-secret fields. Reserved keys below always win. */
  details?: Record<string, unknown>;
  idempotencyKey?: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const AGGREGATES: ReadonlySet<string> = new Set([
  "wallet",
  "wallet_deposit",
  "mission",
]);

function paypalPayload(p?: PayPalIds): Record<string, string> {
  const out: Record<string, string> = {};
  if (!p) return out;
  if (p.orderId) out.paypal_order_id = p.orderId;
  if (p.captureId) out.paypal_capture_id = p.captureId;
  if (p.refundId) out.paypal_refund_id = p.refundId;
  if (p.payoutBatchId) out.paypal_payout_batch_id = p.payoutBatchId;
  if (p.requestId) out.paypal_request_id = p.requestId;
  return out;
}

function buildPayload(
  input: WalletEventInput,
  extra: Record<string, unknown> = {},
) {
  return {
    ...(input.details ?? {}),
    ...paypalPayload(input.paypal),
    ...extra,
    actor_role: input.actorRole,
    actor_id: input.actorId,
    tenant_id: input.tenantId,
    event_type: input.eventType,
    amount: input.amount ?? null,
    currency: input.currency ?? null,
  };
}

function toActorType(role: WalletActorRole): "agent" | "user" | "system" {
  return role === "agent" ? "agent" : role === "system" ? "system" : "user";
}

/** Append a succeeded-outcome event using the caller's transaction. Errors propagate. */
export async function appendWalletEvent(
  tx: DbClient,
  input: WalletEventInput,
): Promise<{ id: string; sequence: number; hash: string }> {
  if (!AGGREGATES.has(input.aggregateType)) {
    throw new Error(
      `appendWalletEvent: unsupported aggregate ${input.aggregateType}`,
    );
  }
  return new EventsService(tx).appendEvent({
    tenantId: input.tenantId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    actorType: toActorType(input.actorRole),
    actorId: input.actorId,
    correlationId: input.correlationId,
    amount: input.amount,
    currency: input.currency,
    payload: buildPayload(input),
    idempotencyKey: input.idempotencyKey,
  });
}

/**
 * Record a failed PayPal operation in its own transaction. Only the scrubbed error indication is
 * stored, never the raw error. Nothing is recorded as paid, refunded or deposited (R19.10).
 */
export async function recordPayPalFailureEvent(
  input: Omit<WalletEventInput, "eventType"> & {
    eventType?: string;
    errorCode: string;
    environment?: "sandbox" | "live";
  },
): Promise<{ id: string; sequence: number; hash: string }> {
  const { errorCode, environment, eventType, ...rest } = input;
  return transaction((tx) =>
    appendWalletEvent(tx, {
      ...rest,
      eventType: eventType ?? "PAYPAL_OPERATION_FAILED",
      // A failed operation moves no money.
      amount: undefined,
      details: {
        ...(rest.details ?? {}),
        outcome: "failed",
        error_code: errorCode,
        attempted_amount: rest.amount ?? null,
        ...(environment ? { paypal_environment: environment } : {}),
      },
    }),
  );
}

export interface RefusalInput {
  tenantId: string;
  principal: { type: "user" | "agent" | "system"; id: string; role?: string };
  /** The attempted operation, e.g. "wallet.deposit.create". */
  operation: string;
  /** Target wallet ID when one was named; any non-UUID value is not stored as the target. */
  walletId?: string | null;
  /** Every applicable refusal reason. At least one. */
  reasons: string[];
  correlationId?: string;
  /** Optional non-wallet target (e.g. a legacy spending budget). Stored as the audit resource. */
  resource?: { type: string; id: string };
}

/**
 * Write exactly one audit_logs row for a refused request, with all applicable reasons.
 * Runs in its own transaction; call it outside any open transaction.
 */
export async function recordRefusal(
  _db: DbClient,
  input: RefusalInput,
): Promise<{ id: string }> {
  const reasons = [
    ...new Set(input.reasons.map((r) => r.trim()).filter(Boolean)),
  ];
  if (reasons.length === 0) {
    throw new StoatError(
      "INTERNAL_ERROR",
      "recordRefusal requires at least one reason",
      500,
    );
  }
  const actorId = UUID_RE.test(input.principal.id)
    ? input.principal.id
    : NIL_UUID;
  const wallet =
    input.walletId && UUID_RE.test(input.walletId) ? input.walletId : null;
  const correlationId =
    input.correlationId && UUID_RE.test(input.correlationId)
      ? input.correlationId
      : randomUUID();
  const resourceType = input.resource?.type ?? "wallet";
  const resourceId =
    input.resource && UUID_RE.test(input.resource.id)
      ? input.resource.id
      : (wallet ?? NIL_UUID);

  return transaction(async (tx) => {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO audit_logs (
         id, tenant_id, actor_type, actor_id, action, resource_type, resource_id,
         correlation_id, outcome, reason, metadata
       ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $9, $5, $6, 'refused', $7, $8)
       RETURNING id`,
      [
        input.tenantId,
        input.principal.type,
        actorId,
        input.operation,
        resourceId,
        correlationId,
        reasons.join(","),
        JSON.stringify({
          operation: input.operation,
          principal_type: input.principal.type,
          principal_id: actorId,
          principal_role: input.principal.role ?? null,
          target_wallet_id: wallet,
          ...(input.resource
            ? { resource_type: resourceType, resource_id: resourceId }
            : {}),
          reasons,
        }),
        resourceType,
      ],
    );
    return { id: res.rows[0].id };
  });
}
