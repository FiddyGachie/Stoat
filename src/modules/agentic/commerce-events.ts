import type { DbClient } from "../../db/connection.js";
import { EventsService } from "../events/events.service.js";

export type CommerceAggregate = "mandate" | "hold" | "proposal";

export interface CommerceEventInput {
  tenantId: string;
  aggregateType: CommerceAggregate;
  aggregateId: string;
  eventType: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  correlationId?: string;
  amount?: string;
  currency?: string;
  details: Record<string, unknown>;
  idempotencyKey?: string;
}

export function appendCommerceEvent(
  tx: DbClient,
  input: CommerceEventInput,
): Promise<{ id: string; sequence: number; hash: string }> {
  return new EventsService(tx).appendEvent({
    tenantId: input.tenantId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    actorType: input.actorType,
    actorId: input.actorId,
    correlationId: input.correlationId,
    amount: input.amount,
    currency: input.currency,
    payload: input.details,
    idempotencyKey: input.idempotencyKey,
  });
}
