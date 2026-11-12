import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import {
  FORBIDDEN_COLUMN_PATTERN,
  INTENT_CATALOG,
  INTENT_CATALOG_VERSION,
  intentsForRole,
  isCatalogIntent,
} from "../../src/modules/payments-analytics/intent-catalog.js";
import {
  runReadIntent,
  stripScopeKeys,
} from "../../src/modules/payments-analytics/intent-runner.js";

const base = { id: SEED_IDS.tenantId, tenantId: SEED_IDS.tenantId, type: "user" as const };
const admin = { ...base, role: "operator" as const };
const owner = { ...base, role: "buyer" as const };

describe("intent catalog and runner", () => {
  beforeAll(async () => {
    await resetDb();
    const db = getDb();
    await runMigrations(db);
    await seedDatabase(db);
  });
  afterAll(async () => {
    await closeDb();
  });

  it("is versioned, unique and free of recipient columns", () => {
    expect(INTENT_CATALOG_VERSION).toBe("1");
    const names = INTENT_CATALOG.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
    for (const i of INTENT_CATALOG)
      for (const c of i.columns) expect(c.field).not.toMatch(FORBIDDEN_COLUMN_PATTERN);
    expect(isCatalogIntent("spend_by_day")).toBe(true);
    expect(isCatalogIntent("drop_table")).toBe(false);
  });

  it("limits intents by role", () => {
    expect(intentsForRole("buyer").map((i) => i.name)).not.toContain("paypal_flows");
    expect(intentsForRole("operator").map((i) => i.name)).toContain("paypal_flows");
    expect(intentsForRole("viewer")).toEqual([]);
  });

  it("strips scope keys supplied by the model", () => {
    expect(
      stripScopeKeys({ tenant_id: "x", owner: "y", user_id: "z", scope: "all", window: "7d" }),
    ).toEqual({ window: "7d" });
  });

  it("runs every intent for admin without error and returns declared columns only", async () => {
    for (const i of INTENT_CATALOG) {
      const params = i.params.safeParse({ window: "30d" }).success ? { window: "30d" } : {};
      const res = await runReadIntent(admin, i.name, { ...params, tenant_id: "other" });
      expect(res.truncated).toBe(false);
      for (const row of res.rows)
        expect(Object.keys(row)).toEqual(i.columns.map((c) => c.field));
    }
  });

  it("refuses an admin-only intent for an owner and rejects bad input", async () => {
    await expect(runReadIntent(owner, "paypal_flows", { window: "7d" })).rejects.toMatchObject({
      code: "FORBIDDEN_ACTION",
    });
    await expect(runReadIntent(admin, "nope", {})).rejects.toMatchObject({
      code: "AGENT_OUTPUT_INVALID",
    });
    await expect(
      runReadIntent(admin, "spend_by_day", { window: "7d", extra: 1 }),
    ).rejects.toMatchObject({ code: "AGENT_OUTPUT_INVALID" });
    await expect(
      runReadIntent({ ...admin, type: "agent" as any }, "spend_by_day", { window: "7d" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ACTION" });
  });

  it("caps rows and flags truncation", async () => {
    const res = await runReadIntent(admin, "mandate_list", {}, { rowLimit: 1 });
    expect(res.rows.length).toBeLessThanOrEqual(1);
    const all = await runReadIntent(admin, "mandate_list", {});
    expect(res.truncated).toBe(all.rows.length > 1);
  });
});
