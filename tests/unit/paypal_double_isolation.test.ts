/** Requirement 18.10: no product file under src/ may import the PayPal test double. */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|js|mjs|cjs)$/.test(p) ? [p] : [];
  });
}

describe("WalletPayPalDouble isolation", () => {
  it("is not imported by any file under src/", () => {
    const pattern = /paypal-wallet-double|WalletPayPalDouble|scripts\/verify/;
    const offenders = walk(join(process.cwd(), "src")).filter((f) => pattern.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("counts calls, logs them and fails transiently as configured", async () => {
    const d = new WalletPayPalDouble();
    d.failNext("createOrder", { times: 1 });
    const input = { amount: "10.00", currency: "USD", customId: "wallet:1", invoiceId: "i", description: "d", requestId: "r1" };
    await expect(d.createOrder(input)).rejects.toMatchObject({ code: "PAYPAL_UNREACHABLE" });
    const o = await d.createOrder(input);
    expect(d.count("createOrder")).toBe(2);
    expect(d.calls.map((c) => c.outcome)).toEqual(["error", "ok"]);
    const cap = await d.captureOrder(o.id, "cap1");
    expect((await d.getCapture(cap.captureId!)).amount).toBe("10.00");
  });
});
