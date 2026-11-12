import { Decimal } from "decimal.js";

export type MandateStatus = "active" | "expired" | "revoked" | "exhausted" | "suspended";

export interface MandateFacts {
  status: MandateStatus;
  expiresAt: Date;
  currency: string;
  perAgreementMax: Decimal;
  dailyCap: Decimal;
  totalCap: Decimal;
  categories: ReadonlySet<string>;
  missionScope: ReadonlySet<string> | null;
  usage: Decimal;
  todayUsage: Decimal;
  available: Decimal;
}

export interface AcceptanceRequest {
  price: Decimal;
  currency: string;
  category: string;
  missionId: string;
  now: Date;
}

export type MandateRefusalCode =
  | "MANDATE_NOT_ACTIVE"
  | "MANDATE_EXPIRED"
  | "MANDATE_PER_AGREEMENT_EXCEEDED"
  | "MANDATE_TOTAL_EXCEEDED"
  | "MANDATE_DAILY_EXCEEDED"
  | "MANDATE_CATEGORY_NOT_ALLOWED"
  | "MANDATE_MISSION_OUT_OF_SCOPE"
  | "MANDATE_CURRENCY_MISMATCH"
  | "INSUFFICIENT_FUNDS";

export type MandateEvaluation =
  | { ok: true }
  | { ok: false; code: MandateRefusalCode };

export function evaluateMandate(
  facts: MandateFacts,
  request: AcceptanceRequest,
): MandateEvaluation {
  if (facts.status !== "active" && facts.status !== "expired") {
    return { ok: false, code: "MANDATE_NOT_ACTIVE" };
  }
  if (facts.status === "expired" || request.now >= facts.expiresAt) {
    return { ok: false, code: "MANDATE_EXPIRED" };
  }
  if (request.price.gt(facts.perAgreementMax)) {
    return { ok: false, code: "MANDATE_PER_AGREEMENT_EXCEEDED" };
  }
  if (facts.usage.plus(request.price).gt(facts.totalCap)) {
    return { ok: false, code: "MANDATE_TOTAL_EXCEEDED" };
  }
  if (facts.todayUsage.plus(request.price).gt(facts.dailyCap)) {
    return { ok: false, code: "MANDATE_DAILY_EXCEEDED" };
  }
  if (!facts.categories.has(request.category)) {
    return { ok: false, code: "MANDATE_CATEGORY_NOT_ALLOWED" };
  }
  if (facts.missionScope && !facts.missionScope.has(request.missionId)) {
    return { ok: false, code: "MANDATE_MISSION_OUT_OF_SCOPE" };
  }
  if (facts.currency.toUpperCase() !== request.currency.toUpperCase()) {
    return { ok: false, code: "MANDATE_CURRENCY_MISMATCH" };
  }
  if (request.price.gt(facts.available)) {
    return { ok: false, code: "INSUFFICIENT_FUNDS" };
  }
  return { ok: true };
}

export function mandateRemaining(facts: Pick<MandateFacts, "totalCap" | "usage" | "dailyCap" | "todayUsage">): Decimal {
  return Decimal.max(
    0,
    Decimal.min(facts.totalCap.minus(facts.usage), facts.dailyCap.minus(facts.todayUsage)),
  );
}
