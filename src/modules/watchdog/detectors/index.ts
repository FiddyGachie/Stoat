import type { DetectorResult, Finding } from "./types.js";
import { evaluate as spendSpike } from "./spend_spike.js";
import { evaluate as priceOutlier } from "./price_outlier.js";
import { evaluate as repeatedRevision } from "./repeated_revision.js";
import { evaluate as unusualProvider } from "./unusual_provider.js";
import { evaluate as walletDepleting } from "./wallet_depleting.js";
import { evaluate as reconciliationException } from "./reconciliation_exception.js";

export type DetectorName =
  | "spend_spike"
  | "price_outlier"
  | "repeated_revision"
  | "unusual_provider"
  | "wallet_depleting"
  | "reconciliation_exception";

export type DetectorResponse = "none" | "hold" | "suspend_mandate";

export const DETECTOR_VERSION = "1";

/** Design D11: only price_outlier and unusual_provider hold by default. */
export const DEFAULT_RESPONSES: Record<DetectorName, DetectorResponse> = {
  spend_spike: "none",
  price_outlier: "hold",
  repeated_revision: "none",
  unusual_provider: "hold",
  wallet_depleting: "none",
  reconciliation_exception: "none",
};

export type NamedFinding = Finding & { detector: DetectorName };

export interface Detector {
  name: DetectorName;
  version: string;
  evaluate(facts: never, threshold: never, now: Date): { findings: NamedFinding[]; skippedBaseline: number };
}

function wrap<F, T>(
  name: DetectorName,
  fn: (facts: readonly F[], threshold: T, now: Date) => DetectorResult,
): Detector {
  return {
    name,
    version: DETECTOR_VERSION,
    evaluate: ((facts: readonly F[], threshold: T, now: Date) => {
      const result = fn(facts, threshold, now);
      return {
        skippedBaseline: result.skippedBaseline,
        findings: result.findings.map((f) => ({ ...f, detector: name })),
      };
    }) as Detector["evaluate"],
  };
}

export const DETECTORS: Record<DetectorName, Detector> = {
  spend_spike: wrap("spend_spike", spendSpike),
  price_outlier: wrap("price_outlier", priceOutlier),
  repeated_revision: wrap("repeated_revision", repeatedRevision),
  unusual_provider: wrap("unusual_provider", unusualProvider),
  wallet_depleting: wrap("wallet_depleting", walletDepleting),
  reconciliation_exception: wrap("reconciliation_exception", reconciliationException),
};

export const DETECTOR_NAMES = Object.keys(DETECTORS) as DetectorName[];
