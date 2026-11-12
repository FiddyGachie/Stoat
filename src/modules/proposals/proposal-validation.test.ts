import { describe, expect, it } from "vitest";
import { validateProposalDraft } from "./proposal-validation.js";
import { computeSubjectKey } from "./proposal.schemas.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("validateProposalDraft", () => {
  it("accepts a valid payout_batch and derives an order-independent subject key", () => {
    const r1 = validateProposalDraft({ type: "payout_batch", payload: { obligation_ids: [A, B] }, rationale: "Ready" });
    const r2 = validateProposalDraft({ type: "payout_batch", payload: { obligation_ids: [B, A] }, rationale: "Ready" });
    expect(r1.ok && r2.ok && r1.subjectKey === r2.subjectKey).toBe(true);
    expect(computeSubjectKey("hold_release", { hold_id: A })).toHaveLength(64);
  });

  it("rejects forbidden keys at any depth and stores key names only", () => {
    const r = validateProposalDraft({
      type: "hold_release",
      payload: { hold_id: A, extra: { nested: { payee: "x@y.z" } } },
      rationale: "ok",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasonCodes).toContain("forbidden_field");
      expect(JSON.stringify(r.redactedPayload)).not.toContain("x@y.z");
    }
  });

  it("enforces hint bounds, size and rationale", () => {
    const hint = (v: string) =>
      validateProposalDraft({ type: "topup_suggestion", payload: { wallet_id: A, display_amount_hint: v }, rationale: "r" }).ok;
    expect(hint("0.01")).toBe(true);
    expect(hint("999999999.99")).toBe(true);
    expect(hint("0.00")).toBe(false);
    expect(hint("1000000000")).toBe(false);
    const big = validateProposalDraft({ type: "hold_release", payload: { hold_id: A, pad: "x".repeat(70000) }, rationale: "r" });
    expect(!big.ok && big.tooLarge).toBe(true);
    expect(validateProposalDraft({ type: "hold_release", payload: { hold_id: A }, rationale: "pay 5 now" }).ok).toBe(false);
  });
});
