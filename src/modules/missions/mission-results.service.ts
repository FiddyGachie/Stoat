/**
 * Permanent archive of mission results (migration 009, table mission_results, append-only).
 * One record per verified agreement: what was delivered, by whom, for how much. Written when a
 * mission completes and backfilled on first read for older missions. Never updated or deleted.
 */
import type { DbClient } from "../../db/connection.js";
import { toDecimalString } from "../../common/decimal.js";
import { ResultsService } from "../results/results.service.js";

export interface ResultsActor {
  id: string;
  role?: string;
}
const isAdmin = (a: ResultsActor) => a.role === "operator" || a.role === "supervisor";

/** Archive every verified agreement of a mission that is not archived yet. Idempotent. */
export async function archiveMissionResults(db: DbClient, tenantId: string, missionId: string): Promise<number> {
  const todo = await db.query<{ id: string }>(
    `SELECT a.id FROM agreements a
      WHERE a.mission_id = $1 AND a.tenant_id = $2 AND a.status = 'verified'
        AND NOT EXISTS (SELECT 1 FROM mission_results r WHERE r.agreement_id = a.id)`,
    [missionId, tenantId],
  );
  const svc = new ResultsService(db);
  let n = 0;
  for (const { id } of todo.rows) {
    const r: any = await svc.forAgreement(tenantId, id);
    const findings: any[] = r.result?.findings ?? [];
    const sev: Record<string, number> = {};
    for (const f of findings) sev[f.severity] = (sev[f.severity] ?? 0) + 1;
    const charged = await db.query<{ s: string | null }>(
      `SELECT COALESCE((SELECT SUM(amount) FROM wallet_charges WHERE agreement_id = $1),
                       (SELECT SUM(amount) FROM obligations WHERE agreement_id = $1))::text AS s`,
      [id],
    );
    const replay = await db.query<{ replay_of: string | null }>(`SELECT replay_of FROM missions WHERE id = $1`, [missionId]);
    const ins = await db.query(
      `INSERT INTO mission_results
         (tenant_id, mission_id, agreement_id, delivery_id, provider_id, provider_name, mission_title, mission_brief,
          replay_of, price, charged, currency, summary, findings, findings_count, severity_counts, files_reviewed,
          artifact_hash, verified_by, model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16::jsonb,$17::jsonb,$18,$19,$20)
       ON CONFLICT (agreement_id) DO NOTHING RETURNING id`,
      [
        tenantId, missionId, id, r.result?.delivery_id ?? null, r.provider?.id ?? null, r.provider?.name ?? null,
        r.mission?.title ?? "", r.mission?.brief ?? null, replay.rows[0]?.replay_of ?? null,
        r.agreement?.price ?? null, charged.rows[0].s, r.agreement?.currency ?? null,
        r.result?.summary ?? null, JSON.stringify(findings), findings.length, JSON.stringify(sev),
        r.result?.files_reviewed ? JSON.stringify(r.result.files_reviewed) : null,
        r.result?.artifact_hash ?? null, r.result?.verified_by ?? null, r.result?.model ?? null,
      ],
    );
    n += ins.rows.length;
  }
  return n;
}

/** Archived results visible to this person (owner) or the tenant (Admin). Backfills completed missions first. */
export async function listMissionResults(
  db: DbClient,
  p: { tenantId: string; actor: ResultsActor; missionId?: string; limit?: number },
) {
  const ownerFilter = isAdmin(p.actor) ? "" : "AND a.owner_user_id = $2";
  const args: unknown[] = [p.tenantId];
  if (!isAdmin(p.actor)) args.push(p.actor.id);
  const missionFilter = p.missionId ? `AND m.id = $${args.length + 1}` : "";
  if (p.missionId) args.push(p.missionId);
  // Backfill: completed missions whose verified work is not archived yet (older data).
  const pending = await db.query<{ id: string }>(
    `SELECT DISTINCT m.id FROM missions m JOIN agents a ON a.id = m.buyer_id
       JOIN agreements g ON g.mission_id = m.id AND g.status = 'verified'
      WHERE m.tenant_id = $1 ${ownerFilter} ${missionFilter} AND m.status = 'completed'
        AND NOT EXISTS (SELECT 1 FROM mission_results r WHERE r.agreement_id = g.id)
      LIMIT 50`,
    args,
  );
  for (const { id } of pending.rows) await archiveMissionResults(db, p.tenantId, id);

  const limit = Math.min(Math.max(Number(p.limit ?? 100) || 100, 1), 200);
  const rows = await db.query<any>(
    `SELECT r.* FROM mission_results r
       JOIN missions m ON m.id = r.mission_id
       JOIN agents a ON a.id = m.buyer_id
      WHERE r.tenant_id = $1 ${ownerFilter} ${missionFilter}
      ORDER BY r.archived_at DESC, r.id
      LIMIT ${limit}`,
    args,
  );
  return rows.rows.map((r) => ({
    id: r.id,
    mission_id: r.mission_id,
    agreement_id: r.agreement_id,
    replay_of: r.replay_of,
    mission_title: r.mission_title,
    mission_brief: r.mission_brief,
    provider_name: r.provider_name,
    price: r.price == null ? null : toDecimalString(r.price),
    charged: r.charged == null ? null : toDecimalString(r.charged),
    currency: r.currency,
    summary: r.summary,
    findings_count: r.findings_count,
    severity_counts: typeof r.severity_counts === "string" ? JSON.parse(r.severity_counts) : r.severity_counts,
    findings: typeof r.findings === "string" ? JSON.parse(r.findings) : r.findings,
    files_reviewed: typeof r.files_reviewed === "string" ? JSON.parse(r.files_reviewed) : r.files_reviewed,
    artifact_hash: r.artifact_hash,
    verified_by: r.verified_by,
    model: r.model,
    archived_at: r.archived_at,
  }));
}
