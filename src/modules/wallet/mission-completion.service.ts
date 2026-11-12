/**
 * Mission completion and the mission wallet view (Requirements 7.4, 7.6-7.8, 8.1, 8.2, 15.2).
 *
 * `completeMission` is the ONLY writer of `missions.status = 'completed'`. It runs in one
 * transaction: lock the mission, close still-open agreements and release their Reservations,
 * mark the mission completed, then let `recomputeMissionFunding` choose `awaiting_decision`
 * (Remainder above zero) or `closed`. It moves no money and takes no amount, currency or payee
 * from the caller. Callers are the Owner (route) or the system (the `wallet_mission_completion`
 * job); an agent never reaches it.
 */
import { transaction, type DbClient } from "../../db/connection.js";
import {
  ConflictError,
  NotFoundError,
  StoatError,
} from "../../common/errors.js";
import { getFundingMode } from "./funding-mode.js";
import { cancelOpenAgreementsAndRelease } from "./reservation.service.js";
import {
  recomputeMissionFunding,
  type MissionFundingSnapshot,
} from "./mission-funding.service.js";
import { appendWalletEvent } from "./wallet-events.js";
import { notifyInTx, sanitizeNotificationText } from "./notification.service.js";
import { ResultsService } from "../results/results.service.js";
import { archiveMissionResults } from "../missions/mission-results.service.js";
import { configuredEnvironment, getBalances } from "./wallet.service.js";
import {
  floorAtZero,
  formatMoney,
  missionFundingState,
} from "./wallet-math.js";
import { walletLowBalancePct } from "./wallet-config.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export interface MissionWalletView {
  mission_id: string;
  title: string;
  mission_status: string;
  currency: string;
  /** Mission_Budget. */
  budget: string;
  /** Available_Balance of the Owner's wallet in the mission currency. */
  available: string;
  /** max(0, budget - available). */
  shortfall: string;
  reserved: string;
  charged: string;
  /** Reachable funding, floored at zero. */
  unreserved_funding: string;
  state: "active" | "depleted" | "awaiting_decision" | "closed";
}

export type CompleteActor =
  | { type: "owner"; userId: string }
  | { type: "system" };

/** True when an agreement still needs the mission open (same rule as the cancel step). */
export const LIVE_AGREEMENT_SQL = `(a.status IN ('accepted', 'revision_requested', 'needs_review')
   OR (a.status = 'rejected' AND EXISTS (
         SELECT 1 FROM wallet_reservations r WHERE r.agreement_id = a.id AND r.status = 'active')))`;

/**
 * Short, notification-safe summary of what was delivered on a mission: counts only (no
 * provider-written text, which is untrusted). `named` includes mission and provider names;
 * `plain` omits them in case they cannot be used in a notification.
 */
export async function missionResultsText(
  db: DbClient,
  tenantId: string,
  missionId: string,
): Promise<{ named: string; plain: string }> {
  const ags = await db.query<{ id: string; title: string }>(
    `SELECT a.id, m.title FROM agreements a JOIN missions m ON m.id = a.mission_id
      WHERE a.mission_id = $1 AND a.tenant_id = $2 AND a.status = 'verified'
      ORDER BY a.accepted_at, a.id`,
    [missionId, tenantId],
  );
  if (ags.rows.length === 0) {
    return {
      named: "This mission is complete. No delivery was verified, so nothing was charged for unfinished work.",
      plain: "This mission is complete. No delivery was verified, so nothing was charged for unfinished work.",
    };
  }
  const svc = new ResultsService(db);
  const named: string[] = [];
  const plain: string[] = [];
  for (const a of ags.rows) {
    const r = await svc.forAgreement(tenantId, a.id).catch(() => null);
    const findings = r?.result?.findings ?? [];
    const bySev = ["critical", "high", "medium", "low"]
      .map((s) => [s, findings.filter((f: any) => f.severity === s).length] as const)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${s}`);
    const what = !r?.result
      ? "delivered verified work"
      : findings.length === 0
        ? "verified the work and found no defects"
        : `verified the work with ${findings.length} finding${findings.length === 1 ? "" : "s"} (${bySev.join(", ")})`;
    named.push(`${r?.provider?.name ?? "The provider"} ${what}.`);
    plain.push(`The provider ${what}.`);
  }
  const missionTitle = ags.rows[0].title;
  return {
    named: `Mission "${missionTitle}" is complete. ${named.join(" ")}`,
    plain: `This mission is complete. ${plain.join(" ")}`,
  };
}

/**
 * Queue completion right away (in the caller's transaction) instead of waiting for the sweep.
 * Idempotent: at most one queued or running job per mission. The job re-checks eligibility.
 */
export async function enqueueMissionCompletionJob(
  tx: DbClient,
  tenantId: string,
  missionId: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO jobs (tenant_id, type, payload, status, priority)
     SELECT $1, 'wallet_mission_completion', jsonb_build_object('mission_id', $2::text), 'queued', 3
      WHERE NOT EXISTS (
        SELECT 1 FROM jobs j
         WHERE j.type = 'wallet_mission_completion'
           AND j.status IN ('queued', 'running')
           AND j.payload->>'mission_id' = $2::text)`,
    [tenantId, missionId],
  );
}

/**
 * Read model for one mission. Every number is derived from server state; the persisted
 * `mission_funding.state` wins when present.
 */
export async function getMissionWalletView(
  db: DbClient,
  p: { tenantId: string; missionId: string },
): Promise<(MissionWalletView & { owner_user_id: string | null }) | null> {
  const m = await db.query<any>(
    `SELECT m.id, m.title, m.budget, m.currency, m.status, a.owner_user_id
       FROM missions m LEFT JOIN agents a ON a.id = m.buyer_id
      WHERE m.id = $1 AND m.tenant_id = $2`,
    [p.missionId, p.tenantId],
  );
  const mission = m.rows[0];
  if (!mission) return null;
  const currency = String(mission.currency).toUpperCase();

  // Independent reads, run together (no transaction, no writes).
  const [available, sums, mf] = await Promise.all([
    (async () => {
      if (!mission.owner_user_id) return "0";
      const w = await db.query<{ id: string }>(
        `SELECT id FROM wallets
          WHERE tenant_id = $1 AND owner_user_id = $2 AND currency = $3 AND paypal_environment = $4`,
        [p.tenantId, mission.owner_user_id, currency, configuredEnvironment()],
      );
      return w.rows[0] ? (await getBalances(db, w.rows[0].id)).available : "0";
    })(),
    db.query<{ charges: string; reserved: string }>(
      `SELECT COALESCE((SELECT SUM(amount) FROM wallet_charges WHERE mission_id = $1), 0)::text AS charges,
              COALESCE((SELECT SUM(amount) FROM wallet_reservations
                         WHERE mission_id = $1 AND status = 'active'), 0)::text AS reserved`,
      [p.missionId],
    ),
    db.query<{ state: MissionWalletView["state"] }>(
      `SELECT state FROM mission_funding WHERE mission_id = $1`,
      [p.missionId],
    ),
  ]);
  const computed = missionFundingState({
    budget: String(mission.budget),
    charges: sums.rows[0].charges,
    activeReservations: sums.rows[0].reserved,
    available,
    completed: mission.status === "completed",
    remainder: "0",
    unresolvedLowBalance: false,
    thresholdPct: walletLowBalancePct(),
  });
  return {
    mission_id: mission.id,
    owner_user_id: mission.owner_user_id ?? null,
    title: mission.title,
    mission_status: mission.status,
    currency,
    budget: formatMoney(String(mission.budget)),
    available: formatMoney(available),
    shortfall: formatMoney(computed.shortfall),
    reserved: formatMoney(sums.rows[0].reserved),
    charged: formatMoney(sums.rows[0].charges),
    unreserved_funding: formatMoney(floorAtZero(computed.funding)),
    state: mf.rows[0]?.state ?? computed.state,
  };
}

/**
 * Complete a mission. Idempotent: a mission that is already completed returns its current
 * funding snapshot and sends nothing.
 */
export async function completeMission(
  db: DbClient,
  p: {
    tenantId: string;
    missionId: string;
    actor: CompleteActor;
    correlationId?: string;
  },
): Promise<MissionFundingSnapshot> {
  void db;
  return transaction(async (tx) => {
    const m = await tx.query<any>(
      `SELECT m.id, m.status, m.currency, a.owner_user_id
         FROM missions m LEFT JOIN agents a ON a.id = m.buyer_id
        WHERE m.id = $1 AND m.tenant_id = $2 FOR UPDATE OF m`,
      [p.missionId, p.tenantId],
    );
    const mission = m.rows[0];
    if (!mission) throw new NotFoundError("Mission", p.missionId);
    if (!mission.owner_user_id) {
      throw new ConflictError(
        "WALLET_OWNER_UNRESOLVED",
        "The mission has no Owner whose wallet funds it.",
      );
    }
    if (p.actor.type === "owner" && p.actor.userId !== mission.owner_user_id) {
      throw new StoatError(
        "WALLET_NOT_OWNED",
        "This mission belongs to another user.",
        403,
      );
    }
    if ((await getFundingMode(tx, p.tenantId)) !== "wallet") {
      throw new StoatError(
        "WALLET_NOT_ENABLED",
        "The wallet is not enabled for this workspace.",
        409,
      );
    }

    const already = mission.status === "completed";
    if (!already) {
      await cancelOpenAgreementsAndRelease(tx, p.missionId, {
        correlationId: p.correlationId,
      });
      await tx.query(
        `UPDATE missions SET status = 'completed', updated_at = now() WHERE id = $1`,
        [p.missionId],
      );
    }
    const snap = await recomputeMissionFunding(tx, p.missionId);
    if (!snap) throw new NotFoundError("Mission", p.missionId);
    if (already) return snap;
    // Keep what was delivered for future reference (append-only), atomically with completion.
    await archiveMissionResults(tx, p.tenantId, p.missionId);

    const charged = (
      await tx.query<{ s: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS s FROM wallet_charges WHERE mission_id = $1`,
        [p.missionId],
      )
    ).rows[0].s;
    const currency = String(mission.currency).toUpperCase();
    const remainder = floorAtZero(snap.funding);

    await appendWalletEvent(tx, {
      tenantId: p.tenantId,
      aggregateType: "mission",
      aggregateId: p.missionId,
      eventType: "MISSION_COMPLETED",
      actorRole: p.actor.type === "owner" ? "owner" : "system",
      actorId: p.actor.type === "owner" ? p.actor.userId : NIL_UUID,
      correlationId: p.correlationId,
      amount: remainder,
      currency,
      details: {
        funding_state: snap.state,
        charged: formatMoney(charged),
        wallet_id: snap.walletId,
      },
      idempotencyKey: `mission-completed:${p.missionId}`,
    });

    const awaiting = snap.state === "awaiting_decision";
    const spend = `Final spend: ${formatMoney(charged)} ${currency} from your wallet.`;
    const next = awaiting
      ? ` ${formatMoney(remainder)} ${currency} of the mission budget is unused. Choose refund or keep.`
      : "";
    const results = await missionResultsText(tx, p.tenantId, p.missionId);
    const title = awaiting ? "Mission complete: results ready, remainder to decide" : "Mission complete: results ready";
    // Provider and mission names are user-entered; if they trip the text rules, drop them.
    const safeBody = (withNames: boolean) => {
      const body = `${withNames ? results.named : results.plain} ${spend}${next} Open the mission to read the full report.`.slice(0, 1000);
      try { return sanitizeNotificationText({ title, body }).body; } catch { return null; }
    };
    const body =
      safeBody(true) ??
      safeBody(false) ??
      `This mission is complete. ${spend}${next}`;
    await notifyInTx(tx, {
      tenantId: p.tenantId,
      kind: "mission_completed",
      recipient: { userId: mission.owner_user_id },
      title,
      body,
      entityType: "mission",
      entityId: p.missionId,
      missionId: p.missionId,
      eventId: `mission_completed:${p.missionId}`,
    });
    return snap;
  });
}

/**
 * Missions a worker may complete: open, wallet mode, at least one agreement, none live.
 */
export async function findCompletableMissions(
  db: DbClient,
  limit = 50,
): Promise<{ id: string; tenant_id: string }[]> {
  const r = await db.query<{ id: string; tenant_id: string }>(
    `SELECT m.id, m.tenant_id
       FROM missions m
       JOIN tenants t ON t.id = m.tenant_id
      WHERE m.status = 'created'
        AND COALESCE(t.settings->>'funding_mode', 'direct') = 'wallet'
        AND EXISTS (SELECT 1 FROM agreements a WHERE a.mission_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM agreements a WHERE a.mission_id = m.id AND ${LIVE_AGREEMENT_SQL})
      ORDER BY m.created_at, m.id
      LIMIT $1`,
    [limit],
  );
  return r.rows;
}

/** Queue one `wallet_mission_completion` job per completable mission that has none pending. */
export async function enqueueMissionCompletionJobs(
  db: DbClient,
): Promise<number> {
  const candidates = await findCompletableMissions(db);
  let queued = 0;
  for (const c of candidates) {
    const ins = await db.query(
      `INSERT INTO jobs (tenant_id, type, payload, status, priority)
       SELECT $1, 'wallet_mission_completion', jsonb_build_object('mission_id', $2::text), 'queued', 3
        WHERE NOT EXISTS (
          SELECT 1 FROM jobs j
           WHERE j.type = 'wallet_mission_completion'
             AND j.status IN ('queued', 'running')
             AND j.payload->>'mission_id' = $2::text)
       RETURNING id`,
      [c.tenant_id, c.id],
    );
    queued += ins.rows.length;
  }
  return queued;
}

/** `wallet_mission_completion` job handler: re-checks eligibility, then completes as the system. */
export async function handleMissionCompletionJob(
  db: DbClient,
  payload: { mission_id?: string },
): Promise<string> {
  const id = payload?.mission_id;
  if (!id) return "no mission_id";
  const eligible = (await findCompletableMissions(db, 1000)).find(
    (c) => c.id === id,
  );
  if (!eligible)
    return "mission not completable (open work remains or already completed)";
  const snap = await completeMission(db, {
    tenantId: eligible.tenant_id,
    missionId: id,
    actor: { type: "system" },
  });
  return `mission completed: ${snap.state}`;
}
