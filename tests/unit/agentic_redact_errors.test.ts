import { describe, expect, it } from "vitest";
import { hasForbiddenKey, scrubForbidden, redactKeys } from "../../src/modules/agentic/redact.js";
import * as errors from "../../src/modules/agentic/commerce-errors.js";

describe("agentic redact helpers", () => {
  it("detects forbidden keys at any depth", () => {
    expect(hasForbiddenKey({ a: [{ b: { payee: "x" } }] })).toBe(true);
    expect(hasForbiddenKey({ payout_recipient: 1 })).toBe(true);
    expect(hasForbiddenKey({ note: "amount" })).toBe(false);
  });

  it("scrubs forbidden keys and keeps the rest", () => {
    expect(scrubForbidden({ keep: 1, currency: "USD", n: { amount: 2, ok: 3 } })).toEqual({
      keep: 1,
      n: { ok: 3 },
    });
  });

  it("redacts values but keeps key names", () => {
    expect(redactKeys({ a: "secret", b: { c: 1 } })).toEqual({ a: "[redacted]", b: { c: "[redacted]" } });
  });
});

describe("commerce errors", () => {
  it("map to the design table codes and statuses", () => {
    const cases: [{ code: string; statusCode: number }, string, number][] = [
      [new errors.FeatureDisabledError("mandates"), "FEATURE_DISABLED", 403],
      [new errors.MandateRequiresWalletModeError(), "MANDATE_REQUIRES_WALLET_MODE", 409],
      [new errors.MandateRefusalError("MANDATE_EXPIRED"), "MANDATE_EXPIRED", 422],
      [new errors.MandateStateConflictError(), "MANDATE_STATE_CONFLICT", 409],
      [new errors.MandateTermsImmutableError(), "MANDATE_TERMS_IMMUTABLE", 400],
      [new errors.HoldActiveError(), "HOLD_ACTIVE", 422],
      [new errors.HoldSubjectInvalidError(), "HOLD_SUBJECT_INVALID", 422],
      [new errors.RateLimitedError("hold"), "RATE_LIMITED", 429],
      [new errors.AgentOutputInvalidError(), "AGENT_OUTPUT_INVALID", 422],
      [new errors.ModelTimeoutError(), "MODEL_TIMEOUT", 504],
      [new errors.ModelBudgetExceededError(), "MODEL_BUDGET_EXCEEDED", 429],
      [new errors.ProposalTooLargeError(65536), "PROPOSAL_TOO_LARGE", 413],
      [new errors.ProposalExpiredError(), "PROPOSAL_EXPIRED", 409],
      [new errors.ProposalInvalidError(["x"]), "PROPOSAL_INVALID", 422],
      [new errors.InvalidDateRangeError(), "INVALID_DATE_RANGE", 400],
      [new errors.AnalyticsTimeoutError(), "ANALYTICS_TIMEOUT", 504],
      [new errors.QuestionInvalidError(), "QUESTION_INVALID", 400],
    ];
    for (const [err, code, status] of cases) {
      expect(err.code).toBe(code);
      expect(err.statusCode).toBe(status);
    }
  });
});
