export type AlertSeverity = "low" | "medium" | "high" | "critical";

export interface Finding {
  subjectType: "wallet" | "mandate" | "agreement" | "reconciliation_exception";
  subjectId: string;
  severity: AlertSeverity;
  evidence: Record<string, string | number>;
  mandateId?: string;
  holdSubject?: { type: "reservation"; id: string };
}

export interface DetectorResult {
  findings: Finding[];
  skippedBaseline: number;
}

export interface SpendSpikeFact {
  subjectType: "wallet" | "mandate";
  subjectId: string;
  mandateId?: string;
  currency: string;
  recentAmount: string;
  baselineDailyTotals: string[];
}

export interface PriceOutlierFact {
  agreementId: string;
  reservationId: string;
  serviceId: string;
  mandateId?: string;
  currentPrice: string;
  earlierPrices: string[];
}

export interface RevisionFact {
  agreementId: string;
  eventCount: number;
}

export interface UnusualProviderFact {
  agreementId: string;
  reservationId: string;
  providerId: string;
  mandateId?: string;
  firstAgreement: boolean;
  price: string;
}

export interface WalletDepletingFact {
  walletId: string;
  available: string;
  netSpendLast24h: string;
}

export interface ReconciliationExceptionFact {
  exceptionId: string;
  kind: string;
  ageMinutes: number;
}
