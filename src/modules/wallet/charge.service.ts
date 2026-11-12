/**
 * Wallet Charges (Requirements 6.1-6.5, 6.8-6.10, 6.13, 9.3).
 *
 * A Charge converts an agreement's active Reservation into spend when the obligation accrues.
 * The amount, currency, wallet and mission come only from the obligation, reservation and
 * agreement rows; nothing a caller supplies can set an amount, currency, payee or state
 * (AGENTS.md section 8). Runs inside the caller's transaction so any failure rolls back the
 * obligation, charge, journal and event together.
 */
import type { DbClient } from "../../db/connection.js";
import { ConflictError, NotFoundError } from "../../common/errors.js";
import { Decimal } from "decimal.js";
import { assertWalletUsable } from "./wallet.service.js";
import { formatMoney } from "./wallet-math.js";
import { appendWalletEvent } from "./wallet-events.js";
import { postJournal } from "./wallet-ledger.js";
import { recomputeMissionFunding } from "./mission-funding.service.js";

export interface ChargeRow {
  id: string;
  wallet_id: string;
  reservation_id: string;
  obligation_id: string;
  agreement_id: string;
  mission_id: string;
  amount: string;
  released_difference: string;
  currency: string;
  reason_code: string;
  journal_transaction_id: string | null;
}

const norm = (r: any): ChargeRow => ({
  ...r,
  amount: formatMoney(String(r.amount)),
  released_difference: formatMoney(String(r.released_difference)),
});

export interface ChargeInput {
  tenantId: string;
  /** The only input that selects what is charged; everything else is read from the database. */
  obligationId: string;
  correlationId?: string;
}

export async function chargeInTx(
  tx: DbClient,
  input: ChargeInput,
): Promise<{ charge: ChargeRow; created: boolean }> {
  const ob = await tx.query(
    `SELECT id, agreement_id, mission_id, amount, currency FROM obligations
      WHERE id = $1 AND tenant_id = $2`,
    [input.obligationId, input.tenantId],
  );
  const obligation = ob.rows[0];
  if (!obligation) throw new NotFoundError("Obligation", input.obligationId);

  // Idempotent by obligation ID.
  const prior = await tx.query(
    `SELECT * FROM wallet_charges WHERE obligation_id = $1`,
    [obligation.id],
  );
  if (prior.rows[0]) return { charge: norm(prior.rows[0]), created: false };

  const found = await tx.query(
    `SELECT wallet_id FROM wallet_reservations WHERE agreement_id = $1 AND tenant_id = $2`,
    [obligation.agreement_id, input.tenantId],
  );
  if (!found.rows[0]) {
    throw new ConflictError(
      "WALLET_NO_ACTIVE_RESERVATION",
      "No active Reservation exists for this agreement, so it cannot be charged.",
      { agreement_id: obligation.agreement_id },
    );
  }

  // Lock order: wallet, then reservation.
  await tx.query(`SELECT id FROM wallets WHERE id = $1 FOR UPDATE`, [
    found.rows[0].wallet_id,
  ]);
  const rr = await tx.query(
    `SELECT * FROM wallet_reservations WHERE agreement_id = $1 FOR UPDATE`,
    [obligation.agreement_id],
  );
  const reservation = rr.rows[0];
  if (reservation.status !== "active") {
    throw new ConflictError(
      "WALLET_NO_ACTIVE_RESERVATION",
      "The Reservation for this agreement is no longer active.",
      { agreement_id: obligation.agreement_id, status: reservation.status },
    );
  }
  await assertWalletUsable(tx, reservation.wallet_id);

  const amount = new Decimal(String(obligation.amount));
  const reserved = new Decimal(String(reservation.amount));
  const currency = String(obligation.currency);
  if (
    amount.gt(reserved) ||
    currency !== String(reservation.currency) ||
    String(obligation.mission_id) !== String(reservation.mission_id)
  ) {
    throw new ConflictError(
      "CHARGE_LIMIT_EXCEEDED",
      "The obligation exceeds its Reservation, so no Charge was made.",
      {
        agreement_id: obligation.agreement_id,
        obligation_amount: formatMoney(amount),
        reserved: formatMoney(reserved),
      },
    );
  }

  const difference = reserved.minus(amount);
  const reasonCode = "OBLIGATION_ACCRUED";

  const ev = await appendWalletEvent(tx, {
    tenantId: input.tenantId,
    aggregateType: "wallet",
    aggregateId: reservation.wallet_id,
    eventType: "WALLET_CHARGED",
    actorRole: "system",
    actorId: "00000000-0000-0000-0000-000000000000",
    correlationId: input.correlationId,
    amount: formatMoney(amount),
    currency,
    details: {
      agreement_id: obligation.agreement_id,
      obligation_id: obligation.id,
      mission_id: obligation.mission_id,
      reservation_id: reservation.id,
      released_difference: formatMoney(difference),
      reason_code: reasonCode,
    },
    idempotencyKey: `wallet-charge:${obligation.id}`,
  });

  const ins = await tx.query(
    `INSERT INTO wallet_charges
       (id, tenant_id, wallet_id, reservation_id, obligation_id, agreement_id, mission_id,
        amount, released_difference, currency, reason_code)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      input.tenantId,
      reservation.wallet_id,
      reservation.id,
      obligation.id,
      obligation.agreement_id,
      obligation.mission_id,
      formatMoney(amount),
      formatMoney(difference),
      currency,
      reasonCode,
    ],
  );

  // Reservation becomes charged; the difference is released with it.
  await tx.query(
    `UPDATE wallet_reservations
        SET status = 'charged', release_reason = NULL, closed_at = now()
      WHERE id = $1 AND status = 'active'`,
    [reservation.id],
  );

  const journal = await postJournal(tx, {
    tenantId: input.tenantId,
    eventId: ev.id,
    reference: `wallet:charge:${obligation.id}`,
    currency,
    lines: [
      {
        accountCode: "2103",
        side: "debit",
        amount: formatMoney(amount),
        walletId: reservation.wallet_id,
      },
      { accountCode: "2102", side: "credit", amount: formatMoney(amount) },
    ],
  });
  await tx.query(
    `UPDATE wallet_charges SET journal_transaction_id = $2 WHERE id = $1`,
    [ins.rows[0].id, journal.transactionId],
  );

  await recomputeMissionFunding(tx, obligation.mission_id);

  return {
    charge: norm({
      ...ins.rows[0],
      journal_transaction_id: journal.transactionId,
    }),
    created: true,
  };
}
