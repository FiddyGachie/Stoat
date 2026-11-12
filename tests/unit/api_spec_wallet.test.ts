import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { WALLET_ROUTE_PATHS } from "../../src/api/app.js";

const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
const norm = (p: string) => p.replace(/:[A-Za-z]+/g, ":x");
const specPath = (p: string) =>
  "/v1" + p.replace(/\{[^}]+\}/g, ":x");

describe("API_SPEC.yaml wallet routes", () => {
  const registered = [
    ...read("src/modules/wallet/wallet.routes.ts").matchAll(
      /app\.(?:get|post|put|patch|delete)\(\s*"(\/v1\/[^"]+)"/g,
    ),
  ].map((m) => m[1]);
  const spec = parse(read("API_SPEC.yaml")) as {
    paths: Record<string, Record<string, any>>;
    components: { schemas: Record<string, any> };
  };

  it("WALLET_ROUTE_PATHS lists exactly the routes wallet.routes.ts registers", () => {
    expect([...new Set(registered)].sort()).toEqual(
      [...WALLET_ROUTE_PATHS].sort(),
    );
  });

  it("documents every wallet route and method", () => {
    const methods = [
      ...read("src/modules/wallet/wallet.routes.ts").matchAll(
        /app\.(get|post|put|patch|delete)\(\s*"(\/v1\/[^"]+)"/g,
      ),
    ];
    const documented = new Map<string, Set<string>>();
    for (const [p, ops] of Object.entries(spec.paths)) {
      documented.set(
        norm(specPath(p)),
        new Set(Object.keys(ops).filter((k) => k !== "parameters")),
      );
    }
    const missing = methods
      .filter((m) => !documented.get(norm(m[2]))?.has(m[1]))
      .map((m) => `${m[1].toUpperCase()} ${m[2]}`);
    expect(missing).toEqual([]);
  });

  it("requires an Idempotency-Key on every money POST", () => {
    const money = [
      "/wallet/deposits",
      "/wallet/missions/{id}/top-up",
      "/wallet/missions/{id}/remainder-decision",
      "/wallet/refunds",
      "/wallet/refunds/{id}/retry",
      "/admin/wallets/{walletId}/refunds",
    ];
    for (const p of money) {
      const params = JSON.stringify(spec.paths[p].post.parameters ?? []);
      expect(params, p).toContain("IdempotencyKey");
    }
  });

  it("marks the budget debit deprecated and defines no recipient or payee field", () => {
    expect(spec.paths["/budgets/{budgetId}/debit"].post.deprecated).toBe(true);
    const walletOnly = JSON.stringify(
      Object.fromEntries(
        Object.entries(spec.components.schemas).filter(
          ([k]) => !/PayoutAccount/.test(k),
        ),
      ),
    );
    const walletPaths = JSON.stringify(
      Object.entries(spec.paths).filter(
        ([p]) => /^\/(wallet|notifications|analytics\/wallet|admin)/.test(p),
      ),
    );
    const keys = (s: string) =>
      [...s.matchAll(/"([A-Za-z_]+)":/g)].map((m) => m[1]);
    const bad = [...keys(walletOnly), ...keys(walletPaths)].filter((k) =>
      /recipient|payee|receiver|payment[_-]?source/i.test(k),
    );
    expect(bad).toEqual([]);
  });

  it("types money fields as Decimal strings, never numbers", () => {
    const wallet = spec.components.schemas.Wallet.properties;
    for (const k of ["balance", "reserved", "available", "charged"]) {
      expect(wallet[k].$ref).toBe("#/components/schemas/DecimalString");
    }
    expect(spec.components.schemas.DecimalString.type).toBe("string");
  });
});
