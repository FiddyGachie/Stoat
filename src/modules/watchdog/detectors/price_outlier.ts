import { Decimal } from "decimal.js";
import type { DetectorResult, PriceOutlierFact } from "./types.js";

export interface PriceOutlierThreshold {
  multiplier: number;
  min_observations: number;
}

function median(values: readonly string[]): Decimal {
  const sorted = values.map((value) => new Decimal(value)).sort((a, b) => a.comparedTo(b));
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : sorted[middle - 1].plus(sorted[middle]).div(2);
}

function severity(ratio: Decimal): "medium" | "high" | "critical" {
  if (ratio.gte(8)) return "critical";
  if (ratio.gte(4)) return "high";
  return "medium";
}

export function evaluate(
  facts: readonly PriceOutlierFact[],
  threshold: PriceOutlierThreshold,
  _now: Date,
): DetectorResult {
  const findings = [];
  let skippedBaseline = 0;
  for (const fact of facts) {
    if (fact.earlierPrices.length < threshold.min_observations) {
      skippedBaseline++;
      continue;
    }
    const baseline = median(fact.earlierPrices);
    if (!baseline.gt(0)) {
      skippedBaseline++;
      continue;
    }
    const current = new Decimal(fact.currentPrice);
    const ratio = current.div(baseline);
    if (ratio.lte(threshold.multiplier)) continue;
    findings.push({
      subjectType: "agreement" as const,
      subjectId: fact.agreementId,
      mandateId: fact.mandateId,
      holdSubject: { type: "reservation" as const, id: fact.reservationId },
      severity: severity(ratio),
      evidence: {
        current_price: current.toFixed(),
        historical_median: baseline.toFixed(),
        ratio: ratio.toFixed(2),
        service_id: fact.serviceId,
      },
    });
  }
  return { findings, skippedBaseline };
}
