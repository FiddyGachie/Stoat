import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { AgentRuntimeService } from "../../src/modules/agent-runtime/agent-runtime.service.js";
import type { LlmTransport } from "../../src/modules/agent-runtime/llm-adapter.js";
import { authenticateRunPrincipal, openRun } from "../../src/modules/agentic/run-kit.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";

const validTransport: LlmTransport = async () => ({
  data: { ok: true },
  inputTokens: 1,
  outputTokens: 10,
});

const spec = (overrides: Partial<Parameters<typeof openRun>[1]> = {}) => ({
  tenantId: SEED_IDS.tenantId,
  agentId: SEED_IDS.providerAgentId,
  role: "provider",
  scope: {},
  toolSet: ["read"],
  limits: { maxSteps: 2, maxSeconds: 60, maxTokens: 100, maxCostUsd: 1 },
  ...overrides,
});

describe("agentic run kit", () => {
  beforeAll(async () => {
    await resetDb();
    const db = getDb();
    await runMigrations(db);
    await seedDatabase(db);
  });

  beforeEach(async () => {
    await getDb().exec("TRUNCATE TABLE notifications, agent_runs CASCADE");
  });

  afterAll(async () => {
    await closeDb();
  });

  it("discards output whenever a per-run budget is exceeded", async () => {
    const runtime = new AgentRuntimeService(getDb(), "live", undefined, {
      transport: validTransport,
    });

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("steps", "tokens", "cost"),
        async (limit) => {
          const limits = {
            maxSteps: limit === "steps" ? 0 : 1,
            maxSeconds: 60,
            maxTokens: limit === "tokens" ? 1 : 100,
            maxCostUsd: limit === "cost" ? 0.000001 : 1,
          };
          const handle = await openRun(runtime, spec({ limits }));
          await expect(
            handle.callModel(
              { prompt: "{}", schemaName: "test_v1" },
              (data) => ({ ok: true, value: data }),
            ),
          ).rejects.toMatchObject({
            code: "AGENT_BUDGET_EXCEEDED",
          });
          const row = await getDb().query<{ status: string; terminal_reason: string }>(
            "SELECT status, terminal_reason FROM agent_runs WHERE id = $1",
            [handle.run.id],
          );
          expect(row.rows[0].terminal_reason).toBe(`budget_${limit}`);
          expect(row.rows[0].status).toBe("terminated_limit");
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("authenticates principals only while runs are active and clamps child capabilities", async () => {
    const runtime = new AgentRuntimeService(getDb(), "live", undefined, {
      transport: validTransport,
    });
    const parent = await openRun(runtime, spec({
      limits: { maxSteps: 3, maxSeconds: 60, maxTokens: 100, maxCostUsd: 0.1 },
    }));

    expect(await authenticateRunPrincipal(getDb(), parent.principal.token)).toMatchObject({
      agentRunId: parent.run.id,
      tenantId: SEED_IDS.tenantId,
      toolSet: ["read"],
    });
    const child = await parent.child({
      toolSet: ["read", "write"],
      limits: { maxSteps: 99, maxSeconds: 99, maxTokens: 999, maxCostUsd: 99 },
    });
    expect(child.principal.toolSet).toEqual(["read"]);
    const childLimits = (await getDb().query<{ limits: { max_steps: number; max_seconds: number } }>(
      "SELECT limits FROM agent_runs WHERE id = $1",
      [child.run.id],
    )).rows[0].limits;
    expect(childLimits.max_steps).toBe(3);
    expect(childLimits.max_seconds).toBeLessThanOrEqual(60);

    await parent.finish("completed");
    expect(await authenticateRunPrincipal(getDb(), parent.principal.token)).toBeNull();
    await child.finish("completed");
  });

  it("enforces the tenant daily model budget and sends one admin notification", async () => {
    const db = getDb();
    const previousBudget = process.env.AGENTIC_DAILY_MODEL_BUDGET_USD;
    process.env.AGENTIC_DAILY_MODEL_BUDGET_USD = "1";
    try {
      await db.query(
        `INSERT INTO agent_runs (tenant_id, agent_id, role, model, cost_usd, status)
         VALUES ($1, $2, 'insight', 'test-model', 1, 'completed')`,
        [SEED_IDS.tenantId, SEED_IDS.copilotAgentId],
      );
      const runtime = new AgentRuntimeService(db, "live", undefined, {
        transport: validTransport,
      });

      for (let i = 0; i < 2; i++) {
        const handle = await openRun(runtime, spec({
          agentId: undefined,
          role: "insight",
        }));
        await expect(
          handle.callModel(
            { prompt: "{}", schemaName: "test_v1" },
            (data) => ({ ok: true, value: data }),
          ),
        ).rejects.toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });
      }

      const notifications = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM notifications
         WHERE tenant_id = $1 AND kind = 'model_budget_reached'
           AND event_id = $2`,
        [SEED_IDS.tenantId, `model_budget:${SEED_IDS.tenantId}:${new Date().toISOString().slice(0, 10)}`],
      );
      expect(notifications.rows[0].count).toBe("1");
    } finally {
      if (previousBudget === undefined) delete process.env.AGENTIC_DAILY_MODEL_BUDGET_USD;
      else process.env.AGENTIC_DAILY_MODEL_BUDGET_USD = previousBudget;
    }
  });
});
