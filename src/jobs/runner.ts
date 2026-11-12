/**
 * Background jobs on the PostgreSQL `jobs` table.
 *
 * Claiming uses FOR UPDATE SKIP LOCKED, so the API process and the worker can both run this
 * loop without double-processing. Every handler is idempotent.
 */
import { DbClient } from "../db/connection.js";
import { AgentRuntimeService } from "../modules/agent-runtime/agent-runtime.service.js";
import { deliverEmail } from "../modules/wallet/notification.service.js";
import type { PayPalGateway } from "../modules/paypal/paypal.gateway.js";
import { handleReconciliationJob } from "../modules/wallet/reconciliation.service.js";
import { handleMissionCompletionJob } from "../modules/wallet/mission-completion.service.js";
import { handleHeldAccrual, type DeferredJob } from "./held-accrual.js";
import { WatchdogService } from "../modules/watchdog/watchdog.service.js";
import { executeProposal } from "../modules/proposals/proposal.executor.js";
import { handleIntegrityCheckJob } from "../modules/agent-tools/integrity-check.js";
import { ExplainService } from "../modules/watchdog/explain.service.js";

const MAX_ATTEMPTS = parseInt(process.env.WORKER_MAX_ATTEMPTS || "5", 10);

/** Errors that will not get better by retrying (missing configuration). The job is parked as dead at once. */
const NON_RETRYABLE = new Set([
  "LLM_NOT_CONFIGURED",
  "REPLAY_NOT_FOUND",
  "NOT_FOUND",
]);

type Job = {
  id: string;
  type: string;
  payload: any;
  attempts: number;
  max_attempts?: number;
};

/** What handlers depend on. Production uses the defaults; tests pass a runtime with a model test double. */
export interface JobDeps {
  runtime?: AgentRuntimeService;
  /** PayPal gateway for reconciliation; production uses the configured one. */
  gateway?: PayPalGateway;
}

async function handleProviderReview(
  db: DbClient,
  payload: { agreement_id?: string },
  deps: JobDeps,
): Promise<string> {
  const r = await db.query<{
    tenant_id: string;
    provider_id: string;
    status: string;
    funding_status: string;
    price: string;
    execution_mode: string;
  }>(
    `SELECT a.tenant_id, a.provider_id, a.status, a.funding_status, a.price, s.execution_mode
     FROM agreements a JOIN quotes q ON q.id = a.quote_id JOIN services s ON s.id = q.service_id
     WHERE a.id = $1`,
    [payload.agreement_id],
  );
  const ag = r.rows[0];
  if (!ag) return "agreement not found";
  if (ag.execution_mode !== "hosted")
    return "external provider delivers itself";
  if (ag.status !== "accepted" && ag.status !== "revision_requested")
    return `nothing to do (agreement ${ag.status})`;
  if (
    process.env.REQUIRE_FUNDING === "true" &&
    Number(ag.price) > 0 &&
    ag.funding_status !== "funded"
  ) {
    return "waiting for the buyer payment; queued again when PayPal captures it";
  }
  const out = await (
    deps.runtime ?? new AgentRuntimeService(db)
  ).executeCodeReviewWithRevisions({
    tenantId: ag.tenant_id,
    agreementId: payload.agreement_id!,
    providerAgentId: ag.provider_id,
  });
  return `review finished: ${out.final.verification.verdict} after ${out.attempts.length} attempt(s)`;
}

const HANDLERS: Record<
  string,
  (
    db: DbClient,
    payload: any,
    deps: JobDeps,
  ) => Promise<string | void | DeferredJob>
> = {
  noop: async () => undefined,
  provider_review: handleProviderReview,
  // Optional email for wallet notifications; the job row carries max_attempts = 3 (R7.16).
  wallet_email: (db, payload) => deliverEmail(db, payload),
  // Completes a wallet-mode mission once it has agreements and none is live (design decision 5).
  wallet_mission_completion: (db, payload) =>
    handleMissionCompletionJob(db, payload),
  // Scheduled reconciliation for one tenant (R11.8); enqueued by the wallet sweep.
  wallet_reconciliation: (db, payload, deps) =>
    handleReconciliationJob(db, payload, deps.gateway),
  held_accrual: (db, payload) => handleHeldAccrual(db, payload),
  agent_integrity_check: (db, payload) => handleIntegrityCheckJob(db, payload),
  watchdog_evaluate: async (db, payload: { tenant_id?: string }) => {
    if (!payload.tenant_id)
      throw new Error("watchdog_evaluate requires tenant_id.");
    const result = await new WatchdogService(db).evaluateTenant(
      payload.tenant_id,
    );
    return `Watchdog evaluation ${result.status}`;
  },
  proposal_execute: async (
    db,
    payload: {
      tenant_id?: string;
      proposal_id?: string;
      correlation_id?: string;
    },
  ) => {
    if (!payload.tenant_id || !payload.proposal_id) {
      throw new Error("proposal_execute requires tenant_id and proposal_id.");
    }
    const out = await executeProposal(db, {
      tenantId: payload.tenant_id,
      proposalId: payload.proposal_id,
      correlationId: payload.correlation_id ?? undefined,
    });
    return out.status === "skipped"
      ? `Proposal execution skipped: ${out.note}`
      : `Proposal ${out.status}: ${out.code}`;
  },
  watchdog_explain: async (
    db,
    payload: { tenant_id?: string; alert_id?: string; correlation_id?: string },
  ) => {
    if (!payload.tenant_id || !payload.alert_id) {
      throw new Error("watchdog_explain requires tenant_id and alert_id.");
    }
    const explanation = await new ExplainService(db).explain({
      tenantId: payload.tenant_id,
      alertId: payload.alert_id,
      correlationId: payload.correlation_id,
    });
    return explanation.reused
      ? "Watchdog explanation already exists"
      : "Watchdog explanation stored";
  },
};

async function claim(db: DbClient, workerId: string): Promise<Job | null> {
  const res = await db.query<Job>(
    `WITH candidate AS (
       SELECT id FROM jobs WHERE status = 'queued' AND run_after <= now()
       ORDER BY priority DESC, created_at FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1
     WHERE id IN (SELECT id FROM candidate)
     RETURNING id, type, payload, attempts, max_attempts`,
    [workerId],
  );
  return res.rows[0] ?? null;
}

async function fail(db: DbClient, job: Job, err: any): Promise<void> {
  const message = String(err?.message ?? err).slice(0, 1000);
  const limit = Math.min(MAX_ATTEMPTS, job.max_attempts ?? MAX_ATTEMPTS);
  if (job.attempts >= limit || NON_RETRYABLE.has(err?.code)) {
    await db.query(
      `UPDATE jobs SET status = 'dead', error = $1, completed_at = now() WHERE id = $2`,
      [message, job.id],
    );
    console.error(`[Jobs] ${job.type} ${job.id} stopped: ${message}`);
    return;
  }
  const backoffSecs = Math.min(30 * Math.pow(2, job.attempts - 1), 3600);
  await db.query(
    `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL,
       run_after = now() + ($1 * interval '1 second'), error = $2 WHERE id = $3`,
    [backoffSecs, message, job.id],
  );
}

/** Process one job if one is due. Returns true if a job was handled. Exported for tests and scripts. */
export async function runOneJob(
  db: DbClient,
  workerId = `jobs-${process.pid}`,
  deps: JobDeps = {},
): Promise<boolean> {
  const job = await claim(db, workerId);
  if (!job) return false;
  const handler = HANDLERS[job.type];
  try {
    if (!handler) throw new Error(`Unknown job type: ${job.type}`);
    const result = await handler(
      db,
      typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload,
      deps,
    );
    if (result && typeof result === "object" && "deferSeconds" in result) {
      await db.query(
        `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL,
           run_after = now() + ($1 * interval '1 second'), error = $2 WHERE id = $3`,
        [result.deferSeconds, result.note.slice(0, 1000), job.id],
      );
      return true;
    }
    await db.query(
      `UPDATE jobs SET status = 'succeeded', completed_at = now(), error = $2 WHERE id = $1`,
      [job.id, result ?? null],
    );
    if (result) console.log(`[Jobs] ${job.type} ${job.id}: ${result}`);
  } catch (err) {
    await fail(db, job, err);
  }
  return true;
}

/** Poll for jobs until stopped. Reclaims locks left by a crashed process. */
export function startJobRunner(
  db: DbClient,
  opts: { pollMs?: number; workerId?: string } = {},
): () => void {
  const pollMs =
    opts.pollMs ?? parseInt(process.env.WORKER_POLL_INTERVAL_MS || "2000", 10);
  const workerId = opts.workerId ?? `jobs-${process.pid}`;
  let stopped = false;
  void db
    .query(
      `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL
     WHERE status = 'running' AND locked_at < now() - interval '5 minutes'`,
    )
    .catch(() => undefined);
  (async () => {
    while (!stopped) {
      try {
        if (!(await runOneJob(db, workerId)))
          await new Promise((r) => setTimeout(r, pollMs));
      } catch (err) {
        console.error(
          "[Jobs] poll error:",
          err instanceof Error ? err.message : err,
        );
        await new Promise((r) => setTimeout(r, pollMs * 2));
      }
    }
  })();
  return () => {
    stopped = true;
  };
}
