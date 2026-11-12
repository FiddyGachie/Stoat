/**
 * Agent integrity check (agentic-commerce task 14.3, R14.12).
 *
 * Fails when an agent has touched money: an agent-actor money event, a successful agent money
 * Audit_Log row, an agent ID in a human-only money column, or a tool run outside the eight tools.
 * Each violation creates one `agent_integrity_violation` Admin notification naming the record.
 * Read-only apart from notifications, so it is safe to run repeatedly (notifications are idempotent
 * per violation).
 */
import type { DbClient } from "../../db/connection.js";
import { notifyInTx } from "../wallet/notification.service.js";
import { TOOL_DEFINITIONS } from "./tool-definitions.js";

export type IntegrityViolationKind =
  | "agent_money_event"
  | "agent_money_audit"
  | "agent_in_human_column"
  | "tool_run_out_of_set";

export interface IntegrityViolation {
  kind: IntegrityViolationKind;
  record_type: string;
  record_id: string;
  detail: string;
}

export interface IntegrityResult {
  ok: boolean;
  checked_at: string;
  violations: IntegrityViolation[];
  notifications_created: number;
}

/** Money event types an agent may never author (design section 6). */
export const MONEY_EVENT_PATTERN =
  "^(DEPOSIT_|WALLET_REFUND|WALLET_CHARGED|FUNDING_|FUNDED_BATCH_RELEASED|PAYPAL_|PAYOUT_|PAYMENT_RECONCILED|SETTLEMENT_BATCH_APPROVED|RECIPIENT_|MISSION_REMAINDER_DECIDED)";

/** Audit actions that move or authorize money. */
export const MONEY_AUDIT_PATTERN =
  "(deposit|capture|refund|payout|approv|recipient)";

const TOOL_NAME_SET: string[] = TOOL_DEFINITIONS.map((d) => d.name);
const LIMIT = 200;

const short = (s: unknown) => String(s).slice(0, 80);

export async function findViolations(
  db: DbClient,
  tenantId: string,
): Promise<IntegrityViolation[]> {
  const out: IntegrityViolation[] = [];

  const events = await db.query<{ id: string; event_type: string }>(
    `SELECT id, event_type FROM economic_events
      WHERE tenant_id = $1 AND actor_type = 'agent' AND event_type ~ $2
      ORDER BY recorded_at LIMIT ${LIMIT}`,
    [tenantId, MONEY_EVENT_PATTERN],
  );
  for (const r of events.rows) {
    out.push({
      kind: "agent_money_event",
      record_type: "economic_event",
      record_id: r.id,
      detail: `agent-authored money event ${short(r.event_type)}`,
    });
  }

  // Tool-call rows (agent_tool.*) and proposals are not money operations.
  const audits = await db.query<{ id: string; action: string }>(
    `SELECT id, action FROM audit_logs
      WHERE tenant_id = $1 AND actor_type = 'agent' AND outcome = 'success'
        AND action !~* '^agent_tool\\.' AND action !~* 'propos'
        AND action ~* $2
      ORDER BY created_at LIMIT ${LIMIT}`,
    [tenantId, MONEY_AUDIT_PATTERN],
  );
  for (const r of audits.rows) {
    out.push({
      kind: "agent_money_audit",
      record_type: "audit_log",
      record_id: r.id,
      detail: `successful agent money action ${short(r.action)}`,
    });
  }

  const columns: Array<[string, string, string]> = [
    ["wallet_deposits", "owner_user_id", "wallet_deposit"],
    ["wallet_refunds", "actor_user_id", "wallet_refund"],
    ["payouts", "requested_by", "payout"],
  ];
  for (const [table, column, type] of columns) {
    const rows = await db.query<{ id: string }>(
      `SELECT t.id FROM ${table} t
        WHERE t.tenant_id = $1 AND t.${column} IN (SELECT a.id FROM agents a)
        LIMIT ${LIMIT}`,
      [tenantId],
    );
    for (const r of rows.rows) {
      out.push({
        kind: "agent_in_human_column",
        record_type: type,
        record_id: r.id,
        detail: `agent ID in ${table}.${column}`,
      });
    }
  }

  const runs = await db.query<{ id: string; tool_set: string[] }>(
    `SELECT id, tool_set FROM agent_runs
      WHERE tenant_id = $1 AND scope->>'subject' = 'agent_tool'
        AND (cardinality(tool_set) = 0 OR NOT (tool_set <@ $2::text[]))
      ORDER BY created_at LIMIT ${LIMIT}`,
    [tenantId, TOOL_NAME_SET],
  );
  for (const r of runs.rows) {
    out.push({
      kind: "tool_run_out_of_set",
      record_type: "agent_run",
      record_id: r.id,
      detail: `tool run outside the allowed set: ${short((r.tool_set ?? []).join(",") || "none")}`,
    });
  }
  return out;
}

export async function runIntegrityCheck(
  db: DbClient,
  tenantId: string,
): Promise<IntegrityResult> {
  const violations = await findViolations(db, tenantId);
  let created = 0;
  for (const v of violations) {
    const rows = await notifyInTx(db, {
      tenantId,
      kind: "agent_integrity_violation",
      recipient: { admins: true },
      title: "Agent integrity violation",
      body: `${v.detail}. Record: ${v.record_type} ${v.record_id}.`,
      eventId: `agent_integrity:${v.kind}:${v.record_id}`,
    });
    created += rows.length;
  }
  return {
    ok: violations.length === 0,
    checked_at: new Date().toISOString(),
    violations,
    notifications_created: created,
  };
}

/** Job handler: `agent_integrity_check` with `{ tenant_id }`. Fails the job summary text on violations. */
export async function handleIntegrityCheckJob(
  db: DbClient,
  payload: { tenant_id?: string },
): Promise<string> {
  if (!payload.tenant_id)
    throw new Error("agent_integrity_check requires tenant_id.");
  const r = await runIntegrityCheck(db, payload.tenant_id);
  return r.ok
    ? "Integrity check clean"
    : `Integrity check found ${r.violations.length} violation(s)`;
}

/** Sweep step: queue one check per tenant when none was queued in the last 24 hours. */
export async function queueIntegrityChecks(db: DbClient): Promise<void> {
  await db.query(
    `INSERT INTO jobs (tenant_id, type, payload, status, priority)
     SELECT t.id, 'agent_integrity_check',
            jsonb_build_object('tenant_id', t.id::text), 'queued', 0
       FROM tenants t
      WHERE NOT EXISTS (
        SELECT 1 FROM jobs j
         WHERE j.tenant_id = t.id AND j.type = 'agent_integrity_check'
           AND j.created_at >= now() - interval '24 hours'
      )`,
  );
}
