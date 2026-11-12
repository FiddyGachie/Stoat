/**
 * Tenant funding mode. `tenants.settings.funding_mode` is `direct` (default) or `wallet`.
 * Existing tenants without the key stay `direct`. Only a human operator or supervisor can
 * switch it, and only while no agreement is live under the old mode (Requirements 17.3, 17.4).
 */
import { randomUUID } from "node:crypto";
import { transaction, type DbClient } from "../../db/connection.js";
import { bridgeTenantBudgets, type BridgeOutcome } from "./budget-bridge.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../common/errors.js";

export type FundingMode = "direct" | "wallet";

export const FUNDING_MODES: readonly FundingMode[] = ["direct", "wallet"];

/** Agreement states that are still live under the mode they were accepted in. */
export const FUNDING_MODE_BUSY_STATUSES = [
  "accepted",
  "revision_requested",
  "needs_review",
] as const;

/** Funding mode given to newly created tenants: DEFAULT_FUNDING_MODE, else `direct`. */
export function defaultFundingMode(
  env: NodeJS.ProcessEnv = process.env,
): FundingMode {
  return env.DEFAULT_FUNDING_MODE?.trim().toLowerCase() === "wallet"
    ? "wallet"
    : "direct";
}

function parseSettings(raw: unknown): Record<string, unknown> {
  let s = raw;
  if (typeof s === "string") {
    try {
      s = JSON.parse(s);
    } catch {
      s = {};
    }
  }
  return s && typeof s === "object" ? (s as Record<string, unknown>) : {};
}

export async function getFundingMode(
  db: DbClient,
  tenantId: string,
): Promise<FundingMode> {
  const r = await db.query<{ settings: unknown }>(
    `SELECT settings FROM tenants WHERE id = $1`,
    [tenantId],
  );
  return parseSettings(r.rows[0]?.settings).funding_mode === "wallet"
    ? "wallet"
    : "direct";
}

/** Seed `funding_mode` on a new tenant (called from scaffoldTenant). Never overwrites a value. */
export async function seedFundingMode(
  tx: DbClient,
  tenantId: string,
  mode: FundingMode = defaultFundingMode(),
): Promise<void> {
  await tx.query(
    `UPDATE tenants
        SET settings = jsonb_build_object('funding_mode', $2::text) || COALESCE(settings, '{}'::jsonb)
      WHERE id = $1`,
    [tenantId, mode],
  );
}

export interface SetFundingModeInput {
  tenantId: string;
  mode: unknown;
  actorId: string;
  correlationId?: string;
}

/**
 * Switch the tenant funding mode. Refuses with FUNDING_MODE_BUSY while any agreement is
 * accepted, revision_requested or needs_review. The tenant row is locked for the check and write.
 */
export async function setFundingMode(
  input: SetFundingModeInput,
): Promise<{
  funding_mode: FundingMode;
  previous: FundingMode;
  changed: boolean;
  /** Spending budgets moved into wallets by this switch (wallet mode only). */
  budgets_moved?: BridgeOutcome[];
}> {
  if (
    typeof input.mode !== "string" ||
    !FUNDING_MODES.includes(input.mode as FundingMode)
  ) {
    throw new ValidationError("funding_mode must be 'direct' or 'wallet'.", {
      allowed: [...FUNDING_MODES],
    });
  }
  const mode = input.mode as FundingMode;

  return transaction(async (tx) => {
    const t = await tx.query<{ settings: unknown }>(
      `SELECT settings FROM tenants WHERE id = $1 FOR UPDATE`,
      [input.tenantId],
    );
    if (!t.rows[0]) throw new NotFoundError("Tenant", input.tenantId);
    const settings = parseSettings(t.rows[0].settings);
    const previous: FundingMode =
      settings.funding_mode === "wallet" ? "wallet" : "direct";
    if (previous === mode)
      return { funding_mode: mode, previous, changed: false };

    const busy = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agreements
        WHERE tenant_id = $1 AND status = ANY($2::text[])`,
      [input.tenantId, [...FUNDING_MODE_BUSY_STATUSES]],
    );
    const n = busy.rows[0]?.n ?? 0;
    if (n > 0) {
      throw new ConflictError(
        "FUNDING_MODE_BUSY",
        "The funding mode cannot change while agreements are accepted, awaiting revision or awaiting review.",
        { live_agreements: n, statuses: [...FUNDING_MODE_BUSY_STATUSES] },
      );
    }

    await tx.query(
      `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('funding_mode', $2::text)
        WHERE id = $1`,
      [input.tenantId, mode],
    );
    await tx.query(
      `INSERT INTO audit_logs (
         tenant_id, actor_type, actor_id, action, resource_type, resource_id,
         correlation_id, outcome, metadata
       ) VALUES ($1, 'user', $2, 'admin.funding_mode.set', 'tenant', $1, $3, 'success', $4)`,
      [
        input.tenantId,
        input.actorId,
        input.correlationId && /^[0-9a-f-]{36}$/i.test(input.correlationId)
          ? input.correlationId
          : randomUUID(),
        JSON.stringify({ from: previous, to: mode }),
      ],
    );
    // Approved spending budgets become wallet funds in the same transaction, so missions
    // reserve from them immediately and the books stay balanced (Dr 2101 / Cr 2103).
    const budgets_moved =
      mode === "wallet"
        ? await bridgeTenantBudgets(tx, input.tenantId, {
            actorId: input.actorId,
            correlationId: input.correlationId,
          })
        : undefined;
    return { funding_mode: mode, previous, changed: true, budgets_moved };
  });
}
