import { Decimal } from "decimal.js";
import type { DbClient } from "../../db/connection.js";

export interface MandateUsage {
  usage: Decimal;
  todayUsage: Decimal;
}

export async function getMandateUsage(
  db: DbClient,
  mandateId: string,
  now = new Date(),
): Promise<MandateUsage> {
  const midnightUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const result = await db.query<{ usage: string; today_usage: string }>(
    `SELECT
       COALESCE(SUM(amount), 0)::text AS usage,
       COALESCE(SUM(amount) FILTER (WHERE created_at >= $2), 0)::text AS today_usage
     FROM wallet_reservations
     WHERE mandate_id = $1 AND status IN ('active', 'charged')`,
    [mandateId, midnightUtc.toISOString()],
  );
  const row = result.rows[0];
  return {
    usage: new Decimal(row?.usage ?? 0),
    todayUsage: new Decimal(row?.today_usage ?? 0),
  };
}
