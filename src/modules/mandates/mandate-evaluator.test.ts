import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { evaluateMandate, mandateRemaining, type MandateFacts } from "./mandate-evaluator.js";

const now = new Date("2026-01-10T12:00:00Z");
const facts = (over: Partial<MandateFacts> = {}): MandateFacts => ({
  status: "active",
  expiresAt: new Date("2026-02-01T00:00:00Z"),
  currency: "USD",
  perAgreementMax: new Decimal(50),
  dailyCap: new Decimal(100),
  totalCap: new Decimal(500),
  categories: new Set(["code_review"]),
  missionScope: null,
  usage: new Decimal(0),
  todayUsage: new Decimal(0),
  available: new Decimal(1000),
  ...over,
});
const req = (price: number | string, over = {}) => ({
  price: new Decimal(price),
  currency: "USD",
  category: "code_review",
  missionId: "m1",
  now,
  ...over,
});

describe("evaluateMandate", () => {
  it("passes a price equal to every limit", () => {
    const f = facts({ usage: new Decimal(450), todayUsage: new Decimal(50), available: new Decimal(50) });
    expect(evaluateMandate(f, req(50))).toEqual({ ok: true });
  });

  it("reports the first failed condition in order", () => {
    const f = facts({ status: "revoked", expiresAt: new Date("2026-01-01T00:00:00Z") });
    expect(evaluateMandate(f, req(999, { currency: "EUR" }))).toEqual({ ok: false, code: "MANDATE_NOT_ACTIVE" });
    expect(evaluateMandate(facts({ status: "expired" }), req(1))).toEqual({ ok: false, code: "MANDATE_EXPIRED" });
    expect(evaluateMandate(facts(), req("50.01"))).toEqual({ ok: false, code: "MANDATE_PER_AGREEMENT_EXCEEDED" });
    expect(evaluateMandate(facts({ usage: new Decimal(480) }), req(30))).toEqual({ ok: false, code: "MANDATE_TOTAL_EXCEEDED" });
    expect(evaluateMandate(facts({ todayUsage: new Decimal(80) }), req(30))).toEqual({ ok: false, code: "MANDATE_DAILY_EXCEEDED" });
    expect(evaluateMandate(facts(), req(1, { category: "x" }))).toEqual({ ok: false, code: "MANDATE_CATEGORY_NOT_ALLOWED" });
    expect(evaluateMandate(facts({ missionScope: new Set(["m2"]) }), req(1))).toEqual({ ok: false, code: "MANDATE_MISSION_OUT_OF_SCOPE" });
    expect(evaluateMandate(facts(), req(1, { currency: "EUR" }))).toEqual({ ok: false, code: "MANDATE_CURRENCY_MISMATCH" });
    expect(evaluateMandate(facts({ available: new Decimal(5) }), req(10))).toEqual({ ok: false, code: "INSUFFICIENT_FUNDS" });
  });

  it("refuses at the expiry instant", () => {
    expect(evaluateMandate(facts({ expiresAt: now }), req(1))).toEqual({ ok: false, code: "MANDATE_EXPIRED" });
  });
});

describe("mandateRemaining", () => {
  it("is the lesser of total and daily headroom, floored at 0", () => {
    expect(mandateRemaining(facts({ usage: new Decimal(100), todayUsage: new Decimal(90) })).toString()).toBe("10");
    expect(mandateRemaining(facts({ usage: new Decimal(495), todayUsage: new Decimal(0) })).toString()).toBe("5");
    expect(mandateRemaining(facts({ usage: new Decimal(600) })).toString()).toBe("0");
  });
});
