// Task 13.4: insight, question and follow-up intent routes (R12.1, R12.8, R13.2, R15.4).
// Model doubles stand in for the provider; they prove Stoat's handling of stated outputs.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { closeDb, getDb, resetDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { AgentRuntimeService } from "../../src/modules/agent-runtime/agent-runtime.service.js";
import type { LlmTransport } from "../../src/modules/agent-runtime/llm-adapter.js";
import { AGENTIC_ROUTE_PATHS } from "../../src/modules/agentic/agentic.routes.js";
import {
  createMandate,
  createOwner,
  createWallet,
  setFlags,
} from "../agentic-helpers.js";
import { insightDouble, questionDouble } from "../llm-double.js";
import { dispatch } from "../test-utils.js";

const T = SEED_IDS.tenantId;
const INSIGHT = "/v1/analytics/payments/insights";
const QUESTION = "/v1/analytics/payments/questions";
const INTENT = "/v1/analytics/payments/intents/mandate_list";
const range = { from: "2026-01-01", to: "2026-01-31" };

describe("insight and question routes", () => {
  let owner: Awaited<ReturnType<typeof createOwner>>;
  let transport: LlmTransport;
  let app: ReturnType<typeof createApp>;

  const post = (url: string, body: unknown, headers = owner.headers) =>
    dispatch(app, { method: "POST", url, headers, body });
  const agentHeaders = { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` };
  const count = async (table: string) =>
    Number(
      (await getDb().query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n,
    );

  /** Rebuild the app so it uses the given model transport. */
  const useModel = (t: LlmTransport) => {
    transport = t;
    app = createApp({
      agenticRuntime: new AgentRuntimeService(
        getDb(),
        "live",
        undefined,
        { transport },
      ),
    });
  };

  beforeAll(async () => {
    await resetDb();
    await runMigrations(getDb());
    await seedDatabase(getDb());
  });
  afterAll(async () => {
    await closeDb();
  });
  beforeEach(async () => {
    const db = getDb();
    await db.exec(
      "TRUNCATE TABLE insight_narratives, nl_questions, mandate_acceptances, mandates, agent_runs CASCADE",
    );
    await setFlags(db, T, { insights: true, nl_questions: true });
    owner = await createOwner(db);
    const wallet = await createWallet(db, {
      ownerUserId: owner.id,
      funded: "100.00",
    });
    await createMandate(db, { ownerUserId: owner.id, walletId: wallet.id });
    useModel(insightDouble());
  });

  it("registers the three routes in AGENTIC_ROUTE_PATHS", () => {
    for (const p of [INSIGHT, QUESTION, "/v1/analytics/payments/intents/:intent"]) {
      expect(AGENTIC_ROUTE_PATHS).toContain(p);
    }
  });

  it("returns a digest and a stored narrative for an insight request", async () => {
    const res = await post(INSIGHT, range);
    expect(res.status).toBe(200);
    expect(res.body.notice).toBeNull();
    expect(res.body.digest.figures.length).toBeGreaterThan(0);
    expect(res.body.narrative.schema_version).toBe("payments_insight_v1");
    expect(await count("insight_narratives")).toBe(1);
  });

  it("returns the digest with a no-narrative notice when the model output is invalid", async () => {
    useModel(insightDouble({ behavior: "hostile" }));
    const res = await post(INSIGHT, range);
    expect(res.status).toBe(200);
    expect(res.body.narrative).toBeNull();
    expect(res.body.notice).toBe("AGENT_OUTPUT_INVALID");
    expect(res.body.notice_text).toMatch(/no narrative/i);
    expect(res.body.digest.figures.length).toBeGreaterThan(0);
    expect(await count("insight_narratives")).toBe(0);
  });

  it("maps a question to an intent and runs it with server-set scope", async () => {
    useModel(questionDouble({ intent: "mandate_list", params: { owner: "someone-else" } }));
    const res = await post(QUESTION, { text: "Which mandates do I have?" });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("intent");
    expect(res.body.intent).toBe("mandate_list");
    expect(res.body.result.rows.length).toBe(1);
    expect(JSON.stringify(res.body.params)).not.toContain("someone-else");
  });

  it("answers an unsupported question with the allowed intents", async () => {
    useModel(questionDouble());
    const res = await post(QUESTION, { text: "What is the weather?" });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("unsupported");
    expect(res.body.allowed_intents.length).toBeGreaterThan(0);
  });

  it("rejects bad question text before any model call", async () => {
    const double = questionDouble();
    useModel(double);
    expect((await post(QUESTION, { text: "" })).status).toBe(400);
    expect((await post(QUESTION, { text: "x".repeat(501) })).status).toBe(400);
    expect(double.calls).toBe(0);
  });

  it("runs a follow-up intent only when selected by a person", async () => {
    const double = questionDouble();
    useModel(double);
    const res = await post(INTENT, { params: { tenant_id: "other" } });
    expect(res.status).toBe(200);
    expect(res.body.intent).toBe("mandate_list");
    expect(res.body.rows.length).toBe(1);
    expect(double.calls).toBe(0);
    expect((await post("/v1/analytics/payments/intents/nope", {})).status).toBe(422);
  });

  it("refuses an agent on every route with no data and no model call", async () => {
    const double = questionDouble();
    useModel(double);
    for (const url of [INSIGHT, QUESTION, INTENT]) {
      const res = await post(url, { ...range, text: "hi" }, agentHeaders);
      expect(res.status, url).toBe(403);
      expect(res.body.error.code, url).toBe("FORBIDDEN_ACTION");
    }
    expect(double.calls).toBe(0);
    expect(await count("insight_narratives")).toBe(0);
    expect(await count("nl_questions")).toBe(0);
  });

  it("returns FEATURE_DISABLED when the flag is off", async () => {
    await setFlags(getDb(), T, { insights: false, nl_questions: false });
    for (const url of [INSIGHT, QUESTION, INTENT]) {
      const res = await post(url, { ...range, text: "hi" });
      expect(res.status, url).toBe(403);
      expect(res.body.error.code, url).toBe("FEATURE_DISABLED");
    }
  });
});
