import type { DbClient } from "../../db/connection.js";
import { getBalances } from "../wallet/wallet.service.js";
import type {
  ReconciliationExceptionFact,
  RevisionFact,
  PriceOutlierFact,
  SpendSpikeFact,
  UnusualProviderFact,
  WalletDepletingFact,
} from "./detectors/types.js";

/**
 * Tenant-scoped SQL loaders for the Detectors (R5.1, R5.9). No model or network call.
 * Each loader takes `extraIds`: subjects that already have an open Alert, so the Alert can
 * see its condition clear after the subject leaves the recent window. Loaders cap at 5000.
 */
export const FACT_LIMIT = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function loadSpendSpikeFacts(
  db: DbClient,
  tenantId: string,
  now: Date,
  extraIds: string[] = [],
): Promise<SpendSpikeFact[]> {
  const since = new Date(now.getTime() - DAY_MS);
  const baselineStart = new Date(now.getTime() - 15 * DAY_MS);
  const groups = await db.query<{
    subject_id: string;
    mandate_id: string | null;
    currency: string;
    recent: string;
  }>(
    `SELECT COALESCE(mandate_id, wallet_id) AS subject_id, mandate_id, currency,
            COALESCE(SUM(amount) FILTER (WHERE created_at > $2 AND created_at <= $3), 0)::text AS recent
       FROM wallet_reservations
      WHERE tenant_id = $1 AND created_at > $4 AND created_at <= $3
      GROUP BY COALESCE(mandate_id, wallet_id), mandate_id, currency
     HAVING COALESCE(SUM(amount) FILTER (WHERE created_at > $2 AND created_at <= $3), 0) > 0
         OR COALESCE(mandate_id, wallet_id) = ANY($5::uuid[])
      LIMIT ${FACT_LIMIT}`,
    [tenantId, since, now, baselineStart, extraIds],
  );
  const facts: SpendSpikeFact[] = [];
  for (const g of groups.rows) {
    const days = await db.query<{ total: string }>(
      `SELECT SUM(amount)::text AS total FROM wallet_reservations
        WHERE tenant_id = $1 AND COALESCE(mandate_id, wallet_id) = $2 AND currency = $3
          AND created_at > $4 AND created_at <= $5
        GROUP BY date_trunc('day', created_at) ORDER BY date_trunc('day', created_at)`,
      [tenantId, g.subject_id, g.currency, baselineStart, since],
    );
    facts.push({
      subjectType: g.mandate_id ? "mandate" : "wallet",
      subjectId: g.subject_id,
      mandateId: g.mandate_id ?? undefined,
      currency: g.currency,
      recentAmount: g.recent,
      baselineDailyTotals: days.rows.map((d) => d.total),
    });
  }
  return facts;
}

export async function loadPriceOutlierFacts(
  db: DbClient,
  tenantId: string,
  now: Date,
  extraIds: string[] = [],
): Promise<PriceOutlierFact[]> {
  const since = new Date(now.getTime() - DAY_MS);
  const rows = await db.query<{
    agreement_id: string;
    reservation_id: string;
    service_id: string;
    mandate_id: string | null;
    price: string;
    earlier: string[] | null;
  }>(
    `SELECT a.id AS agreement_id, r.id AS reservation_id, q.service_id, a.mandate_id,
            a.price::text AS price,
            (SELECT array_agg(a2.price::text) FROM agreements a2
               JOIN quotes q2 ON q2.id = a2.quote_id AND q2.tenant_id = a2.tenant_id
              WHERE a2.tenant_id = a.tenant_id AND q2.service_id = q.service_id
                AND a2.currency = a.currency
                AND (a2.accepted_at, a2.id) < (a.accepted_at, a.id)) AS earlier
       FROM agreements a
       JOIN quotes q ON q.id = a.quote_id AND q.tenant_id = a.tenant_id
       JOIN wallet_reservations r ON r.agreement_id = a.id AND r.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1
        AND ((a.accepted_at > $2 AND a.accepted_at <= $3) OR a.id = ANY($4::uuid[]))
      LIMIT ${FACT_LIMIT}`,
    [tenantId, since, now, extraIds],
  );
  return rows.rows.map((r) => ({
    agreementId: r.agreement_id,
    reservationId: r.reservation_id,
    serviceId: r.service_id,
    mandateId: r.mandate_id ?? undefined,
    currentPrice: r.price,
    earlierPrices: r.earlier ?? [],
  }));
}

export async function loadRevisionFacts(
  db: DbClient,
  tenantId: string,
  _now: Date,
  _extraIds: string[] = [],
): Promise<RevisionFact[]> {
  const rows = await db.query<{ aggregate_id: string; n: number }>(
    `SELECT aggregate_id, count(*)::int AS n FROM economic_events
      WHERE tenant_id = $1 AND aggregate_type = 'agreement'
        AND event_type IN ('REVISION_REQUESTED','DELIVERY_REJECTED')
      GROUP BY aggregate_id LIMIT ${FACT_LIMIT}`,
    [tenantId],
  );
  return rows.rows.map((r) => ({ agreementId: r.aggregate_id, eventCount: r.n }));
}

export async function loadUnusualProviderFacts(
  db: DbClient,
  tenantId: string,
  now: Date,
  extraIds: string[] = [],
): Promise<UnusualProviderFact[]> {
  const since = new Date(now.getTime() - DAY_MS);
  const rows = await db.query<{
    agreement_id: string;
    reservation_id: string;
    provider_id: string;
    mandate_id: string | null;
    price: string;
    first_agreement: boolean;
  }>(
    `SELECT a.id AS agreement_id, r.id AS reservation_id, a.provider_id, a.mandate_id,
            a.price::text AS price,
            NOT EXISTS (SELECT 1 FROM agreements a2
                         WHERE a2.tenant_id = a.tenant_id AND a2.provider_id = a.provider_id
                           AND (a2.accepted_at, a2.id) < (a.accepted_at, a.id)) AS first_agreement
       FROM agreements a
       JOIN wallet_reservations r ON r.agreement_id = a.id AND r.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1
        AND ((a.accepted_at > $2 AND a.accepted_at <= $3) OR a.id = ANY($4::uuid[]))
      LIMIT ${FACT_LIMIT}`,
    [tenantId, since, now, extraIds],
  );
  return rows.rows.map((r) => ({
    agreementId: r.agreement_id,
    reservationId: r.reservation_id,
    providerId: r.provider_id,
    mandateId: r.mandate_id ?? undefined,
    firstAgreement: r.first_agreement,
    price: r.price,
  }));
}

export async function loadWalletDepletingFacts(
  db: DbClient,
  tenantId: string,
  now: Date,
  extraIds: string[] = [],
): Promise<WalletDepletingFact[]> {
  const since = new Date(now.getTime() - DAY_MS);
  const wallets = await db.query<{ id: string; net: string }>(
    `SELECT w.id,
            (COALESCE((SELECT SUM(amount) FROM wallet_reservations
                        WHERE wallet_id = w.id AND created_at > $2 AND created_at <= $3), 0)
           - COALESCE((SELECT SUM(amount) FROM wallet_reservations
                        WHERE wallet_id = w.id AND status = 'released'
                          AND closed_at > $2 AND closed_at <= $3), 0))::text AS net
       FROM wallets w
      WHERE w.tenant_id = $1
        AND (EXISTS (SELECT 1 FROM wallet_reservations r
                      WHERE r.wallet_id = w.id AND r.created_at > $2 AND r.created_at <= $3)
             OR w.id = ANY($4::uuid[]))
      LIMIT ${FACT_LIMIT}`,
    [tenantId, since, now, extraIds],
  );
  const facts: WalletDepletingFact[] = [];
  for (const w of wallets.rows) {
    const balances = await getBalances(db, w.id);
    facts.push({ walletId: w.id, available: balances.available, netSpendLast24h: w.net });
  }
  return facts;
}

export async function loadReconciliationFacts(
  db: DbClient,
  tenantId: string,
  now: Date,
  _extraIds: string[] = [],
): Promise<ReconciliationExceptionFact[]> {
  const rows = await db.query<{ id: string; kind: string; created_at: Date | string }>(
    `SELECT id, kind, created_at FROM reconciliation_exceptions
      WHERE tenant_id = $1 AND status = 'open' ORDER BY created_at LIMIT ${FACT_LIMIT}`,
    [tenantId],
  );
  return rows.rows.map((r) => ({
    exceptionId: r.id,
    kind: r.kind,
    ageMinutes: Math.max(
      0,
      Math.floor((now.getTime() - new Date(r.created_at).getTime()) / 60000),
    ),
  }));
}
