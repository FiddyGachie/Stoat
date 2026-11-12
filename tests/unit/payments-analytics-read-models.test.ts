import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import {
  DATASET_NAMES,
  loadDataset,
} from "../../src/modules/payments-analytics/datasets.js";
import {
  CHART_NAMES,
  loadChart,
} from "../../src/modules/payments-analytics/charts.js";
import {
  scopeFromPrincipal,
  validateDateRange,
} from "../../src/modules/payments-analytics/read-models.js";

const adminScope = { tenantId: SEED_IDS.tenantId, role: "operator" };
const ownerScope = {
  tenantId: SEED_IDS.tenantId,
  role: "buyer",
  ownerUserId: SEED_IDS.tenantId,
};

describe("payments analytics read models", () => {
  beforeAll(async () => {
    await resetDb();
    const db = getDb();
    await runMigrations(db);
    await seedDatabase(db);
  });
  afterAll(async () => {
    await closeDb();
  });

  it("validates date ranges", () => {
    expect(validateDateRange("2025-01-01", "2025-01-01")).toBeTruthy();
    expect(() => validateDateRange("2025-02-30", "2025-03-01")).toThrow();
    expect(() => validateDateRange("2025-03-02", "2025-03-01")).toThrow();
    expect(() => validateDateRange("2025-01-01", "2026-01-02")).toThrow();
    expect(validateDateRange("2025-01-01", "2026-01-01")).toBeTruthy();
  });

  it("limits access to human roles", () => {
    const base = { id: "u", tenantId: "t", type: "user" as const };
    expect(scopeFromPrincipal({ ...base, role: "buyer" }).ownerUserId).toBe("u");
    expect(scopeFromPrincipal({ ...base, role: "operator" }).ownerUserId).toBeUndefined();
    expect(() => scopeFromPrincipal({ ...base, role: "viewer" })).toThrow();
    expect(() =>
      scopeFromPrincipal({ ...base, type: "agent", role: "buyer" }),
    ).toThrow();
  });

  it.each([adminScope, ownerScope])(
    "runs every dataset and chart read-only (%o)",
    async (scope) => {
      for (const name of DATASET_NAMES) {
        const res = await loadDataset(name, {
          scope,
          from: "2025-01-01",
          to: "2035-01-01",
        }).catch((e) => {
          if (e.code === "INVALID_DATE_RANGE") return null;
          throw e;
        });
        if (res) expect(res.meta.paypal_environment).toBe("unknown");
        const ok = await loadDataset(name, {
          scope,
          from: "2025-01-01",
          to: "2025-12-31",
        });
        expect(Array.isArray(ok.groups)).toBe(true);
      }
      for (const chart of CHART_NAMES) {
        const res = await loadChart(chart, {
          scope,
          from: "2025-01-01",
          to: "2025-12-31",
        });
        expect(res.chart).toBe(chart);
      }
    },
  );
});
