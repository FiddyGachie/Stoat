import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  assertNoPayeeColumns,
  forbiddenColumnFields,
  groupByCurrency,
  utilization,
} from "../console/src/components/agentic/helpers.js";

describe("utilization", () => {
  it("computes the fraction and clamps to [0, 1]", () => {
    expect(utilization("120.00", "500.00")).toBeCloseTo(0.24, 10);
    expect(utilization("600.00", "500.00")).toBe(1);
    expect(utilization("-5.00", "500.00")).toBe(0);
    expect(utilization("1.00", "0.00")).toBe(0);
    expect(utilization("x", "10")).toBe(0);
  });

  it("always lies in [0, 1]", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e6, max: 1e6 }), fc.integer({ min: -1e6, max: 1e6 }), (u, c) => {
        const r = utilization(String(u), String(c));
        return r >= 0 && r <= 1;
      }),
    );
  });
});

describe("assertNoPayeeColumns", () => {
  it("throws in development for recipient, payee and email fields", () => {
    for (const field of ["recipient_id", "Payee", "provider_email"]) {
      expect(() => assertNoPayeeColumns([{ field }], true)).toThrow();
    }
    expect(() => assertNoPayeeColumns([{ children: [{ field: "payee_ref" }] }], true)).toThrow();
  });
  it("accepts ordinary columns and is a no-op outside development", () => {
    expect(() => assertNoPayeeColumns([{ field: "amount" }, { field: "currency" }], true)).not.toThrow();
    expect(() => assertNoPayeeColumns([{ field: "recipient" }], false)).not.toThrow();
    expect(forbiddenColumnFields([{ field: "id" }])).toEqual([]);
  });
});

describe("groupByCurrency", () => {
  it("keeps one group per currency in first-seen order", () => {
    const g = groupByCurrency([
      { currency: "USD", n: 1 },
      { currency: "EUR", n: 2 },
      { currency: "USD", n: 3 },
    ]);
    expect(g.map((x) => x.currency)).toEqual(["USD", "EUR"]);
    expect(g[0]!.rows).toHaveLength(2);
  });
});
