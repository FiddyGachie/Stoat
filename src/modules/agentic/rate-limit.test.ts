import { describe, expect, it } from "vitest";
import { createLimiter } from "./rate-limit.js";
import { RateLimitedError } from "./commerce-errors.js";

describe("createLimiter", () => {
  it("admits up to the limit and refuses the next attempt inside the window", () => {
    const l = createLimiter({ limit: 2, windowMs: 1000 });
    expect(l.allow(0)).toBe(true);
    expect(l.allow(100)).toBe(true);
    expect(l.allow(200)).toBe(false);
    expect(l.remaining(200)).toBe(0);
  });

  it("does not count refused attempts and frees capacity as the window slides", () => {
    const l = createLimiter({ limit: 1, windowMs: 1000 });
    expect(l.allow(0)).toBe(true);
    expect(l.allow(500)).toBe(false);
    expect(l.allow(999)).toBe(false);
    expect(l.allow(1000)).toBe(true);
  });

  it("rejects invalid configuration", () => {
    expect(() => createLimiter({ limit: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => createLimiter({ limit: 1, windowMs: 0 })).toThrow(RangeError);
  });

  it("names the scope on RATE_LIMITED errors", () => {
    const e = new RateLimitedError("hold");
    expect(e.code ?? (e as any).details?.code).toBeDefined();
    expect((e as any).details?.scope).toBe("hold");
  });
});
