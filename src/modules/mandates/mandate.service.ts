import { Decimal } from "decimal.js";
import {
  ConflictError,
  ForbiddenActionError,
  NotFoundError,
  ValidationError,
} from "../../common/errors.js";
import type { AuthenticatedPrincipal } from "../../common/types.js";
import { sha256 } from "../../common/crypto.js";
import { transaction, type DbClient } from "../../db/connection.js";
import { configuredEnvironment } from "../wallet/wallet.service.js";
import { getFundingMode } from "../wallet/funding-mode.js";
import { appendCommerceEvent } from "../agentic/commerce-events.js";
import { MandateTermsImmutableError } from "../agentic/commerce-errors.js";
import { mandateMaxLifetimeDays } from "../agentic/agentic-config.js";
import { assertFlag } from "../agentic/feature-flags.js";
import { recordRefusal } from "../agentic/redact.js";
import { getMandateUsage } from "./mandate-usage.js";
import { mandateRemaining } from "./mandate-evaluator.js";
import { validateMandateInput } from "./mandate-validation.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const ADMIN_ROLES = new Set(["operator", "supervisor"]);

export interface MandateRow {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  wallet_id: string;
  currency: string;
  per_agreement_max: string;
  daily_cap: string;
  total_cap: string;
  allowed_categories: string[];
  mission_scope: string[] | null;
  expires_at: Date | string;
  status: "active" | "expired" | "revoked" | "exhausted" | "suspended";
  terms_hash: string;
  request_hash: string;
  signed_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  revoked_by?: string | null;
  revoked_at?: Date | string | null;
  suspended_at?: Date | string | null;
  suspension_lifted_by?: string | null;
  suspension_lifted_at?: Date | string | null;
}

function isAdmin(actor: AuthenticatedPrincipal): boolean {
  return actor.type === "user" && ADMIN_ROLES.has(String(actor.role));
}

function ownerOnly(actor: AuthenticatedPrincipal, ownerId: string): void {
  if (actor.type !== "user" || actor.id !== ownerId || actor.role !== "buyer") {
    throw new ForbiddenActionError();
  }
}

function objectValue(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  throw new ValidationError("Mandate input must be an object.", {
    fields: ["body"],
  });
}

export class MandateService {
  constructor(private readonly db: DbClient) {}

  async create(input: {
    tenantId: string;
    actor: AuthenticatedPrincipal;
    body: unknown;
    idempotencyKey: string;
    correlationId?: string;
    now?: Date;
  }): Promise<MandateRow> {
    if (input.actor.type !== "user") {
      await recordRefusal(this.db, {
        tenantId: input.tenantId,
        principal: {
          type: input.actor.type,
          id: input.actor.id,
          role: String(input.actor.role),
        },
        operation: "mandate.create",
        reasons: ["agent_principal"],
        correlationId: input.correlationId,
        resource: { type: "mandate", id: NIL_UUID },
      });
      throw new ForbiddenActionError();
    }
    if (input.actor.role !== "buyer") throw new ForbiddenActionError();
    const body = objectValue(input.body);
    const currency =
      typeof body.currency === "string" ? body.currency.toUpperCase() : "USD";
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new ValidationError("currency must be an ISO 4217 code.", {
        fields: ["currency"],
      });
    }
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
      throw new ValidationError("Idempotency-Key is required.", {
        fields: ["Idempotency-Key"],
      });
    }
    const now = input.now ?? new Date();
    return transaction(async (tx) => {
      await assertFlag(tx, input.tenantId, "mandates");
      if ((await getFundingMode(tx, input.tenantId)) !== "wallet") {
        throw new ConflictError(
          "MANDATE_REQUIRES_WALLET_MODE",
          "Mandates require wallet funding mode.",
        );
      }
      const walletResult = await tx.query<{ id: string; currency: string }>(
        `SELECT id, currency FROM wallets
         WHERE tenant_id = $1 AND owner_user_id = $2 AND currency = $3
           AND paypal_environment = $4
         FOR UPDATE`,
        [input.tenantId, input.actor.id, currency, configuredEnvironment()],
      );
      const wallet = walletResult.rows[0];
      if (!wallet) {
        throw new ConflictError(
          "WALLET_NOT_OWNED",
          "An eligible wallet for this currency was not found.",
        );
      }
      const categoryRows = await tx.query<{ category: string }>(
        "SELECT DISTINCT category FROM services WHERE tenant_id = $1",
        [input.tenantId],
      );
      const requestedMissions = Array.isArray(body.mission_scope)
        ? body.mission_scope.filter(
            (id): id is string => typeof id === "string",
          )
        : [];
      const missions = requestedMissions.length
        ? await tx.query<{ id: string }>(
            `SELECT m.id FROM missions m JOIN agents a ON a.id = m.buyer_id
             WHERE m.tenant_id = $1 AND a.owner_user_id = $2 AND m.id = ANY($3::uuid[])`,
            [input.tenantId, input.actor.id, requestedMissions],
          )
        : { rows: [] as Array<{ id: string }> };
      const validation = validateMandateInput(body, {
        walletCurrency: wallet.currency,
        now,
        maxLifetimeDays: mandateMaxLifetimeDays(),
        categoryCatalog: new Set(categoryRows.rows.map((row) => row.category)),
        ownedMissionIds: new Set(missions.rows.map((row) => row.id)),
      });
      if (!validation.ok) {
        throw new ValidationError("Mandate terms are invalid.", {
          fields: validation.errors,
        });
      }
      const requestHash = sha256({
        terms: validation.value,
        currency,
      });
      const existing = await tx.query<MandateRow>(
        `SELECT * FROM mandates
         WHERE tenant_id = $1 AND owner_user_id = $2 AND idempotency_key = $3`,
        [input.tenantId, input.actor.id, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) {
          throw new ConflictError(
            "IDEMPOTENCY_CONFLICT",
            "The Idempotency-Key was already used with different Mandate terms.",
          );
        }
        return existing.rows[0];
      }
      const terms = {
        currency,
        per_agreement_max: validation.value.perAgreementMax,
        daily_cap: validation.value.dailyCap,
        total_cap: validation.value.totalCap,
        allowed_categories: validation.value.allowedCategories,
        mission_scope: validation.value.missionScope,
        expires_at: validation.value.expiresAt.toISOString(),
      };
      const inserted = await tx.query<MandateRow>(
        `INSERT INTO mandates
           (tenant_id, owner_user_id, wallet_id, currency, per_agreement_max, daily_cap,
            total_cap, allowed_categories, mission_scope, expires_at, terms_hash,
            signed_by, idempotency_key, request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$2,$12,$13)
         RETURNING *`,
        [
          input.tenantId,
          input.actor.id,
          wallet.id,
          currency,
          validation.value.perAgreementMax,
          validation.value.dailyCap,
          validation.value.totalCap,
          validation.value.allowedCategories,
          validation.value.missionScope,
          validation.value.expiresAt.toISOString(),
          sha256(terms),
          input.idempotencyKey,
          requestHash,
        ],
      );
      const mandate = inserted.rows[0];
      await appendCommerceEvent(tx, {
        tenantId: input.tenantId,
        aggregateType: "mandate",
        aggregateId: mandate.id,
        eventType: "MANDATE_CREATED",
        actorType: "user",
        actorId: input.actor.id,
        correlationId: input.correlationId,
        currency,
        details: {
          owner_user_id: input.actor.id,
          terms_hash: mandate.terms_hash,
        },
        idempotencyKey: `mandate-created:${mandate.id}`,
      });
      return mandate;
    });
  }

  async list(input: {
    tenantId: string;
    actor: AuthenticatedPrincipal;
    limit?: number;
    offset?: number;
  }): Promise<MandateRow[]> {
    if (input.actor.type !== "user") throw new ForbiddenActionError();
    const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 50)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const ownerScope =
      input.actor.type === "user" && !isAdmin(input.actor)
        ? "AND owner_user_id = $2"
        : "";
    const params =
      ownerScope === ""
        ? [input.tenantId, limit, offset]
        : [input.tenantId, input.actor.id, limit, offset];
    const limitParam = ownerScope === "" ? "$2" : "$3";
    const offsetParam = ownerScope === "" ? "$3" : "$4";
    const result = await this.db.query<MandateRow>(
      `SELECT * FROM mandates WHERE tenant_id = $1 ${ownerScope}
       ORDER BY created_at DESC, id LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    );
    return result.rows;
  }

  async get(input: {
    tenantId: string;
    actor: AuthenticatedPrincipal;
    mandateId: string;
  }): Promise<
    MandateRow & {
      usage: string;
      today_usage: string;
      remaining: string;
      reservations: unknown[];
    }
  > {
    if (input.actor.type !== "user") throw new NotFoundError("Mandate");
    const ownerScope =
      input.actor.type === "user" && !isAdmin(input.actor)
        ? "AND owner_user_id = $3"
        : "";
    const params = ownerScope
      ? [input.mandateId, input.tenantId, input.actor.id]
      : [input.mandateId, input.tenantId];
    const result = await this.db.query<MandateRow>(
      `SELECT * FROM mandates WHERE id = $1 AND tenant_id = $2 ${ownerScope}`,
      params,
    );
    const mandate = result.rows[0];
    if (!mandate) throw new NotFoundError("Mandate");
    const usage = await getMandateUsage(this.db, mandate.id);
    const reservations = await this.db.query(
      `SELECT r.id, r.agreement_id, a.status AS agreement_status, r.amount, r.status, r.created_at
       FROM wallet_reservations r JOIN agreements a ON a.id = r.agreement_id
       WHERE r.tenant_id = $1 AND r.mandate_id = $2
       ORDER BY r.created_at DESC LIMIT 100`,
      [input.tenantId, mandate.id],
    );
    const remaining = mandateRemaining({
      totalCap: new Decimal(mandate.total_cap),
      usage: usage.usage,
      dailyCap: new Decimal(mandate.daily_cap),
      todayUsage: usage.todayUsage,
    });
    return {
      ...mandate,
      usage: usage.usage.toFixed(),
      today_usage: usage.todayUsage.toFixed(),
      remaining: remaining.toFixed(),
      reservations: reservations.rows,
    };
  }

  async revoke(input: {
    tenantId: string;
    actor: AuthenticatedPrincipal;
    mandateId: string;
    correlationId?: string;
  }): Promise<MandateRow> {
    if (input.actor.type !== "user") {
      await recordRefusal(this.db, {
        tenantId: input.tenantId,
        principal: {
          type: input.actor.type,
          id: input.actor.id,
          role: String(input.actor.role),
        },
        operation: "mandate.revoke",
        reasons: ["agent_principal"],
        correlationId: input.correlationId,
        resource: { type: "mandate", id: input.mandateId },
      });
      throw new ForbiddenActionError();
    }
    try {
      return await transaction(async (tx) => {
        const result = await tx.query<MandateRow>(
          "SELECT * FROM mandates WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
          [input.mandateId, input.tenantId],
        );
        const mandate = result.rows[0];
        if (
          !mandate ||
          input.actor.id !== mandate.owner_user_id ||
          input.actor.role !== "buyer"
        ) {
          throw new NotFoundError("Mandate");
        }
        ownerOnly(input.actor, mandate.owner_user_id);
        if (mandate.status === "expired") {
          throw new ConflictError(
            "MANDATE_STATE_CONFLICT",
            "An expired Mandate cannot be revoked.",
          );
        }
        if (mandate.status === "revoked") return mandate;
        const updated = await tx.query<MandateRow>(
          `UPDATE mandates SET status = 'revoked', revoked_by = $2, revoked_at = now(), updated_at = now()
           WHERE id = $1 RETURNING *`,
          [mandate.id, input.actor.id],
        );
        await appendCommerceEvent(tx, {
          tenantId: input.tenantId,
          aggregateType: "mandate",
          aggregateId: mandate.id,
          eventType: "MANDATE_REVOKED",
          actorType: "user",
          actorId: input.actor.id,
          correlationId: input.correlationId,
          details: {},
        });
        return updated.rows[0];
      });
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ConflictError) {
        await recordRefusal(this.db, {
          tenantId: input.tenantId,
          principal: {
            type: input.actor.type,
            id: input.actor.id,
            role: String(input.actor.role),
          },
          operation: "mandate.revoke",
          reasons: [
            error instanceof NotFoundError
              ? "not_found_or_not_owner"
              : "mandate_expired",
          ],
          correlationId: input.correlationId,
          resource: { type: "mandate", id: input.mandateId },
        });
      }
      throw error;
    }
  }

  async suspendForWatchdog(input: {
    tenantId: string;
    mandateId: string;
    alertId: string;
    correlationId?: string;
  }): Promise<MandateRow | null> {
    return transaction(async (tx) => {
      const result = await tx.query<MandateRow>(
        "SELECT * FROM mandates WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [input.mandateId, input.tenantId],
      );
      const mandate = result.rows[0];
      if (!mandate || !["active", "exhausted"].includes(mandate.status))
        return mandate ?? null;
      const updated = await tx.query<MandateRow>(
        `UPDATE mandates SET status = 'suspended', suspended_at = now(),
           suspended_by_alert_id = $2, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [mandate.id, input.alertId],
      );
      await appendCommerceEvent(tx, {
        tenantId: input.tenantId,
        aggregateType: "mandate",
        aggregateId: mandate.id,
        eventType: "MANDATE_SUSPENDED",
        actorType: "system",
        actorId: NIL_UUID,
        correlationId: input.correlationId,
        details: { alert_id: input.alertId },
      });
      return updated.rows[0];
    });
  }

  async liftSuspension(input: {
    tenantId: string;
    actor: AuthenticatedPrincipal;
    mandateId: string;
    reason: string;
    correlationId?: string;
    now?: Date;
  }): Promise<MandateRow> {
    if (input.actor.type !== "user") {
      await recordRefusal(this.db, {
        tenantId: input.tenantId,
        principal: {
          type: input.actor.type,
          id: input.actor.id,
          role: String(input.actor.role),
        },
        operation: "mandate.lift_suspension",
        reasons: ["agent_principal"],
        correlationId: input.correlationId,
        resource: { type: "mandate", id: input.mandateId },
      });
      throw new ForbiddenActionError();
    }
    if (
      typeof input.reason !== "string" ||
      input.reason.trim().length < 1 ||
      input.reason.trim().length > 500
    ) {
      throw new ValidationError("reason must be 1 to 500 characters.", {
        fields: ["reason"],
      });
    }
    return transaction(async (tx) => {
      const result = await tx.query<MandateRow>(
        "SELECT * FROM mandates WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [input.mandateId, input.tenantId],
      );
      const mandate = result.rows[0];
      if (
        !mandate ||
        (!isAdmin(input.actor) && mandate.owner_user_id !== input.actor.id)
      ) {
        throw new NotFoundError("Mandate");
      }
      if (mandate.status !== "suspended") {
        return mandate;
      }
      const usage = await getMandateUsage(tx, mandate.id, input.now);
      const now = input.now ?? new Date();
      const status =
        new Date(mandate.expires_at) <= now
          ? "expired"
          : usage.usage.gte(mandate.total_cap)
            ? "exhausted"
            : "active";
      const updated = await tx.query<MandateRow>(
        `UPDATE mandates SET status = $2, suspension_lifted_by = $3,
           suspension_lifted_at = $4, suspension_lift_reason = $5, updated_at = $4
         WHERE id = $1 RETURNING *`,
        [
          mandate.id,
          status,
          input.actor.id,
          now.toISOString(),
          input.reason.trim(),
        ],
      );
      await appendCommerceEvent(tx, {
        tenantId: input.tenantId,
        aggregateType: "mandate",
        aggregateId: mandate.id,
        eventType: "MANDATE_SUSPENSION_LIFTED",
        actorType: "user",
        actorId: input.actor.id,
        correlationId: input.correlationId,
        details: { target_status: status, reason: input.reason.trim() },
      });
      return updated.rows[0];
    });
  }

  async updateTerms(): Promise<never> {
    throw new MandateTermsImmutableError();
  }

  async sweep(
    now = new Date(),
  ): Promise<{ expired: number; reactivated: number }> {
    const expired = await this.db.query<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM mandates WHERE status IN ('active','exhausted','suspended')
        AND expires_at <= $1 ORDER BY expires_at LIMIT 500`,
      [now.toISOString()],
    );
    let expiredCount = 0;
    for (const row of expired.rows) {
      await transaction(async (tx) => {
        const locked = await tx.query<MandateRow>(
          "SELECT * FROM mandates WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
          [row.id, row.tenant_id],
        );
        if (
          !locked.rows[0] ||
          locked.rows[0].status === "revoked" ||
          new Date(locked.rows[0].expires_at) > now
        )
          return;
        const updated = await tx.query(
          "UPDATE mandates SET status = 'expired', updated_at = $2 WHERE id = $1 RETURNING id",
          [row.id, now.toISOString()],
        );
        if (updated.rowCount) {
          await appendCommerceEvent(tx, {
            tenantId: row.tenant_id,
            aggregateType: "mandate",
            aggregateId: row.id,
            eventType: "MANDATE_EXPIRED",
            actorType: "system",
            actorId: NIL_UUID,
            details: {},
          });
          expiredCount++;
        }
      });
    }
    const candidates = await this.db.query<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM mandates WHERE status = 'exhausted' AND expires_at > $1
       ORDER BY id LIMIT 500`,
      [now.toISOString()],
    );
    let reactivated = 0;
    for (const row of candidates.rows) {
      await transaction(async (tx) => {
        const locked = await tx.query<MandateRow>(
          "SELECT * FROM mandates WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
          [row.id, row.tenant_id],
        );
        const mandate = locked.rows[0];
        if (!mandate || mandate.status !== "exhausted") return;
        const usage = await getMandateUsage(tx, mandate.id, now);
        if (usage.usage.gte(mandate.total_cap)) return;
        await tx.query(
          "UPDATE mandates SET status = 'active', updated_at = $2 WHERE id = $1",
          [mandate.id, now.toISOString()],
        );
        await appendCommerceEvent(tx, {
          tenantId: row.tenant_id,
          aggregateType: "mandate",
          aggregateId: row.id,
          eventType: "MANDATE_REACTIVATED",
          actorType: "system",
          actorId: NIL_UUID,
          details: { reactivated: true },
        });
        reactivated++;
      });
    }
    return { expired: expiredCount, reactivated };
  }
}
