import { Decimal } from "decimal.js";
import { ForbiddenActionError } from "../../common/errors.js";
import type { DbClient } from "../../db/connection.js";
import { getFundingMode } from "../wallet/funding-mode.js";
import { getBalances } from "../wallet/wallet.service.js";
import { notifyInTx } from "../wallet/notification.service.js";
import { assertFlag } from "../agentic/feature-flags.js";
import { MandateRefusalError } from "../agentic/commerce-errors.js";
import { appendCommerceEvent } from "../agentic/commerce-events.js";
import { getMandateUsage } from "./mandate-usage.js";
import {
  evaluateMandate,
  mandateRemaining,
  type MandateFacts,
} from "./mandate-evaluator.js";
import type { MandateRow } from "./mandate.service.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export async function evaluateMandateInTx(
  tx: DbClient,
  input: {
    tenantId: string;
    mandateId: string;
    missionId: string;
    buyerAgentId: string;
    agreedPrice: string;
    currency: string;
    serviceCategory: string;
    now: Date;
  },
): Promise<{ mandate: MandateRow; remaining: string }> {
  await assertFlag(tx, input.tenantId, "mandates");
  if ((await getFundingMode(tx, input.tenantId)) !== "wallet") {
    throw new MandateRefusalError("MANDATE_REQUIRES_WALLET_MODE");
  }
  const ownerResult = await tx.query<{ owner_user_id: string }>(
    `SELECT owner_user_id FROM agents
     WHERE id = $1 AND tenant_id = $2 AND role = 'buyer'`,
    [input.buyerAgentId, input.tenantId],
  );
  const ownerId = ownerResult.rows[0]?.owner_user_id;
  const found = ownerId
    ? await tx.query<MandateRow>(
        `SELECT m.* FROM mandates m
         JOIN wallets w ON w.id = m.wallet_id AND w.tenant_id = m.tenant_id
         WHERE m.id = $1 AND m.tenant_id = $2 AND m.owner_user_id = $3
           AND w.owner_user_id = $3`,
        [input.mandateId, input.tenantId, ownerId],
      )
    : { rows: [] as MandateRow[] };
  if (!found.rows[0]) throw new ForbiddenActionError();

  const locked = await tx.query<MandateRow>(
    "SELECT * FROM mandates WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
    [input.mandateId, input.tenantId],
  );
  const mandate = locked.rows[0];
  if (!mandate || mandate.owner_user_id !== ownerId) throw new ForbiddenActionError();
  await tx.query("SELECT id FROM wallets WHERE id = $1 FOR UPDATE", [mandate.wallet_id]);
  const usage = await getMandateUsage(tx, mandate.id, input.now);
  const balance = await getBalances(tx, mandate.wallet_id);
  const facts: MandateFacts = {
    status: mandate.status,
    expiresAt: new Date(mandate.expires_at),
    currency: mandate.currency,
    perAgreementMax: new Decimal(mandate.per_agreement_max),
    dailyCap: new Decimal(mandate.daily_cap),
    totalCap: new Decimal(mandate.total_cap),
    categories: new Set(mandate.allowed_categories),
    missionScope: mandate.mission_scope ? new Set(mandate.mission_scope) : null,
    usage: usage.usage,
    todayUsage: usage.todayUsage,
    available: new Decimal(balance.available),
  };
  const evaluation = evaluateMandate(facts, {
    price: new Decimal(input.agreedPrice),
    currency: input.currency,
    category: input.serviceCategory,
    missionId: input.missionId,
    now: input.now,
  });
  if (!evaluation.ok) {
    throw new MandateRefusalError(evaluation.code, {
      mandate_id: mandate.id,
      remaining: mandateRemaining(facts).toFixed(),
    });
  }
  return { mandate, remaining: mandateRemaining(facts).toFixed() };
}

export async function recordAcceptanceInTx(
  tx: DbClient,
  input: {
    tenantId: string;
    mandate: MandateRow;
    quoteId: string;
    agreementId: string;
    reservationId: string;
    agentRunId?: string;
    idempotencyKey: string;
    actorId: string;
    price: string;
    currency: string;
    correlationId?: string;
    now?: Date;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO mandate_acceptances
       (tenant_id, mandate_id, quote_id, agreement_id, reservation_id, agent_run_id, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.tenantId,
      input.mandate.id,
      input.quoteId,
      input.agreementId,
      input.reservationId,
      input.agentRunId ?? null,
      input.idempotencyKey,
    ],
  );
  const usage = await getMandateUsage(tx, input.mandate.id, input.now);
  if (usage.usage.gte(input.mandate.total_cap) && input.mandate.status === "active") {
    await tx.query(
      "UPDATE mandates SET status = 'exhausted', updated_at = now() WHERE id = $1",
      [input.mandate.id],
    );
    await appendCommerceEvent(tx, {
      tenantId: input.tenantId,
      aggregateType: "mandate",
      aggregateId: input.mandate.id,
      eventType: "MANDATE_EXHAUSTED",
      actorType: "system",
      actorId: NIL_UUID,
      details: { usage: usage.usage.toFixed() },
    });
    await notifyInTx(tx, {
      tenantId: input.tenantId,
      kind: "mandate_exhausted",
      recipient: { userId: input.mandate.owner_user_id },
      title: "Mandate spending limit reached",
      body: `Mandate ${input.mandate.id} has reached its total spending limit.`,
      entityType: "mandate",
      entityId: input.mandate.id,
      eventId: `mandate_exhausted:${input.mandate.id}`,
    });
  }
  await appendCommerceEvent(tx, {
    tenantId: input.tenantId,
    aggregateType: "mandate",
    aggregateId: input.mandate.id,
    eventType: "MANDATE_AUTONOMOUS_ACCEPTANCE",
    actorType: "agent",
    actorId: input.actorId,
    correlationId: input.correlationId,
    amount: input.price,
    currency: input.currency,
    details: {
      quote_id: input.quoteId,
      agreement_id: input.agreementId,
      reservation_id: input.reservationId,
      agent_run_id: input.agentRunId ?? null,
    },
    idempotencyKey: `mandate-acceptance:${input.mandate.id}:${input.idempotencyKey}`,
  });
}

export async function reactivateIfUnderCap(
  tx: DbClient,
  input: { tenantId: string; mandateId: string; now?: Date },
): Promise<boolean> {
  const locked = await tx.query<MandateRow>(
    "SELECT * FROM mandates WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
    [input.mandateId, input.tenantId],
  );
  const mandate = locked.rows[0];
  if (!mandate || mandate.status !== "exhausted") return false;
  const now = input.now ?? new Date();
  if (new Date(mandate.expires_at) <= now) return false;
  const usage = await getMandateUsage(tx, mandate.id, now);
  if (usage.usage.gte(mandate.total_cap)) return false;
  await tx.query("UPDATE mandates SET status = 'active', updated_at = $2 WHERE id = $1", [
    mandate.id,
    now.toISOString(),
  ]);
  await appendCommerceEvent(tx, {
    tenantId: input.tenantId,
    aggregateType: "mandate",
    aggregateId: mandate.id,
    eventType: "MANDATE_REACTIVATED",
    actorType: "system",
    actorId: NIL_UUID,
    details: { usage: usage.usage.toFixed() },
  });
  return true;
}
