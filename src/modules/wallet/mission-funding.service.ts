/**
 * Mission funding state (Requirements 7.1-7.5, 7.9, 7.10, 7.13, 7.14, 7.20, 7.21, 8.1, 8.2).
 *
 * `recomputeMissionFunding` runs inside the caller's transaction after every reserve, release,
 * charge, capture and refund. It reads server state only, applies the pure state function in
 * wallet-math.ts, persists `mission_funding`, and writes low_balance, depleted and topped_up
 * notifications in the same transaction. It moves no money and takes no caller-supplied amount.
 */
import { Decimal } from "decimal.js";
import type { DbClient } from "../../db/connection.js";
import {
  formatMoney,
  missionFundingState,
  type MissionFundingStateName,
} from "./wallet-math.js";
import { walletLowBalancePct } from "./wallet-config.js";
import { getBalances, getOrCreateWallet } from "./wallet.service.js";
import {
  notifyInTx,
  resolveLowBalance,
  updateDepletionShortfall,
} from "./notification.service.js";

export interface MissionFundingSnapshot {
  missionId: string;
  walletId: string;
  state: MissionFundingStateName;
  previousState: MissionFundingStateName | null;
  shortfall: string;
  funding: string;
}

/**
 * Recompute and persist the funding state of one mission. Returns null when the mission has no
 * resolvable Owner (nothing to fund it from).
 */
export async function recomputeMissionFunding(
  tx: DbClient,
  missionId: string,
): Promise<MissionFundingSnapshot | null> {
  const m = await tx.query<any>(
    `SELECT m.id, m.tenant_id, m.budget, m.currency, m.status, a.owner_user_id
       FROM missions m LEFT JOIN agents a ON a.id = m.buyer_id
      WHERE m.id = $1`,
    [missionId],
  );
  const mission = m.rows[0];
  if (!mission || !mission.owner_user_id) return null;
  const tenantId: string = mission.tenant_id;
  const currency = String(mission.currency).toUpperCase();

  // Wallet: the one already tied to the mission, else the Owner's wallet for its currency.
  let existing = await tx.query<any>(
    `SELECT * FROM mission_funding WHERE mission_id = $1 FOR UPDATE`,
    [missionId],
  );
  let walletId: string;
  if (existing.rows[0]) {
    walletId = existing.rows[0].wallet_id;
  } else {
    const w = await getOrCreateWallet(tx, {
      tenantId,
      ownerUserId: mission.owner_user_id,
      currency,
    });
    walletId = w.id;
    await tx.query(
      `INSERT INTO mission_funding (tenant_id, mission_id, wallet_id, owner_user_id, state)
       VALUES ($1, $2, $3, $4, 'active') ON CONFLICT (mission_id) DO NOTHING`,
      [tenantId, missionId, walletId, mission.owner_user_id],
    );
    existing = await tx.query<any>(
      `SELECT * FROM mission_funding WHERE mission_id = $1 FOR UPDATE`,
      [missionId],
    );
  }
  const row = existing.rows[0];
  const previous = row.state as MissionFundingStateName;

  // Same lock order as reserve and charge: wallet, then the funding row (already held; harmless).
  await tx.query(`SELECT id FROM wallets WHERE id = $1 FOR UPDATE`, [walletId]);
  const balances = await getBalances(tx, walletId);

  const sums = await tx.query<{ charges: string; reserved: string }>(
    `SELECT COALESCE((SELECT SUM(amount) FROM wallet_charges WHERE mission_id = $1), 0)::text AS charges,
            COALESCE((SELECT SUM(amount) FROM wallet_reservations
                       WHERE mission_id = $1 AND status = 'active'), 0)::text AS reserved`,
    [missionId],
  );
  const decision = await tx.query<{ id: string; decision: string }>(
    `SELECT id, decision FROM remainder_decisions WHERE mission_id = $1`,
    [missionId],
  );
  let decisionFinal = false;
  if (decision.rows[0]) {
    if (decision.rows[0].decision === "keep") decisionFinal = true;
    else {
      const open = await tx.query<{ open: number; total: number }>(
        `SELECT count(*) FILTER (WHERE i.status <> 'completed')::int AS open, count(*)::int AS total
           FROM wallet_refund_items i JOIN wallet_refunds r ON r.id = i.refund_id
          WHERE r.decision_id = $1`,
        [decision.rows[0].id],
      );
      decisionFinal = open.rows[0].total > 0 && open.rows[0].open === 0;
    }
  }
  const lowOpen = await tx.query(
    `SELECT 1 FROM notifications
      WHERE mission_id = $1 AND kind = 'low_balance' AND resolved_at IS NULL LIMIT 1`,
    [missionId],
  );

  const budget = String(mission.budget);
  const completed = mission.status === "completed";
  // Remainder: unspent funding the Owner can still decide about.
  const preview = missionFundingState({
    budget,
    charges: sums.rows[0].charges,
    activeReservations: sums.rows[0].reserved,
    available: balances.available,
    completed: false,
    remainder: "0",
    unresolvedLowBalance: false,
    thresholdPct: walletLowBalancePct(),
  });
  const remainder = Decimal.max(new Decimal(preview.funding), 0).toFixed();

  const result = missionFundingState({
    budget,
    charges: sums.rows[0].charges,
    activeReservations: sums.rows[0].reserved,
    available: balances.available,
    completed,
    remainder,
    decisionFinal,
    unresolvedLowBalance: lowOpen.rows.length > 0,
    thresholdPct: walletLowBalancePct(),
  });

  // A refund decision stays awaiting_decision until every refund item is PayPal-confirmed
  // (R8.17, R8.19). Items in flight lower the Available_Balance, which would otherwise read as
  // "no remainder left" and close the mission early.
  if (
    completed &&
    !decisionFinal &&
    decision.rows[0]?.decision === "refund" &&
    result.state === "closed"
  ) {
    result.state = "awaiting_decision";
  }

  await tx.query(
    `UPDATE mission_funding
        SET state = $2, shortfall = $3, updated_at = now(),
            completed_at = CASE WHEN $4::boolean THEN COALESCE(completed_at, now()) ELSE completed_at END,
            closed_at = CASE WHEN $2 = 'closed' THEN COALESCE(closed_at, now()) ELSE closed_at END
      WHERE mission_id = $1`,
    [missionId, result.state, result.shortfall, completed],
  );

  const missionRef = {
    entityType: "mission",
    entityId: missionId,
    missionId,
  };
  const owner = { userId: mission.owner_user_id as string };

  if (result.resolveLowBalance) await resolveLowBalance(tx, missionId);

  if (result.requestLowBalance) {
    await notifyInTx(tx, {
      tenantId,
      kind: "low_balance",
      recipient: owner,
      title: "Mission budget running low",
      body: `Funding for this mission is down to ${formatMoney(result.funding)} ${currency}. Top up the wallet to keep accepting quotes.`,
      eventId: `low_balance:${missionId}:${Date.now()}`,
      ...missionRef,
    });
  }

  if (result.state === "depleted") {
    {
      const shortfall = new Decimal(result.shortfall);
      const existingNotes = await tx.query<{ id: string }>(
        `SELECT id FROM notifications WHERE mission_id = $1 AND kind = 'depleted'`,
        [missionId],
      );
      if (existingNotes.rows.length) {
        // Same notification, new shortfall: update in place, never a second row (R7.20, R7.21).
        // A zero shortfall (budget used up, wallet still funded) has no amount to rewrite.
        if (shortfall.gt(0)) {
          for (const n of existingNotes.rows) {
            await updateDepletionShortfall(
              tx,
              n.id,
              result.shortfall,
              currency,
            );
          }
        }
      } else {
        const text = {
          title: "Mission out of funds",
          body: `This mission is out of funds. Shortfall: ${formatMoney(result.shortfall)} ${currency}. Top up the wallet to continue.`,
        };
        const eventId = `depleted:${missionId}`;
        await notifyInTx(tx, {
          tenantId,
          kind: "depleted",
          recipient: owner,
          eventId,
          ...text,
          ...missionRef,
        });
        await notifyInTx(tx, {
          tenantId,
          kind: "depleted",
          recipient: { admins: true },
          eventId,
          ...text,
          ...missionRef,
        });
      }
    }
  } else if (previous === "depleted" && result.state === "active") {
    await notifyInTx(tx, {
      tenantId,
      kind: "topped_up",
      recipient: owner,
      title: "Mission funded again",
      body: `This mission has ${formatMoney(result.funding)} ${currency} available again and can accept quotes.`,
      eventId: `topped_up:${missionId}:${Date.now()}`,
      ...missionRef,
    });
  }

  return {
    missionId,
    walletId,
    state: result.state,
    previousState: previous,
    shortfall: result.shortfall,
    funding: result.funding,
  };
}

/**
 * Recompute every mission that draws on a wallet and is not closed. Used where a wallet-wide
 * event (deposit capture, refund) can change reachable funding for several missions.
 */
export async function recomputeWalletMissions(
  tx: DbClient,
  walletId: string,
  extraMissionId?: string | null,
): Promise<MissionFundingSnapshot[]> {
  const r = await tx.query<{ mission_id: string }>(
    `SELECT mission_id FROM mission_funding WHERE wallet_id = $1 AND state <> 'closed'
      ORDER BY created_at, mission_id`,
    [walletId],
  );
  const ids = r.rows.map((x) => x.mission_id);
  if (extraMissionId && !ids.includes(extraMissionId)) ids.push(extraMissionId);
  const out: MissionFundingSnapshot[] = [];
  for (const id of ids) {
    const s = await recomputeMissionFunding(tx, id);
    if (s) out.push(s);
  }
  return out;
}
