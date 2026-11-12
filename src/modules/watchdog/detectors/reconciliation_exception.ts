import type { DetectorResult, ReconciliationExceptionFact } from "./types.js";

export interface ReconciliationExceptionThreshold {
  max_age_minutes: number;
}

export function evaluate(
  facts: readonly ReconciliationExceptionFact[],
  threshold: ReconciliationExceptionThreshold,
  _now: Date,
): DetectorResult {
  return {
    skippedBaseline: 0,
    findings: facts
      .filter((fact) => fact.ageMinutes > threshold.max_age_minutes)
      .map((fact) => ({
        subjectType: "reconciliation_exception" as const,
        subjectId: fact.exceptionId,
        severity: fact.kind === "mismatch" ? "high" as const : "medium" as const,
        evidence: { exception_kind: fact.kind, age_minutes: fact.ageMinutes, max_age_minutes: threshold.max_age_minutes },
      })),
  };
}
