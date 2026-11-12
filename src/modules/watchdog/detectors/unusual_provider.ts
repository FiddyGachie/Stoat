import { Decimal } from "decimal.js";
import type { DetectorResult, UnusualProviderFact } from "./types.js";

export interface UnusualProviderThreshold {
  min_price: string;
}

export function evaluate(
  facts: readonly UnusualProviderFact[],
  threshold: UnusualProviderThreshold,
  _now: Date,
): DetectorResult {
  const minPrice = new Decimal(threshold.min_price);
  const findings = facts.flatMap((fact) => {
    const price = new Decimal(fact.price);
    if (!fact.firstAgreement || !price.gt(minPrice)) return [];
    return [{
      subjectType: "agreement" as const,
      subjectId: fact.agreementId,
      mandateId: fact.mandateId,
      holdSubject: { type: "reservation" as const, id: fact.reservationId },
      severity: price.div(minPrice).gte(4) ? "high" as const : "medium" as const,
      evidence: {
        first_provider_agreement: "true",
        price: price.toFixed(),
        minimum_price: minPrice.toFixed(),
        provider_id: fact.providerId,
      },
    }];
  });
  return { findings, skippedBaseline: 0 };
}
