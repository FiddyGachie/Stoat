// Task 2.7: the agentic helpers build valid records and the doubles behave as scripted.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { Decimal } from "decimal.js";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import {
  capsArb,
  createOwner,
  createWallet,
  createMandate,
  createMission,
  createQuote,
  createAgentPrincipal,
  mandateSelectionDouble,
  explanationDouble,
  insightDouble,
  questionDouble,
  proposalDraftDouble,
  HOSTILE_MONEY_FIELDS,
} from "../agentic-helpers.js";

const call = (t: any, schemaName: string, prompt = "{}") =>
  t({ options: { prompt, schemaName }, model: "m" });

describe("agentic helpers", () => {
  it("capsArb always satisfies per_agreement_max <= daily_cap <= total_cap", () => {
    fc.assert(
      fc.property(
        capsArb,
        (c) =>
          new Decimal(c.per_agreement_max).lte(c.daily_cap) &&
          new Decimal(c.daily_cap).lte(c.total_cap),
      ),
      { numRuns: 100 },
    );
  });

  it("builders produce records the database accepts", async () => {
    await resetDb();
    const db = getDb();
    await runMigrations(db);
    await seedDatabase(db);
    const app = createApp({ gateway: new WalletPayPalDouble() });
    const owner = await createOwner(db);
    const wallet = await createWallet(db, {
      ownerUserId: owner.id,
      funded: "25.00",
    });
    const agent = await createAgentPrincipal(db, { ownerUserId: owner.id });
    const mandate = await createMandate(db, {
      ownerUserId: owner.id,
      walletId: wallet.id,
    });
    const row = await db.query(
      `SELECT status, tenant_id FROM mandates WHERE id = $1`,
      [mandate.id],
    );
    expect(row.rows[0]).toMatchObject({
      status: "active",
      tenant_id: SEED_IDS.tenantId,
    });
    expect(agent.headers.Authorization).toMatch(/^Bearer agent:/);
    const missionId = await createMission(app);
    expect(await createQuote(app, missionId)).toBeTruthy();
  });
});

describe("agentic model doubles", () => {
  it("return valid, malformed, hostile and slow output on demand", async () => {
    const valid = await call(
      mandateSelectionDouble({ quoteId: "q", mandateId: "m" }),
      "mandate_selection_v1",
    );
    expect(valid.data).toMatchObject({ quote_id: "q", mandate_id: "m" });

    const hostile = await call(
      mandateSelectionDouble({ behavior: "hostile" }),
      "mandate_selection_v1",
    );
    expect(hostile.data).toMatchObject(HOSTILE_MONEY_FIELDS);

    const bad = await call(
      explanationDouble({ behavior: "malformed" }),
      "alert_explanation_v1",
    );
    expect(typeof bad.data.summary).toBe("number");

    const insight = await call(
      insightDouble(),
      "payments_insight_v1",
      '[{"key":"spend.charged.USD"}]',
    );
    expect(insight.data.findings[0].cites).toEqual(["spend.charged.USD"]);

    expect(
      (await call(questionDouble(), "question_mapping_v1")).data.intent,
    ).toBe("unsupported");
    expect(
      (
        await call(
          proposalDraftDouble({
            type: "hold_release",
            payload: { hold_id: "h" },
          }),
          "hold_release_v1",
        )
      ).data.hold_id,
    ).toBe("h");

    const slow = proposalDraftDouble({ behavior: "slow", delayMs: 20 });
    const t0 = Date.now();
    await call(slow, "topup_suggestion_v1");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
    expect(slow.calls).toBe(1);
  });
});
