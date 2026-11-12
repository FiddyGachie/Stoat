import { Decimal } from "decimal.js";
import type { DetectorResult, WalletDepletingFact } from "./types.js";

export interface WalletDepletingThreshold {
  horizon_hours: number;
}

export function evaluate(
  facts: readonly WalletDepletingFact[],
  threshold: WalletDepletingThreshold,
  _now: Date,
): DetectorResult {
  const findings = facts.flatMap((fact) => {
    const netSpend = new Decimal(fact.netSpendLast24h);
    if (!netSpend.gt(0)) return [];
    const ratePerHour = netSpend.div(24);
    const available = new Decimal(fact.available);
    const hoursRemaining = available.div(ratePerHour);
    if (!hoursRemaining.lt(threshold.horizon_hours)) return [];
    const severity = hoursRemaining.lt(1)
      ? "critical" as const
      : hoursRemaining.lt(6)
        ? "high" as const
        : "medium" as const;
    return [{
      subjectType: "wallet" as const,
      subjectId: fact.walletId,
      severity,
      evidence: {
        available: available.toFixed(),
        net_spend_24h: netSpend.toFixed(),
        rate_per_hour: ratePerHour.toFixed(4),
        hours_remaining: hoursRemaining.toFixed(2),
      },
    }];
  });
  return { findings, skippedBaseline: 0 };
}
