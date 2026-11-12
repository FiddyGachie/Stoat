import type { Request, RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { getDb, transaction, type DbClient } from "../../db/connection.js";
import type { AuthenticatedPrincipal } from "../../common/types.js";
import { ForbiddenActionError, ValidationError } from "../../common/errors.js";
import { FeatureDisabledError } from "./commerce-errors.js";

export const AGENTIC_FLAGS = [
  "mandates",
  "watchdog",
  "watchdog_explanations",
  "proposals",
  "payments_analytics",
  "insights",
  "nl_questions",
] as const;
export type AgenticFlag = (typeof AGENTIC_FLAGS)[number];

export async function getFlags(
  db: DbClient,
  tenantId: string,
): Promise<Record<AgenticFlag, boolean>> {
  const result = await db.query<{ settings: unknown }>(
    "SELECT settings FROM tenants WHERE id = $1",
    [tenantId],
  );
  let settings = result.rows[0]?.settings;
  if (typeof settings === "string") {
    try {
      settings = JSON.parse(settings);
    } catch (error) {
      throw new Error("Tenant settings contain invalid JSON.", { cause: error });
    }
  }
  const flags = (settings as { feature_flags?: Record<string, unknown> } | undefined)?.feature_flags;
  return Object.fromEntries(
    AGENTIC_FLAGS.map((flag) => [flag, flags?.[flag] === true]),
  ) as Record<AgenticFlag, boolean>;
}

export async function assertFlag(
  db: DbClient,
  tenantId: string,
  flag: AgenticFlag,
): Promise<void> {
  if (!(await getFlags(db, tenantId))[flag]) throw new FeatureDisabledError(flag);
}

export async function setFlag(input: {
  db: DbClient;
  tenantId: string;
  flag: AgenticFlag;
  enabled: boolean;
  admin: AuthenticatedPrincipal;
  correlationId?: string;
}): Promise<Record<AgenticFlag, boolean>> {
  if (input.admin.type !== "user" || !["operator", "supervisor"].includes(input.admin.role)) {
    throw new ForbiddenActionError();
  }
  return transaction(async (tx) => {
    const result = await tx.query<{ settings: unknown }>(
      "SELECT settings FROM tenants WHERE id = $1 FOR UPDATE",
      [input.tenantId],
    );
    if (!result.rows[0]) throw new ValidationError("Tenant does not exist.");
    let settings = result.rows[0].settings;
    if (typeof settings === "string") settings = JSON.parse(settings);
    const current =
      (settings as { feature_flags?: Record<string, unknown> } | null)?.feature_flags ?? {};
    const previous = current[input.flag] === true;
    const next = { ...current, [input.flag]: input.enabled };
    const nextSettings = { ...(settings as Record<string, unknown>), feature_flags: next };
    await tx.query("UPDATE tenants SET settings = $2::jsonb, updated_at = now() WHERE id = $1", [
      input.tenantId,
      JSON.stringify(nextSettings),
    ]);
    await tx.query(
      `INSERT INTO audit_logs
         (tenant_id, actor_type, actor_id, action, resource_type, resource_id,
          correlation_id, outcome, metadata)
       VALUES ($1, 'user', $2, 'agentic.feature_flag.set', 'tenant', $1, $3, 'success', $4::jsonb)`,
      [
        input.tenantId,
        input.admin.id,
        input.correlationId ?? randomUUID(),
        JSON.stringify({ flag: input.flag, from: previous, to: input.enabled }),
      ],
    );
    return Object.fromEntries(AGENTIC_FLAGS.map((flag) => [flag, next[flag] === true])) as Record<
      AgenticFlag,
      boolean
    >;
  });
}

export function requireFlag(flag: AgenticFlag): RequestHandler {
  return async (req, _res, next) => {
    try {
      const principal = req.principal;
      if (!principal) throw new ForbiddenActionError();
      await assertFlag(getDb(), principal.tenantId, flag);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function isAgentPrincipal(req: Request): boolean {
  return req.principal?.type === "agent";
}
