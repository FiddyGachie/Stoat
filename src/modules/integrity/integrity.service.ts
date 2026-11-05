import { DbClient } from '../../db/connection.js';
import { Decimal } from 'decimal.js';
import { EventsService } from '../events/events.service.js';

export interface CurrencyBalance {
  currency: string;
  total_debit: string;
  total_credit: string;
  delta: string;
  balanced: boolean;
}

export interface IntegrityReport {
  integrity_status: 'healthy' | 'violation_detected';
  computed_at: string;
  metrics: {
    debit_credit_balance: CurrencyBalance[];
    hash_chain_gaps: number;
    duplicate_obligations: number;
    duplicate_active_reservations: number;
    orphan_reservations: number;
    batch_sum_mismatches: number;
    unreconciled_captures: number;
    unauthorized_agreements: number;
  };
  details: Record<string, any>;
}

export class IntegrityService {
  private eventsService: EventsService;

  constructor(private db: DbClient) {
    this.eventsService = new EventsService(db);
  }

  async computeIntegrity(tenantId: string): Promise<IntegrityReport> {
    const computedAt = new Date().toISOString();

    // 1. Journal Debit-Credit Balance by Currency
    const journalRes = await this.db.query<{
      currency: string;
      total_debit: string;
      total_credit: string;
    }>(
      `SELECT currency, 
              COALESCE(SUM(debit), 0) as total_debit, 
              COALESCE(SUM(credit), 0) as total_credit 
       FROM journal_lines 
       WHERE tenant_id = $1 
       GROUP BY currency`,
      [tenantId]
    );

    const currencyBalances: CurrencyBalance[] = journalRes.rows.map((row) => {
      const debit = new Decimal(row.total_debit);
      const credit = new Decimal(row.total_credit);
      const delta = debit.minus(credit);
      return {
        currency: row.currency,
        total_debit: debit.toFixed(6),
        total_credit: credit.toFixed(6),
        delta: delta.toFixed(6),
        balanced: delta.isZero(),
      };
    });

    const isJournalBalanced = currencyBalances.every((b) => b.balanced);

    // 2. Hash Chain Gaps
    const aggregatesRes = await this.db.query<{ aggregate_type: string; aggregate_id: string }>(
      `SELECT DISTINCT aggregate_type, aggregate_id 
       FROM economic_events 
       WHERE tenant_id = $1`,
      [tenantId]
    );

    let hashChainGaps = 0;
    const brokenChains: any[] = [];
    for (const agg of aggregatesRes.rows) {
      const check = await this.eventsService.verifyChainContinuity(
        tenantId,
        agg.aggregate_type,
        agg.aggregate_id
      );
      if (!check.valid) {
        hashChainGaps++;
        brokenChains.push({ ...agg, error: check.error });
      }
    }

    // 3. Duplicate Obligations per Agreement
    const dupObligationsRes = await this.db.query(
      `SELECT agreement_id, COUNT(*) as count 
       FROM obligations 
       WHERE tenant_id = $1 
       GROUP BY agreement_id 
       HAVING COUNT(*) > 1`,
      [tenantId]
    );
    const duplicateObligations = dupObligationsRes.rows.length;

    // 4. Duplicate Active Batch Reservations
    const dupReservationsRes = await this.db.query(
      `SELECT sbi.obligation_id, COUNT(*) as count 
       FROM settlement_batch_items sbi 
       JOIN settlement_batches sb ON sb.id = sbi.batch_id 
       WHERE sbi.tenant_id = $1 AND sb.status NOT IN ('rejected', 'cancelled', 'failed') 
       GROUP BY sbi.obligation_id 
       HAVING COUNT(*) > 1`,
      [tenantId]
    );
    const duplicateActiveReservations = dupReservationsRes.rows.length;

    // 5. Orphan Reservations (reserved > budget)
    const orphanRes = await this.db.query(
      `SELECT COUNT(*) as count 
       FROM missions 
       WHERE tenant_id = $1 AND reserved_budget > budget`,
      [tenantId]
    );
    const orphanReservations = parseInt(orphanRes.rows[0]?.count || '0', 10);

    // 6. Batch Sum Mismatches
    const batchSumRes = await this.db.query(
      `SELECT sb.id, sb.total_amount, COALESCE(SUM(sbi.amount), 0) as items_sum 
       FROM settlement_batches sb 
       LEFT JOIN settlement_batch_items sbi ON sbi.batch_id = sb.id 
       WHERE sb.tenant_id = $1 
       GROUP BY sb.id, sb.total_amount 
       HAVING sb.total_amount != COALESCE(SUM(sbi.amount), 0)`,
      [tenantId]
    );
    const batchSumMismatches = batchSumRes.rows.length;

    // 7. Unreconciled Captures
    const unreconciledRes = await this.db.query(
      `SELECT COUNT(*) as count 
       FROM payment_transactions pt 
       LEFT JOIN reconciliation_records rr ON rr.payment_transaction_id = pt.id 
       WHERE pt.tenant_id = $1 AND pt.status = 'captured' AND rr.id IS NULL`,
      [tenantId]
    );
    const unreconciledCaptures = parseInt(unreconciledRes.rows[0]?.count || '0', 10);

    // 8. Unauthorized Agreements
    const unauthAgreementsRes = await this.db.query(
      `SELECT COUNT(*) as count 
       FROM agreements a 
       LEFT JOIN policy_decisions pd ON pd.id = a.policy_decision_id 
       WHERE a.tenant_id = $1 AND (pd.id IS NULL OR pd.result != 'allow')`,
      [tenantId]
    );
    const unauthorizedAgreements = parseInt(unauthAgreementsRes.rows[0]?.count || '0', 10);

    const isHealthy =
      isJournalBalanced &&
      hashChainGaps === 0 &&
      duplicateObligations === 0 &&
      duplicateActiveReservations === 0 &&
      orphanReservations === 0 &&
      batchSumMismatches === 0 &&
      unreconciledCaptures === 0 &&
      unauthorizedAgreements === 0;

    return {
      integrity_status: isHealthy ? 'healthy' : 'violation_detected',
      computed_at: computedAt,
      metrics: {
        debit_credit_balance: currencyBalances,
        hash_chain_gaps: hashChainGaps,
        duplicate_obligations: duplicateObligations,
        duplicate_active_reservations: duplicateActiveReservations,
        orphan_reservations: orphanReservations,
        batch_sum_mismatches: batchSumMismatches,
        unreconciled_captures: unreconciledCaptures,
        unauthorized_agreements: unauthorizedAgreements,
      },
      details: {
        broken_chains: brokenChains,
        duplicate_obligations_records: dupObligationsRes.rows,
        duplicate_reservations_records: dupReservationsRes.rows,
      },
    };
  }
}
