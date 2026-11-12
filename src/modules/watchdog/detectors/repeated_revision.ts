import type { DetectorResult, RevisionFact } from "./types.js";

export interface RepeatedRevisionThreshold {
  max_events: number;
}

export function evaluate(
  facts: readonly RevisionFact[],
  threshold: RepeatedRevisionThreshold,
  _now: Date,
): DetectorResult {
  return {
    skippedBaseline: 0,
    findings: facts
      .filter((fact) => fact.eventCount > threshold.max_events)
      .map((fact) => ({
        subjectType: "agreement" as const,
        subjectId: fact.agreementId,
        severity: fact.eventCount >= 5 ? "high" as const : "medium" as const,
        evidence: { revision_events: fact.eventCount, max_events: threshold.max_events },
      })),
  };
}
