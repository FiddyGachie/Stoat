import { Decimal } from "decimal.js";
import type { DetectorResult, SpendSpikeFact } from "./types.js";

export interface SpendSpikeThreshold {
  multiplier: number;
  min_observations: number;
}

function severity(ratio: Decimal): "medium" | "high" | "critical" {
  if (ratio.gte(10)) return "critical";
  if (ratio.gte(6)) return "high";
  return "medium";
}

export function evaluate(
  facts: readonly SpendSpikeFact[],
  threshold: SpendSpikeThreshold,
  _now: Date,
): DetectorResult {
  const findings = [];
  let skippedBaseline = 0;
  for (const fact of facts) {
    if (fact.baselineDailyTotals.length < threshold.min_observations) {
      skippedBaseline++;
      continue;
    }
    const baseline = fact.baselineDailyTotals.reduce(
      (sum, value) => sum.plus(value),
      new Decimal(0),
    ).div(fact.baselineDailyTotals.length);
    if (!baseline.gt(0)) {
      skippedBaseline++;
      continue;
    }
    const recent = new Decimal(fact.recentAmount);
    const ratio = recent.div(baseline);
    if (ratio.lte(threshold.multiplier)) continue;
    findings.push({
      subjectType: fact.subjectType,
      subjectId: fact.subjectId,
      mandateId: fact.mandateId,
      severity: severity(ratio),
      evidence: {
        recent_amount: recent.toFixed(),
        baseline_daily_mean: baseline.toFixed(),
        ratio: ratio.toFixed(2),
        currency: fact.currency,
      },
    });
  }
  return { findings, skippedBaseline };
}
