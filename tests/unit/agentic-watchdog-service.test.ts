import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { runAgenticSweep } from "../../src/modules/agentic/agentic.sweep.js";
import { runOneJob } from "../../src/jobs/runner.js";
import { AgentRuntimeService } from "../../src/modules/agent-runtime/agent-runtime.service.js";
import type { LlmTransport } from "../../src/modules/agent-runtime/llm-adapter.js";
import { ExplainService } from "../../src/modules/watchdog/explain.service.js";
import {
  validateThresholdParams,
  WatchdogService,
} from "../../src/modules/watchdog/watchdog.service.js";

describe("agentic Watchdog service", () => {
  beforeAll(async () => {
    await resetDb();
    const db = getDb();
    await runMigrations(db);
    await seedDatabase(db);
  });

  beforeEach(async () => {
    await getDb().exec(
      "TRUNCATE TABLE jobs, watchdog_alerts, watchdog_thresholds, watchdog_runs, watchdog_detector_state, notifications, llm_proposals, agent_runs CASCADE",
    );
    await getDb().query(
      `UPDATE tenants
          SET settings = jsonb_set(
            COALESCE(settings, '{}'::jsonb),
            '{feature_flags}',
            COALESCE(settings->'feature_flags', '{}'::jsonb) ||
              '{"watchdog":true,"watchdog_explanations":false}'::jsonb,
            true
          )
        WHERE id = $1`,
      [SEED_IDS.tenantId],
    );
  });

  afterAll(async () => {
    await closeDb();
  });

  it("validates thresholds against detector-specific bounds", () => {
    expect(
      validateThresholdParams("spend_spike", {
        multiplier: 3.5,
        min_observations: 5,
      }),
    ).toEqual({ multiplier: 3.5, min_observations: 5 });
    expect(() =>
      validateThresholdParams("spend_spike", { multiplier: 1 }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() =>
      validateThresholdParams("unusual_provider", { min_price: "0" }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() =>
      validateThresholdParams("repeated_revision", { max_events: 2.5 }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("queues a flagged tenant and evaluates it through the background job", async () => {
    const db = getDb();
    const previousInterval = process.env.WATCHDOG_INTERVAL_MS;
    process.env.WATCHDOG_INTERVAL_MS = "300000";
    try {
      await runAgenticSweep(db);
      const queued = await db.query<{ id: string; type: string }>(
        `SELECT id, type FROM jobs
          WHERE tenant_id = $1 AND type = 'watchdog_evaluate' AND status = 'queued'`,
        [SEED_IDS.tenantId],
      );
      expect(queued.rows).toHaveLength(1);
      expect(await runOneJob(db, "watchdog-test-worker")).toBe(true);

      const runs = await db.query<{ status: string }>(
        "SELECT status FROM watchdog_runs WHERE tenant_id = $1",
        [SEED_IDS.tenantId],
      );
      expect(runs.rows).toHaveLength(1);
      expect(runs.rows[0].status).toBe("ok");
    } finally {
      if (previousInterval === undefined) delete process.env.WATCHDOG_INTERVAL_MS;
      else process.env.WATCHDOG_INTERVAL_MS = previousInterval;
    }
  });

  it("records an evaluation with injected time", async () => {
    const now = new Date("2026-11-12T00:00:00.000Z");
    const result = await new WatchdogService(getDb()).evaluateTenant(
      SEED_IDS.tenantId,
      { now },
    );
    expect(result.status).toBe("ok");
    const run = await getDb().query<{ started_at: string; finished_at: string }>(
      "SELECT started_at::text, finished_at::text FROM watchdog_runs WHERE id = $1",
      [result.runId],
    );
    expect(run.rows[0].finished_at).toBeTruthy();
  });

  it("generates one validated explanation and returns the cached result", async () => {
    const db = getDb();
    const alertId = "00000000-0000-0000-0000-000000000311";
    await db.query(
      `UPDATE tenants
          SET settings = jsonb_set(
            settings,
            '{feature_flags}',
            COALESCE(settings->'feature_flags', '{}'::jsonb) || '{"watchdog_explanations":true}'::jsonb,
            true
          )
        WHERE id = $1`,
      [SEED_IDS.tenantId],
    );
    await db.query(
      `INSERT INTO watchdog_alerts
         (id, tenant_id, detector, detector_version, severity, subject_type, subject_id, evidence)
       VALUES ($1,$2,'spend_spike','1','medium','wallet',$3,'{"ratio":"4.00"}'::jsonb)`,
      [alertId, SEED_IDS.tenantId, "00000000-0000-0000-0000-000000000312"],
    );

    let calls = 0;
    const transport: LlmTransport = async () => {
      calls++;
      return {
        data: {
          summary: "The spending pattern is above its usual range.",
          factors: ["Recent activity differs from prior behavior."],
          next_step: "review_evidence",
        },
        inputTokens: 10,
        outputTokens: 20,
      };
    };
    const runtime = new AgentRuntimeService(db, "live", undefined, { transport });
    const service = new ExplainService(db, runtime);
    const first = await service.explain({
      tenantId: SEED_IDS.tenantId,
      alertId,
    });
    const second = await service.explain({
      tenantId: SEED_IDS.tenantId,
      alertId,
    });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.explanation).toEqual(first.explanation);
    expect(calls).toBe(1);
    const alert = await db.query<{ status: string; evidence: unknown }>(
      "SELECT status, evidence FROM watchdog_alerts WHERE id = $1",
      [alertId],
    );
    expect(alert.rows[0]).toMatchObject({
      status: "open",
      evidence: { ratio: "4.00" },
    });
  });

  it("keeps one open alert and resolves it after two clear evaluations", async () => {
    const db = getDb();
    const subjectId = "00000000-0000-0000-0000-000000000321";
    await db.query(
      `INSERT INTO watchdog_thresholds (tenant_id, detector, params)
       VALUES ($1, 'repeated_revision', '{"max_events":1}'::jsonb)`,
      [SEED_IDS.tenantId],
    );
    await db.query(
      `INSERT INTO economic_events
         (tenant_id, aggregate_type, aggregate_id, sequence, event_type, actor_type,
          actor_id, correlation_id, payload, payload_hash)
       VALUES
         ($1,'agreement',$2,1,'REVISION_REQUESTED','agent',$3,$4,'{}'::jsonb,'test-1'),
         ($1,'agreement',$2,2,'DELIVERY_REJECTED','agent',$3,$5,'{}'::jsonb,'test-2')`,
      [
        SEED_IDS.tenantId,
        subjectId,
        SEED_IDS.providerAgentId,
        "00000000-0000-0000-0000-000000000322",
        "00000000-0000-0000-0000-000000000323",
      ],
    );

    await new WatchdogService(db).evaluateTenant(SEED_IDS.tenantId);
    await new WatchdogService(db).evaluateTenant(SEED_IDS.tenantId);
    const alert = await db.query<{ id: string; clear_streak: number; status: string }>(
      `SELECT id, clear_streak, status FROM watchdog_alerts
        WHERE tenant_id = $1 AND detector = 'repeated_revision' AND subject_id = $2`,
      [SEED_IDS.tenantId, subjectId],
    );
    expect(alert.rows).toHaveLength(1);
    expect(alert.rows[0].status).toBe("open");
    expect(alert.rows[0].clear_streak).toBe(0);

    await db.query(
      `UPDATE watchdog_thresholds SET params = '{"max_events":2}'::jsonb
        WHERE tenant_id = $1 AND detector = 'repeated_revision'`,
      [SEED_IDS.tenantId],
    );
    await new WatchdogService(db).evaluateTenant(SEED_IDS.tenantId);
    const oneClear = await db.query<{ clear_streak: number; status: string }>(
      "SELECT clear_streak, status FROM watchdog_alerts WHERE id = $1",
      [alert.rows[0].id],
    );
    expect(oneClear.rows[0]).toMatchObject({ clear_streak: 1, status: "open" });

    await new WatchdogService(db).evaluateTenant(SEED_IDS.tenantId);
    const resolved = await db.query<{ clear_streak: number; status: string; resolved_at: string }>(
      "SELECT clear_streak, status, resolved_at::text FROM watchdog_alerts WHERE id = $1",
      [alert.rows[0].id],
    );
    expect(resolved.rows[0].status).toBe("resolved");
    expect(resolved.rows[0].clear_streak).toBe(2);
    expect(resolved.rows[0].resolved_at).toBeTruthy();
  });
});
