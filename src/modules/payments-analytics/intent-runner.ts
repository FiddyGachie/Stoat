/**
 * Read_Intent runner (R13.4, R13.5, R13.6, R13.7, R13.13).
 *
 * Pipeline: strip model-supplied scope keys, find the intent, check the role (Audit_Log on a
 * refusal), validate parameters against the intent's strict schema, run inside
 * `readOnlyTransaction` with the tenant, role and Owner scope taken from the principal, drop
 * undeclared columns, and cap rows at `INTENT_ROW_LIMIT` with a `truncated` flag. A timeout
 * surfaces as `ANALYTICS_TIMEOUT` and no partial rows are returned.
 */
import { randomUUID } from "node:crypto";
import { getDb, readOnlyTransaction, type DbClient } from "../../db/connection.js";
import { ForbiddenActionError } from "../../common/errors.js";
import type { AuthenticatedPrincipal } from "../../common/types.js";
import { analyticsTimeoutMs, intentRowLimit } from "../agentic/agentic-config.js";
import { AgentOutputInvalidError } from "../agentic/commerce-errors.js";
import { scopeFromPrincipal } from "./read-models.js";
import {
  FORBIDDEN_COLUMN_PATTERN,
  IGNORED_PARAM_KEYS,
  INTENT_CATALOG_VERSION,
  catalogRoleFor,
  getIntent,
  type IntentChart,
  type IntentColumn,
  type Row,
} from "./intent-catalog.js";

export type RunnerPrincipal = Pick<
  AuthenticatedPrincipal,
  "id" | "tenantId" | "type" | "role"
>;

export interface ReadIntentResult {
  intent: string;
  version: string;
  catalog_version: string;
  params: Record<string, unknown>;
  columns: readonly IntentColumn[];
  chart?: IntentChart;
  rows: Row[];
  row_count: number;
  truncated: boolean;
}

export interface RunReadIntentOptions {
  now?: Date;
  correlationId?: string;
  /** Client for the Audit_Log write on a refusal. Defaults to the shared client. */
  auditDb?: DbClient;
  timeoutMs?: number;
  rowLimit?: number;
}

/** Remove keys a model must not control. Returns a new object; never mutates the input. */
export function stripScopeKeys(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if ((IGNORED_PARAM_KEYS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out;
}

async function auditRefusal(
  principal: RunnerPrincipal,
  intent: string,
  opts: RunReadIntentOptions,
): Promise<void> {
  const db = opts.auditDb ?? getDb();
  await db.query(
    `INSERT INTO audit_logs
       (tenant_id, actor_type, actor_id, action, resource_type, resource_id,
        correlation_id, outcome, metadata)
     VALUES ($1,$2,$3,'analytics.intent.forbidden','tenant',$1,$4,'failure',$5::jsonb)`,
    [
      principal.tenantId,
      principal.type === "user" ? "user" : "agent",
      principal.id,
      opts.correlationId ?? randomUUID(),
      JSON.stringify({ intent, role: principal.role, code: "FORBIDDEN_ACTION" }),
    ],
  );
}

export async function runReadIntent(
  principal: RunnerPrincipal,
  name: string,
  rawParams: unknown,
  opts: RunReadIntentOptions = {},
): Promise<ReadIntentResult> {
  const intent = getIntent(name);
  if (!intent) {
    throw new AgentOutputInvalidError("Unknown Read_Intent.", { intent: String(name) });
  }

  // Throws FORBIDDEN_ACTION for agents, viewers and other non-analytics roles.
  const scope = scopeFromPrincipal(principal);
  const role = catalogRoleFor(principal.role);
  if (!role || !intent.roles.includes(role)) {
    await auditRefusal(principal, intent.name, opts);
    throw new ForbiddenActionError();
  }

  const parsed = intent.params.safeParse(stripScopeKeys(rawParams));
  if (!parsed.success) {
    throw new AgentOutputInvalidError("Read_Intent parameters failed validation.", {
      intent: intent.name,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const params = parsed.data as Record<string, unknown>;

  const configured = opts.rowLimit ?? intentRowLimit();
  const requested = typeof params.limit === "number" ? params.limit : configured;
  const limit = Math.max(1, Math.min(configured, requested));
  const now = opts.now ?? new Date();

  // A timeout rejects the whole call, so no partial rows can escape.
  const result = await readOnlyTransaction(
    (db) => intent.run({ db, scope, now }, params),
    { timeoutMs: opts.timeoutMs ?? analyticsTimeoutMs() },
  );

  const declared = intent.columns
    .map((c) => c.field)
    .filter((f) => !FORBIDDEN_COLUMN_PATTERN.test(f));
  const capped = result.rows.slice(0, limit).map((row) => {
    const out: Row = {};
    for (const f of declared) out[f] = row[f] === undefined ? null : row[f];
    return out;
  });

  return {
    intent: intent.name,
    version: intent.version,
    catalog_version: INTENT_CATALOG_VERSION,
    params,
    columns: intent.columns,
    ...(intent.chart ? { chart: intent.chart } : {}),
    rows: capped,
    row_count: capped.length,
    truncated: result.truncated || result.rows.length > limit,
  };
}
