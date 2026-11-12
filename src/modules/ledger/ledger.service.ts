import { DbClient, transaction } from "../../db/connection.js";
import { runBalanceCheckHook } from "../wallet/wallet-hooks.js";
import { getFundingMode } from "../wallet/funding-mode.js";
import { chargeInTx } from "../wallet/charge.service.js";
import { enqueueMissionCompletionJob } from "../wallet/mission-completion.service.js";
import { EventsService } from "../events/events.service.js";
import { toDecimalString } from "../../common/decimal.js";
import { HoldActiveError } from "../agentic/commerce-errors.js";
import {
  NotFoundError,
  ConflictError,
  StoatError,
} from "../../common/errors.js";

export interface AccrueObligationResult {
  obligation: any;
  journalTransaction: any;
  journalLines: any[];
}

export class LedgerService {
  constructor(private db: DbClient) {}

  async accrueObligationForDelivery(params: {
    tenantId: string;
    agreementId: string;
    deliveryId: string;
    correlationId?: string;
  }): Promise<AccrueObligationResult> {
    return transaction(async (tx) => {
      // 1. Fetch agreement and check status
      const agRes = await tx.query(
        `SELECT id, mission_id, buyer_id, provider_id, price, currency, status 
         FROM agreements 
         WHERE tenant_id = $1 AND id = $2 
         FOR UPDATE`,
        [params.tenantId, params.agreementId],
      );

      if (agRes.rows.length === 0) {
        throw new NotFoundError("Agreement", params.agreementId);
      }

      const agreement = agRes.rows[0];

      // 2. Fetch delivery and verify verdict
      const delRes = await tx.query(
        `SELECT d.id, d.status as delivery_status, v.verdict 
         FROM deliveries d 
         LEFT JOIN verifications v ON v.delivery_id = d.id 
         WHERE d.tenant_id = $1 AND d.id = $2`,
        [params.tenantId, params.deliveryId],
      );

      if (delRes.rows.length === 0) {
        throw new NotFoundError("Delivery", params.deliveryId);
      }

      const delivery = delRes.rows[0];
      if (delivery.verdict !== "verified") {
        throw new ConflictError(
          "DELIVERY_NOT_VERIFIED",
          `Cannot accrue obligation: delivery verdict is '${delivery.verdict || "none"}', expected 'verified'.`,
        );
      }

      // 3. Check for active holds
      const holdsRes = await tx.query(
        `SELECT id, reason FROM holds 
         WHERE tenant_id = $1 AND status = 'active' 
         AND ((scope_type = 'agreement' AND scope_id = $2) 
              OR (scope_type = 'mission' AND scope_id = $3)
              OR (scope_type = 'reservation' AND scope_id IN (
                SELECT id FROM wallet_reservations
                WHERE tenant_id = $1 AND agreement_id = $2 AND status = 'active'
              )))`,
        [params.tenantId, params.agreementId, agreement.mission_id],
      );

      if (holdsRes.rows.length > 0) {
        throw new HoldActiveError({
          hold_id: holdsRes.rows[0].id,
          reason: holdsRes.rows[0].reason,
        });
      }

      // 4. Invariant check: Exactly one obligation per agreement
      const existingOb = await tx.query(
        "SELECT id, status, amount FROM obligations WHERE tenant_id = $1 AND agreement_id = $2",
        [params.tenantId, params.agreementId],
      );

      if (existingOb.rows.length > 0) {
        throw new ConflictError(
          "OBLIGATION_ALREADY_EXISTS",
          `An obligation already exists for agreement '${params.agreementId}'.`,
        );
      }

      // 5. Look up Accounts: Buyer Service Expense (5001) & Provider Payable (2001)
      const accountsRes = await tx.query(
        `SELECT id, account_code, normal_balance 
         FROM accounts 
         WHERE tenant_id = $1 AND currency = $2 AND account_code IN ('5001', '2001')`,
        [params.tenantId, agreement.currency],
      );

      const buyerExpenseAcc = accountsRes.rows.find(
        (a) => a.account_code === "5001",
      );
      const providerPayableAcc = accountsRes.rows.find(
        (a) => a.account_code === "2001",
      );

      if (!buyerExpenseAcc || !providerPayableAcc) {
        throw new StoatError(
          "ACCOUNT_MISSING",
          `Required accounts (5001 or 2001) for currency '${agreement.currency}' are not configured.`,
          500,
        );
      }

      // 6. Create Obligation
      const amountStr = toDecimalString(agreement.price);
      const obRes = await tx.query(
        `INSERT INTO obligations (
          id, tenant_id, agreement_id, mission_id, buyer_id, provider_id,
          amount, currency, status, accrued_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5,
          $6, $7, 'payable', now()
        ) RETURNING id, tenant_id, agreement_id, mission_id, buyer_id, provider_id, amount, currency, status, accrued_at`,
        [
          params.tenantId,
          params.agreementId,
          agreement.mission_id,
          agreement.buyer_id,
          agreement.provider_id,
          amountStr,
          agreement.currency,
        ],
      );
      const obligation = obRes.rows[0];
      obligation.amount = String(obligation.amount);

      // 7. Append Economic Event
      const eventsService = new EventsService(tx);
      const eventRes = await eventsService.appendEvent({
        tenantId: params.tenantId,
        aggregateType: "obligation",
        aggregateId: obligation.id,
        eventType: "OBLIGATION_ACCRUED",
        actorType: "agent",
        actorId: agreement.provider_id,
        correlationId: params.correlationId,
        amount: obligation.amount,
        currency: obligation.currency,
        payload: {
          obligation_id: obligation.id,
          agreement_id: params.agreementId,
          delivery_id: params.deliveryId,
          amount: obligation.amount,
        },
      });

      // 8. Create Balanced Journal Transaction
      const jtRes = await tx.query(
        `INSERT INTO journal_transactions (
          id, tenant_id, source_event_id, reference, status, effective_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, 'posted', now()
        ) RETURNING id, tenant_id, source_event_id, reference, status, effective_at`,
        [params.tenantId, eventRes.id, `obligation:${obligation.id}`],
      );
      const journalTx = jtRes.rows[0];

      // 9. Post Balanced Journal Lines
      // Debit line: Buyer service expense
      const line1Res = await tx.query(
        `INSERT INTO journal_lines (
          id, tenant_id, transaction_id, account_id, debit, credit, currency, sequence
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, 0, $5, 1
        ) RETURNING id, account_id, debit, credit, currency, sequence`,
        [
          params.tenantId,
          journalTx.id,
          buyerExpenseAcc.id,
          amountStr,
          agreement.currency,
        ],
      );

      // Credit line: Provider payable
      const line2Res = await tx.query(
        `INSERT INTO journal_lines (
          id, tenant_id, transaction_id, account_id, debit, credit, currency, sequence
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, 0, $4, $5, 2
        ) RETURNING id, account_id, debit, credit, currency, sequence`,
        [
          params.tenantId,
          journalTx.id,
          providerPayableAcc.id,
          amountStr,
          agreement.currency,
        ],
      );

      // 10. Wallet mode: convert the Reservation into a Charge in this same transaction.
      // Amount comes only from the obligation row; any failure rolls everything back.
      if ((await getFundingMode(tx, params.tenantId)) === "wallet") {
        await chargeInTx(tx, {
          tenantId: params.tenantId,
          obligationId: obligation.id,
          correlationId: params.correlationId,
        });
        // Work verified and wallet charged: complete the mission now (the job re-checks that
        // no other agreement on it is still live) instead of waiting for the 30 s sweep.
        await enqueueMissionCompletionJob(
          tx,
          params.tenantId,
          agreement.mission_id,
        );
      }

      return {
        obligation,
        journalTransaction: journalTx,
        journalLines: [line1Res.rows[0], line2Res.rows[0]],
      };
    });
  }

  async reverseJournalTransaction(params: {
    tenantId: string;
    transactionId: string;
    reason: string;
    actorId: string;
    correlationId?: string;
  }): Promise<{ reversalTransaction: any; lines: any[] }> {
    return transaction(async (tx) => {
      // 1. Fetch original transaction & lines
      const jtRes = await tx.query(
        "SELECT id, source_event_id, reference, status FROM journal_transactions WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [params.tenantId, params.transactionId],
      );

      if (jtRes.rows.length === 0) {
        throw new NotFoundError("JournalTransaction", params.transactionId);
      }

      const originalJt = jtRes.rows[0];
      if (originalJt.status === "reversed") {
        throw new ConflictError(
          "ALREADY_REVERSED",
          "This journal transaction has already been reversed.",
        );
      }

      const linesRes = await tx.query(
        "SELECT account_id, debit, credit, currency, sequence, wallet_id FROM journal_lines WHERE tenant_id = $1 AND transaction_id = $2 ORDER BY sequence ASC",
        [params.tenantId, params.transactionId],
      );

      if (linesRes.rows.length === 0) {
        throw new StoatError(
          "NO_LINES",
          "Original transaction has no journal lines to reverse.",
          500,
        );
      }

      // 2. Mark original transaction as reversed
      await tx.query(
        "UPDATE journal_transactions SET status = 'reversed' WHERE id = $1",
        [originalJt.id],
      );

      // 3. If tied to an obligation, mark obligation as reversed
      if (originalJt.reference.startsWith("obligation:")) {
        const obligationId = originalJt.reference.substring(11);
        await tx.query(
          "UPDATE obligations SET status = 'reversed', updated_at = now() WHERE id = $1",
          [obligationId],
        );
      }

      // 4. Append Reversal Event
      const eventsService = new EventsService(tx);
      const eventRes = await eventsService.appendEvent({
        tenantId: params.tenantId,
        aggregateType: "journal",
        aggregateId: originalJt.id,
        eventType: "JOURNAL_TRANSACTION_REVERSED",
        actorType: "user",
        actorId: params.actorId,
        correlationId: params.correlationId,
        payload: {
          original_transaction_id: originalJt.id,
          reason: params.reason,
        },
      });

      // 5. Create Reversal Journal Transaction
      const revJtRes = await tx.query(
        `INSERT INTO journal_transactions (
          id, tenant_id, source_event_id, reference, status, effective_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, 'posted', now()
        ) RETURNING id, tenant_id, reference, status, effective_at`,
        [params.tenantId, eventRes.id, `reversal:${originalJt.id}`],
      );
      const reversalJt = revJtRes.rows[0];

      // 6. Post Opposite Lines (debit becomes credit, credit becomes debit)
      const reversalLines: any[] = [];
      let seq = 1;
      for (const line of linesRes.rows) {
        const insLineRes = await tx.query(
          `INSERT INTO journal_lines (
            id, tenant_id, transaction_id, account_id, debit, credit, currency, sequence, wallet_id
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8
          ) RETURNING id, account_id, debit, credit, currency, sequence, wallet_id`,
          [
            params.tenantId,
            reversalJt.id,
            line.account_id,
            line.credit, // swap: credit -> debit
            line.debit, // swap: debit -> credit
            line.currency,
            seq++,
            line.wallet_id ?? null,
          ],
        );
        reversalLines.push(insLineRes.rows[0]);
      }

      // 7a. Keep the drift detector in step with a legitimate reversal, exactly as postJournal does
      // for an ordinary posting, so reversing an entry on a healthy wallet is not mistaken for drift.
      // A wallet that is already blocked is left alone: its cache is not trusted, the derived value
      // is authoritative, and the check below lifts the block only when the reversal itself brings
      // derived back to the stored value (R9.15, R9.16).
      await tx.query(
        `UPDATE wallets w
            SET balance_cache = GREATEST(0, w.balance_cache + d.delta),
                last_activity_at = now(), updated_at = now()
           FROM (
             SELECT l.wallet_id, SUM(l.debit - l.credit) AS delta
               FROM journal_lines l
               JOIN accounts a ON a.id = l.account_id
              WHERE l.tenant_id = $1 AND l.transaction_id = $2
                AND a.account_code = '2103' AND l.wallet_id IS NOT NULL
              GROUP BY l.wallet_id
           ) d
          WHERE w.id = d.wallet_id AND w.tenant_id = $1 AND w.status = 'active'`,
        [params.tenantId, originalJt.id],
      );

      // 7. Wallet balance check (no-op until WalletService registers the hook)
      await runBalanceCheckHook(
        tx,
        params.tenantId,
        linesRes.rows.map((l) => l.wallet_id),
      );

      return {
        reversalTransaction: reversalJt,
        lines: reversalLines,
      };
    });
  }

  async listObligations(tenantId: string, status?: string): Promise<any[]> {
    let sql = `
      SELECT o.id, o.agreement_id, o.mission_id, o.buyer_id, o.provider_id,
             o.amount, o.currency, o.status, o.accrued_at, o.created_at,
             m.title as mission_title, a.name as provider_name
      FROM obligations o
      LEFT JOIN missions m ON m.id = o.mission_id
      LEFT JOIN agents a ON a.id = o.provider_id
      WHERE o.tenant_id = $1
    `;
    const params: any[] = [tenantId];
    if (status) {
      sql += " AND o.status = $2";
      params.push(status);
    }
    sql += " ORDER BY o.accrued_at DESC";

    const res = await this.db.query(sql, params);
    return res.rows.map((row: any) => ({
      ...row,
      amount: String(row.amount),
    }));
  }

  async getObligation(tenantId: string, obligationId: string): Promise<any> {
    const res = await this.db.query(
      `SELECT o.id, o.agreement_id, o.mission_id, o.buyer_id, o.provider_id,
              o.amount, o.currency, o.status, o.accrued_at, o.created_at
       FROM obligations o
       WHERE o.tenant_id = $1 AND o.id = $2`,
      [tenantId, obligationId],
    );

    if (res.rows.length === 0) {
      throw new NotFoundError("Obligation", obligationId);
    }

    const row = res.rows[0];
    return {
      ...row,
      amount: String(row.amount),
    };
  }
}
