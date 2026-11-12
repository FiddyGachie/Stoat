/**
 * Mission management: edit / delete open missions, replay completed ones at half the last
 * spend, and the permanent results archive.
 *
 * Money rules: nothing here moves money. Edit never lowers a budget below what is already
 * reserved or charged. Delete is refused while work or a Reservation is live, so a reservation is
 * never discarded. Replay only creates a mission, requests a quote and runs the buyer agent's
 * negotiation (which respects the provider's floor and the new, halved budget); the person still
 * accepts. Only the mission's Owner (the user who owns its buyer agent) or a tenant Admin may act.
 */
import { Decimal } from "decimal.js";
import { transaction, type DbClient } from "../../db/connection.js";
import { ConflictError, NotFoundError, StoatError, ValidationError } from "../../common/errors.js";
import { toDecimalString, validateAmount } from "../../common/decimal.js";
import { EventsService } from "../events/events.service.js";
import { MissionsService } from "./missions.service.js";
import { QuotesService } from "../quotes/quotes.service.js";
import { NegotiationService } from "../negotiation/negotiation.service.js";
import { LIVE_AGREEMENT_SQL } from "../wallet/mission-completion.service.js";
import { recomputeMissionFunding } from "../wallet/mission-funding.service.js";
import { getFundingMode } from "../wallet/funding-mode.js";

export interface MissionActor {
  id: string;
  role?: string;
}

const isAdmin = (a: MissionActor) => a.role === "operator" || a.role === "supervisor";

async function loadOwned(
  db: DbClient,
  tenantId: string,
  missionId: string,
  actor: MissionActor,
  lock = false,
) {
  const r = await db.query<any>(
    `SELECT m.*, a.owner_user_id
       FROM missions m LEFT JOIN agents a ON a.id = m.buyer_id
      WHERE m.tenant_id = $1 AND m.id = $2 ${lock ? "FOR UPDATE OF m" : ""}`,
    [tenantId, missionId],
  );
  const m = r.rows[0];
  if (!m) throw new NotFoundError("Mission", missionId);
  if (!isAdmin(actor) && m.owner_user_id !== actor.id) {
    throw new StoatError("MISSION_NOT_OWNED", "Only the mission's owner or an Admin can change it.", 403);
  }
  return m;
}

/** Reserved + charged on the mission (wallet), and the policy reservation on the mission row. */
async function committedOn(db: DbClient, missionId: string): Promise<Decimal> {
  const r = await db.query<{ s: string }>(
    `SELECT (COALESCE((SELECT SUM(amount) FROM wallet_reservations WHERE mission_id = $1 AND status = 'active'), 0)
           + COALESCE((SELECT SUM(amount) FROM wallet_charges WHERE mission_id = $1), 0))::text AS s`,
    [missionId],
  );
  return new Decimal(r.rows[0].s);
}

export class MissionAdminService {
  constructor(private db: DbClient) {}

  // ── Edit / update ──────────────────────────────────────────────────────────
  async updateMission(p: {
    tenantId: string;
    missionId: string;
    actor: MissionActor;
    title?: unknown;
    brief?: unknown;
    budget?: unknown;
    correlationId?: string;
  }) {
    const changes: Record<string, string> = {};
    if (p.title !== undefined) {
      if (typeof p.title !== "string" || !p.title.trim() || p.title.trim().length > 200)
        throw new ValidationError("Title must be 1 to 200 characters.", { field: "title" });
      changes.title = p.title.trim();
    }
    if (p.brief !== undefined) {
      if (typeof p.brief !== "string" || !p.brief.trim() || p.brief.trim().length > 5000)
        throw new ValidationError("Brief must be 1 to 5000 characters.", { field: "brief" });
      changes.brief = p.brief.trim();
    }
    if (p.budget !== undefined) {
      if (typeof p.budget !== "string" && typeof p.budget !== "number")
        throw new ValidationError("Budget must be a positive decimal.", { field: "budget" });
      if (!validateAmount(String(p.budget)))
        throw new ValidationError("Budget must be a positive decimal.", { field: "budget" });
      changes.budget = toDecimalString(String(p.budget));
    }
    if (Object.keys(changes).length === 0)
      throw new ValidationError("Nothing to update. Send title, brief or budget.");

    return transaction(async (tx) => {
      const m = await loadOwned(tx, p.tenantId, p.missionId, p.actor, true);
      if (m.status !== "created") {
        throw new ConflictError("MISSION_NOT_EDITABLE", `This mission is '${m.status}'. Only open missions can be edited.`);
      }
      if (changes.budget) {
        const floor = Decimal.max(new Decimal(String(m.reserved_budget)), await committedOn(tx, m.id));
        if (new Decimal(changes.budget).lt(floor)) {
          throw new ConflictError(
            "BUDGET_BELOW_COMMITTED",
            `The budget cannot go below ${toDecimalString(floor)} ${m.currency}, which is already reserved or charged.`,
            { committed: toDecimalString(floor) },
          );
        }
      }
      const upd = await tx.query<any>(
        `UPDATE missions SET title = COALESCE($2, title), brief = COALESCE($3, brief),
                budget = COALESCE($4::numeric, budget), updated_at = now()
          WHERE id = $1
          RETURNING id, buyer_id, title, brief, budget, reserved_budget, currency, deadline, status, created_at, replay_of`,
        [m.id, changes.title ?? null, changes.brief ?? null, changes.budget ?? null],
      );
      await new EventsService(tx).appendEvent({
        tenantId: p.tenantId, aggregateType: "mission", aggregateId: m.id, eventType: "MISSION_UPDATED",
        actorType: "user", actorId: p.actor.id, correlationId: p.correlationId,
        amount: changes.budget, currency: changes.budget ? m.currency : undefined,
        payload: { changed: Object.keys(changes), previous_budget: toDecimalString(String(m.budget)) },
      });
      // A new budget changes how much of it is still fundable (low balance / depleted states).
      // Only for missions already tracked (something was reserved or charged); a fresh mission's
      // funding state is set up by the normal reserve flow, without a spurious "out of funds".
      if (changes.budget && (await getFundingMode(tx, p.tenantId)) === "wallet") {
        const tracked = await tx.query(`SELECT 1 FROM mission_funding WHERE mission_id = $1`, [m.id]);
        if (tracked.rows.length) await recomputeMissionFunding(tx, m.id);
      }
      const row = upd.rows[0];
      return { ...row, budget: String(row.budget), reserved_budget: String(row.reserved_budget) };
    });
  }

  // ── Delete (soft) ─────────────────────────────────────────────────────────
  async deleteMission(p: { tenantId: string; missionId: string; actor: MissionActor; correlationId?: string }) {
    return transaction(async (tx) => {
      const m = await loadOwned(tx, p.tenantId, p.missionId, p.actor, true);
      if (m.status === "deleted") return { id: m.id, status: "deleted", withdrawn_quotes: 0 };
      if (m.status !== "created") {
        throw new ConflictError("MISSION_NOT_DELETABLE", `This mission is '${m.status}'. Completed missions are kept; only open missions can be deleted.`);
      }
      const live = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM agreements a WHERE a.mission_id = $1 AND ${LIVE_AGREEMENT_SQL}`, [m.id]);
      if (live.rows[0].n > 0) {
        throw new ConflictError("MISSION_HAS_LIVE_WORK", "A provider is still working on this mission, so it cannot be deleted yet.");
      }
      const held = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM wallet_reservations WHERE mission_id = $1 AND status = 'active'`, [m.id]);
      if (held.rows[0].n > 0) {
        throw new ConflictError("MISSION_HAS_RESERVATION", "Funds are still reserved for this mission, so it cannot be deleted yet.");
      }
      const wq = await tx.query(
        `UPDATE quotes q SET status = 'withdrawn', updated_at = now()
           FROM quote_requests r
          WHERE q.quote_request_id = r.id AND r.mission_id = $1 AND q.status = 'offered'
          RETURNING q.id`,
        [m.id],
      );
      await tx.query(`UPDATE missions SET status = 'deleted', deleted_at = now(), updated_at = now() WHERE id = $1`, [m.id]);
      await new EventsService(tx).appendEvent({
        tenantId: p.tenantId, aggregateType: "mission", aggregateId: m.id, eventType: "MISSION_DELETED",
        actorType: "user", actorId: p.actor.id, correlationId: p.correlationId,
        payload: { withdrawn_quotes: wq.rows.length, title: m.title },
      });
      return { id: m.id, status: "deleted", withdrawn_quotes: wq.rows.length };
    });
  }

  // ── Replay at half the last spend ────────────────────────────────────────
  async replayMission(p: { tenantId: string; missionId: string; actor: MissionActor; correlationId?: string }) {
    const src = await loadOwned(this.db, p.tenantId, p.missionId, p.actor);
    if (src.status !== "completed") {
      throw new ConflictError("MISSION_NOT_COMPLETED", "Only completed missions can be replayed.");
    }
    const last = await this.db.query<any>(
      `SELECT a.id, a.price, q.service_id, COALESCE(r.requested_scope, '{}'::jsonb) AS requested_scope,
              COALESCE(r.quantity, 1) AS quantity
         FROM agreements a
         JOIN quotes q ON q.id = a.quote_id
         LEFT JOIN quote_requests r ON r.id = q.quote_request_id
        WHERE a.mission_id = $1 AND a.tenant_id = $2 AND a.status = 'verified'
        ORDER BY a.accepted_at DESC, a.id DESC LIMIT 1`,
      [src.id, p.tenantId],
    );
    const ag = last.rows[0];
    if (!ag) throw new ConflictError("MISSION_HAS_NO_RESULT", "This mission has no verified work to replay.");

    const spent = await this.db.query<{ s: string }>(
      `SELECT COALESCE(
          NULLIF((SELECT SUM(amount) FROM wallet_charges WHERE mission_id = $1), 0),
          NULLIF((SELECT SUM(amount) FROM obligations WHERE mission_id = $1), 0),
          $2::numeric)::text AS s`,
      [src.id, String(ag.price)],
    );
    const lastSpend = new Decimal(spent.rows[0].s);
    // Half, rounded down to cents, never below one cent.
    const half = Decimal.max(lastSpend.div(2).toDecimalPlaces(2, Decimal.ROUND_DOWN), new Decimal("0.01"));

    const missions = new MissionsService(this.db);
    const mission = await missions.createMission({
      tenantId: p.tenantId,
      buyerId: src.buyer_id,
      title: `${String(src.title).replace(/ \(replay\)$/, "")} (replay)`.slice(0, 200),
      brief: src.brief,
      budget: half.toFixed(2),
      currency: src.currency,
      correlationId: p.correlationId,
    });
    await this.db.query(`UPDATE missions SET replay_of = $2 WHERE id = $1`, [mission.id, src.id]);
    await new EventsService(this.db).appendEvent({
      tenantId: p.tenantId, aggregateType: "mission", aggregateId: mission.id, eventType: "MISSION_REPLAYED",
      actorType: "user", actorId: p.actor.id, correlationId: p.correlationId,
      amount: half.toFixed(2), currency: src.currency,
      payload: { replay_of: src.id, last_spend: toDecimalString(lastSpend), target_budget: half.toFixed(2) },
    });

    const quote = await new QuotesService(this.db).requestQuote({
      tenantId: p.tenantId,
      buyerId: src.buyer_id,
      missionId: mission.id,
      serviceId: ag.service_id,
      requestedScope: typeof ag.requested_scope === "string" ? JSON.parse(ag.requested_scope) : ag.requested_scope,
      quantity: String(ag.quantity),
      correlationId: p.correlationId,
    });

    // The buyer agent negotiates toward the halved budget. A model or provider refusal is not
    // an error for the replay: the mission and quote exist and the person decides.
    let negotiation: unknown = null;
    let negotiation_error: { code: string; message: string } | null = null;
    try {
      negotiation = await new NegotiationService(this.db).negotiate({
        tenantId: p.tenantId, missionId: mission.id, buyerAgentId: src.buyer_id,
      });
    } catch (e: any) {
      negotiation_error = { code: String(e?.code ?? "NEGOTIATION_FAILED"), message: String(e?.message ?? "Negotiation failed.").slice(0, 300) };
    }
    return {
      mission: { ...mission, replay_of: src.id },
      replay_of: src.id,
      last_spend: toDecimalString(lastSpend),
      target_budget: half.toFixed(2),
      quote,
      negotiation,
      negotiation_error,
    };
  }
}

