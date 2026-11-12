import type { DbClient } from "../../db/connection.js";
import { MandateService } from "../mandates/mandate.service.js";
import { ProposalService } from "../proposals/proposal.service.js";
import { requeueApprovedProposals } from "../proposals/proposal.executor.js";
import { queueIntegrityChecks } from "../agent-tools/integrity-check.js";
import { watchdogIntervalMs } from "./agentic-config.js";

export type AgenticSweepStep = (db: DbClient) => Promise<unknown>;

const steps: AgenticSweepStep[] = [];

steps.push(async (db) => {
  await new MandateService(db).sweep();
});

steps.push(async (db) => {
  await new ProposalService(db).expireDue();
});

steps.push(async (db) => {
  await requeueApprovedProposals(db);
});

steps.push(async (db) => {
  await db.query(
    `INSERT INTO jobs (tenant_id, type, payload, status, priority)
     SELECT t.id, 'watchdog_evaluate',
       jsonb_build_object('tenant_id', t.id::text), 'queued', 1
       FROM tenants t
      WHERE t.settings #>> '{feature_flags,watchdog}' = 'true'
        AND NOT EXISTS (
          SELECT 1 FROM watchdog_runs r
           WHERE r.tenant_id = t.id
             AND r.started_at >= now() - ($1 * interval '1 millisecond')
        )
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
           WHERE j.tenant_id = t.id AND j.type = 'watchdog_evaluate'
             AND j.status IN ('queued', 'running')
        )`,
    [watchdogIntervalMs()],
  );
});

steps.push(queueIntegrityChecks);

export function registerAgenticSweepStep(step: AgenticSweepStep): void {
  steps.push(step);
}

export async function runAgenticSweep(
  db: DbClient,
): Promise<{ steps: number; errors: number }> {
  let errors = 0;
  for (const [index, step] of steps.entries()) {
    try {
      await step(db);
    } catch (error) {
      errors++;
      console.error(
        `[AgenticSweep] step ${index + 1} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { steps: steps.length, errors };
}
