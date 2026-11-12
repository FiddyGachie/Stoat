import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { add, compare, formatAmount, isValidAmount, shortfall, subtract } from "../console/src/money.js";

describe("console money helper", () => {
  it("adds without floating-point error", () => {
    expect(add("0.10", "0.20")).toBe("0.30");
    expect(subtract("1.00", "0.90")).toBe("0.10");
  });

  it("reports shortfall as 0.00 when not positive", () => {
    expect(shortfall("50.00", "20.50")).toBe("29.50");
    expect(shortfall("50.00", "50.00")).toBe("0.00");
    expect(shortfall("10.00", "50.00")).toBe("0.00");
  });

  it("compares and validates amounts", () => {
    expect(compare("10.00", "9.99")).toBe(1);
    expect(compare("1", "1.00")).toBe(0);
    expect(isValidAmount("12.5")).toBe(true);
    for (const bad of ["", "0", "-1", "1.234", "abc", "1e3"]) expect(isValidAmount(bad)).toBe(false);
    expect(formatAmount("bad")).toBe("0.00");
  });

  it("shortfall is never negative and equals budget minus available when positive", () => {
    const cents = fc.integer({ min: 0, max: 10_000_000 });
    fc.assert(
      fc.property(cents, cents, (b, a) => {
        const s = shortfall((b / 100).toFixed(2), (a / 100).toFixed(2));
        expect(Number(s) >= 0).toBe(true);
        expect(s).toBe((Math.max(b - a, 0) / 100).toFixed(2));
      }),
    );
  });
});
