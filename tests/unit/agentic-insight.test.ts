import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, resetDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import type { AuthenticatedPrincipal } from "../../src/common/types.js";
import { AgentRuntimeService } from "../../src/modules/agent-runtime/agent-runtime.service.js";
import type { LlmTransport } from "../../src/modules/agent-runtime/llm-adapter.js";
import { InsightService } from "../../src/modules/payments-analytics/insight.service.js";
import {
  validateInsight,
  type InsightDigest,
} from "../../src/modules/payments-analytics/insight-validation.js";
import { isCatalogIntent } from "../../src/modules/payments-analytics/intent-catalog.js";
import {
  createMandate,
  createOwner,
  createWallet,
  insightDouble,
  setFlags,
} from "../agentic-helpers.js";

const digest: InsightDigest = {
  figures: [
    { key: "range.days", value: "30", kind: "days" },
    {
      key: "spend.charged.USD",
      value: "12.345",
      currency: "USD",
      kind: "amount",
    },
    { key: "alerts.open.high", value: "3", kind: "count" },
  ],
};
const check = (output: unknown) =>
  validateInsight(output, digest, isCatalogIntent);
const finding = (text: string, cites = ["spend.charged.USD"]) => ({
  headline: "Spend summary",
  findings: [{ text, cites }],
  follow_ups: [],
});

describe("validateInsight", () => {
  it("accepts numbers equal to the cited value at the displayed precision (half-up)", () => {
    expect(
      check(
        finding("Charged 12.35 over 30 days.", [
          "spend.charged.USD",
          "range.days",
        ]),
      ).ok,
    ).toBe(true);
    expect(check(finding("Charged about 12.3 in total.")).ok).toBe(true);
    expect(check(finding("Charged 12 in total.")).ok).toBe(true);
  });

  it("rejects wrong numbers, uncited numbers, unknown keys and currency symbols", () => {
    expect(check(finding("Charged 12.34 in total.")).ok).toBe(false);
    expect(check(finding("There were 3 alerts.")).ok).toBe(false); // alerts.open.high not cited
    expect(check(finding("Fine.", ["nope"])).ok).toBe(false);
    expect(check(finding("Charged $12.35.")).ok).toBe(false);
  });

  it("enforces size limits and follow-ups against the catalog", () => {
    expect(check({ ...finding("ok"), headline: "x".repeat(121) }).ok).toBe(
      false,
    );
    expect(check(finding("y".repeat(301))).ok).toBe(false);
    expect(
      check({
        ...finding("ok"),
        findings: Array(6).fill({ text: "ok", cites: ["range.days"] }),
      }).ok,
    ).toBe(false);
    expect(
      check({ ...finding("ok"), findings: [{ text: "ok", cites: [] }] }).ok,
    ).toBe(false);
    expect(
      check({
        ...finding("ok"),
        follow_ups: [{ intent: "drop_all_tables", params: {} }],
      }).ok,
    ).toBe(false);
    const four = Array(4).fill({ intent: "spend_by_mandate", params: {} });
    expect(check({ ...finding("ok"), follow_ups: four }).ok).toBe(false);
    expect(check({ ...finding("ok"), amount: "5" }).ok).toBe(false);
  });
});

describe("InsightService", () => {
  const range = { from: "2026-01-01", to: "2026-01-31" };

  beforeAll(async () => {
    await resetDb();
    await runMigrations(getDb());
    await seedDatabase(getDb());
  });
  afterAll(async () => {
    await closeDb();
  });

  let owner: Awaited<ReturnType<typeof createOwner>>;
  const principal = () => ({
    id: owner.id,
    tenantId: SEED_IDS.tenantId,
    type: "user" as const,
    role: "buyer" as AuthenticatedPrincipal["role"],
  });
  const service = (transport: LlmTransport) =>
    new InsightService(
      getDb(),
      new AgentRuntimeService(getDb(), "live", undefined, { transport }),
    );
  const narratives = async () =>
    (
      await getDb().query(
        "SELECT id FROM insight_narratives WHERE tenant_id = $1",
        [SEED_IDS.tenantId],
      )
    ).rows.length;

  beforeEach(async () => {
    const db = getDb();
    await db.exec(
      "TRUNCATE TABLE insight_narratives, mandate_acceptances, mandates, agent_runs CASCADE",
    );
    await setFlags(db, SEED_IDS.tenantId, { insights: true });
    owner = await createOwner(db);
    const wallet = await createWallet(db, {
      ownerUserId: owner.id,
      funded: "100.00",
    });
    await createMandate(db, { ownerUserId: owner.id, walletId: wallet.id });
  });

  it("stores a validated narrative with provenance", async () => {
    const double = insightDouble();
    const result = await service(double).generate({
      principal: principal(),
      ...range,
    });
    expect(result.notice).toBeNull();
    expect(result.narrative?.schema_version).toBe("payments_insight_v1");
    expect(result.digest.figures[0]).toMatchObject({
      key: "range.days",
      value: "31",
    });
    expect(result.digest.figures.length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(result.digest)).not.toMatch(/@|recipient|payee/i);
    const row = (
      await getDb().query(
        "SELECT digest_hash, prompt_hash, model_id, agent_run_id FROM insight_narratives",
      )
    ).rows[0];
    expect(row.digest_hash).toBe(result.digest_hash);
    expect(row.prompt_hash).toBeTruthy();
    expect(row.agent_run_id).toBe(result.narrative?.agent_run_id);
    expect(double.prompts[0].prompt).toContain("<<<DATA>>>");
  });

  it("rejects invalid output with AGENT_OUTPUT_INVALID and stores nothing", async () => {
    await expect(
      service(insightDouble({ behavior: "hostile" })).generate({
        principal: principal(),
        ...range,
      }),
    ).rejects.toMatchObject({ code: "AGENT_OUTPUT_INVALID" });
    expect(await narratives()).toBe(0);
    await expect(
      service(insightDouble({ digestKeys: ["unknown.key"] })).generate({
        principal: principal(),
        ...range,
      }),
    ).rejects.toMatchObject({ code: "AGENT_OUTPUT_INVALID" });
    expect(await narratives()).toBe(0);
  });

  it("makes no model call for a bad range, a wrong role or an empty digest", async () => {
    const double = insightDouble();
    const svc = service(double);
    await expect(
      svc.generate({
        principal: principal(),
        from: "2026-01-31",
        to: "2026-01-01",
      }),
    ).rejects.toMatchObject({ code: "INVALID_DATE_RANGE" });
    await expect(
      svc.generate({
        principal: principal(),
        from: "2025-01-01",
        to: "2026-06-01",
      }),
    ).rejects.toBeTruthy();
    await expect(
      svc.generate({
        principal: { ...principal(), role: "viewer" as const },
        ...range,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ACTION" });
    const other = await createOwner(getDb());
    const empty = await svc.generate({
      principal: { ...principal(), id: other.id },
      ...range,
    });
    expect(empty.notice).toBe("EMPTY_DIGEST");
    expect(empty.narrative).toBeNull();
    expect(double.calls).toBe(0);
  });

  it("returns the digest with no narrative when no model key is configured", async () => {
    const { StoatError } = await import("../../src/common/errors.js");
    const failing: LlmTransport = async () => {
      throw new StoatError("LLM_NOT_CONFIGURED", "No key", 503);
    };
    const result = await service(failing).generate({
      principal: principal(),
      ...range,
    });
    expect(result.notice).toBe("LLM_NOT_CONFIGURED");
    expect(result.narrative).toBeNull();
    expect(result.digest.figures.length).toBeGreaterThan(0);
    expect(await narratives()).toBe(0);
  });

  it("creates no proposal or hold from a narrative", async () => {
    const count = async () =>
      Number(
        (
          await getDb().query(
            "SELECT (SELECT COUNT(*) FROM proposals) + (SELECT COUNT(*) FROM holds) AS n",
          )
        ).rows[0].n,
      );
    const before = await count();
    await service(insightDouble()).generate({
      principal: principal(),
      ...range,
    });
    expect(await count()).toBe(before);
  });
});
