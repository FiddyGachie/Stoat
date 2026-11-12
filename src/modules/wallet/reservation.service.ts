/**
 * Wallet Reservations (Requirements 4.2, 4.9, 5.1-5.12, 7.3).
 *
 * A Reservation is a Stoat bookkeeping hold on an already captured wallet balance. It posts no
 * journal line. Deterministic code only: the Owner, wallet, price and currency come from server
 * state (mission, agreement); no caller supplies a wallet, amount, currency or payee
 * (AGENTS.md section 8, Money_Boundary).
 *
 * `reserveInTx` runs inside the acceptance transaction under the wallet row lock, so concurrent
 * acceptances on one wallet serialize and can never overspend it.
 */
import { transaction, type DbClient } from "../../db/connection.js";
import {
  BudgetExceededError,
  ConflictError,
  NotFoundError,
} from "../../common/errors.js";
import { Decimal } from "decimal.js";
import {
  assertWalletUsable,
  getBalances,
  getOrCreateWallet,
} from "./wallet.service.js";
import { formatMoney, parseMoney } from "./wallet-math.js";
import { walletCurrencies } from "./wallet-config.js";
import { appendWalletEvent } from "./wallet-events.js";
import { notifyInTx } from "./notification.service.js";
import { recomputeMissionFunding } from "./mission-funding.service.js";
import { reactivateIfUnderCap } from "../mandates/mandate-acceptance.js";

export interface ReservationRow {
  id: string;
  tenant_id: string;
  wallet_id: string;
  mission_id: string;
  agreement_id: string;
  amount: string;
  currency: string;
  status: "active" | "charged" | "released";
  release_reason: string | null;
  created_at: Date | string;
  closed_at: Date | string | null;
}

const norm = (r: any): ReservationRow => ({
  ...r,
  amount: formatMoney(String(r.amount)),
});

/** Mission funding states that refuse new Reservations. */
const CLOSED_FUNDING_STATES = ["depleted", "awaiting_decision", "closed"];

export interface ReserveInput {
  tenantId: string;
  agreementId: string;
  /** Acting buyer agent (event actor only; never a source of wallet, amount or currency). */
  actorId?: string;
  correlationId?: string;
  mandateId?: string;
}

export interface ReserveResult {
  reservation: ReservationRow;
  /** False when the agreement already had a Reservation (idempotent repeat). */
  created: boolean;
}

/**
 * Reserve the agreement price against the mission Owner's wallet. Throws (so the caller's
 * transaction rolls back) with MISSION_DEPLETED, WALLET_BLOCKED, WALLET_INSUFFICIENT_FUNDS,
 * BUDGET_EXCEEDED, or a validation conflict. Posts no journal line.
 */
export async function reserveInTx(
  tx: DbClient,
  input: ReserveInput,
): Promise<ReserveResult> {
  const ag = await tx.query(
    `SELECT id, tenant_id, mission_id, price, currency FROM agreements
      WHERE id = $1 AND tenant_id = $2`,
    [input.agreementId, input.tenantId],
  );
  if (!ag.rows[0]) throw new NotFoundError("Agreement", input.agreementId);
  const agreement = ag.rows[0];

  // Idempotent: one Reservation per agreement.
  const existing = await tx.query(
    `SELECT * FROM wallet_reservations WHERE agreement_id = $1`,
    [agreement.id],
  );
  if (existing.rows[0])
    return { reservation: norm(existing.rows[0]), created: false };

  // Mission and Owner from server state only.
  const m = await tx.query(
    `SELECT m.id, m.budget, m.currency, m.status, a.owner_user_id
       FROM missions m LEFT JOIN agents a ON a.id = m.buyer_id
      WHERE m.id = $1 AND m.tenant_id = $2`,
    [agreement.mission_id, input.tenantId],
  );
  const mission = m.rows[0];
  if (!mission) throw new NotFoundError("Mission", agreement.mission_id);
  if (!mission.owner_user_id) {
    throw new ConflictError(
      "WALLET_OWNER_UNRESOLVED",
      "The mission has no Owner whose wallet can fund it.",
    );
  }

  if (mission.status !== "created") {
    throw new ConflictError(
      "MISSION_NOT_OPEN",
      "The mission is not open, so new reservations are refused.",
      { mission_id: mission.id, status: mission.status },
    );
  }
  const mf = await tx.query<{ state: string }>(
    `SELECT state FROM mission_funding WHERE mission_id = $1`,
    [mission.id],
  );
  if (mf.rows[0] && CLOSED_FUNDING_STATES.includes(mf.rows[0].state)) {
    throw new ConflictError(
      "MISSION_DEPLETED",
      "The mission is out of funds. Top up the wallet before accepting another quote.",
      { mission_id: mission.id, state: mf.rows[0].state },
    );
  }

  // Price and currency come from the agreement; they must be valid and consistent.
  const price = parseMoney(String(agreement.price), { positive: true });
  const currency = String(agreement.currency).toUpperCase();
  if (
    !price.ok ||
    !walletCurrencies().includes(currency) ||
    currency !== String(mission.currency).toUpperCase()
  ) {
    throw new ConflictError(
      "RESERVATION_INVALID",
      "The agreement price or currency cannot be reserved from a wallet.",
      { agreement_id: agreement.id },
    );
  }

  // Resolve and lock the wallet (R4.9). Created empty when the Owner never deposited.
  const found = await getOrCreateWallet(tx, {
    tenantId: input.tenantId,
    ownerUserId: mission.owner_user_id,
    currency,
  });
  await tx.query(`SELECT id FROM wallets WHERE id = $1 FOR UPDATE`, [found.id]);
  await assertWalletUsable(tx, found.id);

  // Mission budget: reservations + charges + price must not exceed Mission_Budget (R5.4).
  const committed = await tx.query<{ s: string }>(
    `SELECT (
        COALESCE((SELECT SUM(amount) FROM wallet_reservations
                   WHERE mission_id = $1 AND status = 'active'), 0)
      + COALESCE((SELECT SUM(amount) FROM wallet_charges WHERE mission_id = $1), 0)
     )::text AS s`,
    [mission.id],
  );
  const committedD = new Decimal(committed.rows[0].s);
  if (committedD.plus(price.decimal).gt(new Decimal(String(mission.budget)))) {
    throw new BudgetExceededError(
      "Reservations, charges and this price would exceed the Mission_Budget.",
      {
        mission_id: mission.id,
        mission_budget: formatMoney(String(mission.budget)),
        committed: formatMoney(committedD),
        price: price.value,
      },
    );
  }

  // Funds: Available_Balance must cover the price (R5.2, R5.3).
  const balances = await getBalances(tx, found.id);
  const available = new Decimal(balances.available);
  if (available.lt(price.decimal)) {
    const shortfall = formatMoney(price.decimal.minus(available));
    throw new ConflictError(
      "WALLET_INSUFFICIENT_FUNDS",
      "The wallet does not have enough available funds for this price.",
      {
        wallet_id: found.id,
        mission_id: mission.id,
        owner_user_id: mission.owner_user_id,
        available: balances.available,
        price: price.value,
        shortfall,
        currency,
      },
    );
  }

  const ins = await tx.query(
    `INSERT INTO wallet_reservations
       (id, tenant_id, wallet_id, mission_id, agreement_id, amount, currency, status, mandate_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'active', $7)
     RETURNING *`,
    [input.tenantId, found.id, mission.id, agreement.id, price.value, currency, input.mandateId ?? null],
  );
  const reservation = norm(ins.rows[0]);

  await appendWalletEvent(tx, {
    tenantId: input.tenantId,
    aggregateType: "wallet",
    aggregateId: found.id,
    eventType: "WALLET_RESERVATION_CREATED",
    actorRole: input.actorId ? "agent" : "system",
    actorId: input.actorId ?? "00000000-0000-0000-0000-000000000000",
    correlationId: input.correlationId,
    amount: price.value,
    currency,
    details: {
      reservation_id: reservation.id,
      agreement_id: agreement.id,
      mission_id: mission.id,
    },
    idempotencyKey: `wallet-reservation:${agreement.id}`,
  });
  await recomputeMissionFunding(tx, mission.id);

  return { reservation, created: true };
}

/**
 * After a refusal rolled the acceptance back, tell the Owner about the shortfall in a short
 * follow-up transaction (R5.3). Never throws: a notice failure must not mask the refusal.
 */
export async function notifyInsufficientFunds(
  tenantId: string,
  err: { code?: string; details?: any },
  quoteId: string,
): Promise<void> {
  if (err?.code !== "WALLET_INSUFFICIENT_FUNDS" || !err.details) return;
  const d = err.details;
  try {
    await transaction((tx) =>
      notifyInTx(tx, {
        tenantId,
        kind: "low_balance",
        recipient: { userId: d.owner_user_id },
        title: "Wallet balance too low for this quote",
        body: `Accepting the quote needs ${d.price} ${d.currency}, but only ${d.available} ${d.currency} is available. Short by ${d.shortfall} ${d.currency}.`,
        entityType: "mission",
        entityId: d.mission_id,
        missionId: d.mission_id,
        eventId: `low_balance:shortfall:${quoteId}`,
      }),
    );
  } catch {
    /* best effort */
  }
}

/**
 * Release an active Reservation. Idempotent: an already released or charged Reservation is
 * returned unchanged. Allowed on a blocked wallet. Returns null when the agreement never had one.
 */
export async function releaseReservationInTx(
  tx: DbClient,
  p: {
    tenantId: string;
    agreementId: string;
    reason: string;
    correlationId?: string;
  },
): Promise<ReservationRow | null> {
  const first = await tx.query(
    `SELECT * FROM wallet_reservations WHERE agreement_id = $1 AND tenant_id = $2`,
    [p.agreementId, p.tenantId],
  );
  if (!first.rows[0]) return null;
  if (first.rows[0].status !== "active") return norm(first.rows[0]);

  if (first.rows[0].mandate_id) {
    await tx.query(
      "SELECT id FROM mandates WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
      [first.rows[0].mandate_id, p.tenantId],
    );
  }
  // Lock order: mandate, wallet, then reservation.
  await tx.query(`SELECT id FROM wallets WHERE id = $1 FOR UPDATE`, [
    first.rows[0].wallet_id,
  ]);
  const cur = await tx.query(
    `SELECT * FROM wallet_reservations WHERE id = $1 FOR UPDATE`,
    [first.rows[0].id],
  );
  if (cur.rows[0].status !== "active") return norm(cur.rows[0]);

  const upd = await tx.query(
    `UPDATE wallet_reservations
        SET status = 'released', release_reason = $2, closed_at = now()
      WHERE id = $1 AND status = 'active' RETURNING *`,
    [cur.rows[0].id, p.reason],
  );
  const row = norm(upd.rows[0]);
  await appendWalletEvent(tx, {
    tenantId: p.tenantId,
    aggregateType: "wallet",
    aggregateId: row.wallet_id,
    eventType: "WALLET_RESERVATION_RELEASED",
    actorRole: "system",
    actorId: "00000000-0000-0000-0000-000000000000",
    correlationId: p.correlationId,
    amount: row.amount,
    currency: row.currency,
    details: {
      reservation_id: row.id,
      agreement_id: row.agreement_id,
      mission_id: row.mission_id,
      reason: p.reason,
    },
    idempotencyKey: `wallet-reservation-release:${row.id}`,
  });
  await recomputeMissionFunding(tx, row.mission_id);
  if (first.rows[0].mandate_id) {
    await reactivateIfUnderCap(tx, {
      tenantId: p.tenantId,
      mandateId: first.rows[0].mandate_id,
    });
  }
  return row;
}

/**
 * Close every still-open agreement of a mission as `cancelled` and release its active
 * Reservation (R6.7). Open means accepted, revision_requested or needs_review, plus a rejected
 * agreement whose Reservation is still active (a revisable rejection). Agreements that already
 * settled (verified) or exhausted their revisions keep their status. Idempotent; reusable by
 * mission completion (task 12.2). Returns the cancelled agreement IDs.
 */
export async function cancelOpenAgreementsAndRelease(
  tx: DbClient,
  missionId: string,
  opts: { correlationId?: string } = {},
): Promise<string[]> {
  const open = await tx.query<{ id: string; tenant_id: string }>(
    `SELECT a.id, a.tenant_id FROM agreements a
      WHERE a.mission_id = $1
        AND (a.status IN ('accepted', 'revision_requested', 'needs_review')
             OR (a.status = 'rejected' AND EXISTS (
                   SELECT 1 FROM wallet_reservations r
                    WHERE r.agreement_id = a.id AND r.status = 'active')))
      ORDER BY a.accepted_at, a.id
      FOR UPDATE OF a`,
    [missionId],
  );
  const cancelled: string[] = [];
  for (const row of open.rows) {
    await tx.query(
      `UPDATE agreements SET status = 'cancelled', updated_at = now() WHERE id = $1`,
      [row.id],
    );
    await releaseReservationInTx(tx, {
      tenantId: row.tenant_id,
      agreementId: row.id,
      reason: "mission_completed",
      correlationId: opts.correlationId,
    });
    cancelled.push(row.id);
  }
  return cancelled;
}

/** Release in its own transaction (used by delivery and mission completion paths). */
export function releaseReservation(p: {
  tenantId: string;
  agreementId: string;
  reason: string;
  correlationId?: string;
}): Promise<ReservationRow | null> {
  return transaction((tx) => releaseReservationInTx(tx, p));
}
