// Feature: agentic-commerce, Property 18: Each Detector fires exactly per its threshold
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Decimal } from "decimal.js";
import { evaluate as spendSpike } from "../../src/modules/watchdog/detectors/spend_spike.js";
import { evaluate as priceOutlier } from "../../src/modules/watchdog/detectors/price_outlier.js";
import { evaluate as repeatedRevision } from "../../src/modules/watchdog/detectors/repeated_revision.js";
import { evaluate as unusualProvider } from "../../src/modules/watchdog/detectors/unusual_provider.js";
import { evaluate as walletDepleting } from "../../src/modules/watchdog/detectors/wallet_depleting.js";
import { evaluate as reconciliationException } from "../../src/modules/watchdog/detectors/reconciliation_exception.js";

const now = new Date("2026-01-01T00:00:00Z");

describe("Watchdog detector properties", () => {
  it("uses baseline count and strict spend-ratio threshold", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        (baselineCents, recentCents, count, minimum) => {
          const result = spendSpike(
            [{
              subjectType: "wallet",
              subjectId: "wallet",
              currency: "USD",
              recentAmount: new Decimal(recentCents).div(100).toFixed(2),
              baselineDailyTotals: Array.from(
                { length: count },
                () => new Decimal(baselineCents).div(100).toFixed(2),
              ),
            }],
            { multiplier: 3, min_observations: minimum },
            now,
          );
          const expected = count >= minimum && recentCents > baselineCents * 3;
          expect(result.findings.length).toBe(expected ? 1 : 0);
          expect(result.skippedBaseline).toBe(count < minimum ? 1 : 0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("applies the other detector predicates and severity bands", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        (price, baseline) => {
          const outlier = priceOutlier(
            [{
              agreementId: "agreement",
              reservationId: "reservation",
              serviceId: "service",
              currentPrice: String(price),
              earlierPrices: [String(baseline), String(baseline), String(baseline)],
            }],
            { multiplier: 2, min_observations: 3 },
            now,
          );
          expect(outlier.findings.length).toBe(price > baseline * 2 ? 1 : 0);
          const revisions = repeatedRevision(
            [{ agreementId: "agreement", eventCount: price }],
            { max_events: 3 },
            now,
          );
          expect(revisions.findings.length).toBe(price > 3 ? 1 : 0);
          const provider = unusualProvider(
            [{
              agreementId: "agreement",
              reservationId: "reservation",
              providerId: "provider",
              firstAgreement: true,
              price: String(price),
            }],
            { min_price: String(baseline) },
            now,
          );
          expect(provider.findings.length).toBe(price > baseline ? 1 : 0);
          const depletion = walletDepleting(
            [{ walletId: "wallet", available: String(price), netSpendLast24h: String(baseline) }],
            { horizon_hours: 24 },
            now,
          );
          const hours = (price * 24) / baseline;
          expect(depletion.findings.length).toBe(hours < 24 ? 1 : 0);
          const exception = reconciliationException(
            [{ exceptionId: "exception", kind: "mismatch", ageMinutes: price }],
            { max_age_minutes: baseline },
            now,
          );
          expect(exception.findings.length).toBe(price > baseline ? 1 : 0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
