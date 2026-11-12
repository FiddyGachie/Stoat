/**
 * Mission results: what the provider agent actually delivered, in a form the buyer can act on.
 *
 * Only a delivery the deterministic verifier marked `verified` is presented as the result. Earlier
 * attempts are listed with the verifier's reasons, so the buyer can see what was rejected and why.
 * Everything comes from stored records; nothing is summarised or rewritten here.
 */
import { DbClient } from "../../db/connection.js";
import { NotFoundError } from "../../common/errors.js";
import { toDecimalString } from "../../common/decimal.js";

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export class ResultsService {
  constructor(private db: DbClient) {}

  /**
   * @param scope restricts who may read it: a buyer agent id, a provider agent id, or an owner user id.
   *              Operators pass nothing and read anything in their tenant.
   */
  async forAgreement(
    tenantId: string,
    agreementId: string,
    scope: {
      buyerAgentId?: string;
      providerAgentId?: string;
      ownerUserId?: string;
    } = {},
  ) {
    const a = await this.db.query<any>(
      `SELECT a.id, a.status, a.price, a.currency, a.accepted_at, a.terms, a.funding_status, a.mandate_id, a.buyer_id, a.provider_id,
              m.id AS mission_id, m.title AS mission_title, m.brief AS mission_brief,
              p.name AS provider_name, b.owner_user_id AS buyer_owner
       FROM agreements a
       JOIN missions m ON m.id = a.mission_id
       JOIN agents p ON p.id = a.provider_id
       JOIN agents b ON b.id = a.buyer_id
       WHERE a.tenant_id = $1 AND a.id = $2`,
      [tenantId, agreementId],
    );
    const ag = a.rows[0];
    const allowed =
      ag &&
      ((!scope.buyerAgentId && !scope.providerAgentId && !scope.ownerUserId) ||
        (scope.buyerAgentId && ag.buyer_id === scope.buyerAgentId) ||
        (scope.providerAgentId && ag.provider_id === scope.providerAgentId) ||
        (scope.ownerUserId && ag.buyer_owner === scope.ownerUserId));
    if (!allowed) throw new NotFoundError("Agreement", agreementId);

    const attempts = await this.db.query<any>(
      `SELECT d.id, d.status, d.revision_number, d.created_at, d.artifact_id,
              v.verdict, v.reasons, v.checks, v.verifier_version,
              art.content_hash, art.metadata, r.model
       FROM deliveries d
       LEFT JOIN LATERAL (SELECT * FROM verifications x WHERE x.delivery_id = d.id ORDER BY x.verified_at DESC LIMIT 1) v ON TRUE
       LEFT JOIN artifacts art ON art.id = d.artifact_id
       LEFT JOIN agent_runs r ON r.id = d.agent_run_id
       WHERE d.agreement_id = $1 AND d.tenant_id = $2
       ORDER BY d.created_at`,
      [agreementId, tenantId],
    );
    const ob = await this.db.query<any>(
      `SELECT id, amount, status FROM obligations WHERE agreement_id = $1 AND tenant_id = $2`,
      [agreementId, tenantId],
    );
    const parse = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
    const count = (checks: any, passed: boolean) =>
      (parse(checks) ?? []).filter((c: any) => !!c.passed === passed).length;
    const verified = [...attempts.rows]
      .reverse()
      .find((d) => d.verdict === "verified");
    const delivered = verified
      ? (parse(verified.metadata)?.parsed ?? {})
      : null;
    const terms = parse(ag.terms) ?? {};

    return {
      agreement: {
        id: ag.id,
        status: ag.status,
        price: toDecimalString(ag.price),
        currency: ag.currency,
        accepted_at: ag.accepted_at,
        funding_status: ag.funding_status,
        mandate_id: ag.mandate_id ?? null,
        negotiated: terms?.negotiation ?? null,
      },
      mission: {
        id: ag.mission_id,
        title: ag.mission_title,
        brief: ag.mission_brief,
      },
      provider: { id: ag.provider_id, name: ag.provider_name },
      obligation: ob.rows[0]
        ? {
            id: ob.rows[0].id,
            amount: toDecimalString(ob.rows[0].amount),
            status: ob.rows[0].status,
          }
        : null,
      result:
        delivered && verified
          ? {
              delivery_id: verified.id,
              verified_by: verified.verifier_version,
              artifact_hash: verified.content_hash,
              model: verified.model ?? null,
              summary:
                typeof delivered.summary === "string"
                  ? delivered.summary
                  : null,
              files_reviewed: Array.isArray(delivered.files_reviewed)
                ? delivered.files_reviewed
                : null,
              findings: (Array.isArray(delivered.findings)
                ? delivered.findings
                : []
              )
                .map((f: any) => ({
                  severity: f.severity,
                  title: f.title ?? null,
                  rule_id: f.rule_id,
                  file: f.file,
                  line_start: f.line_start,
                  line_end: f.line_end,
                  snippet: f.snippet,
                  description: f.description ?? null,
                  recommendation: f.recommendation ?? null,
                }))
                .sort(
                  (x: any, y: any) =>
                    (SEVERITY_ORDER[x.severity] ?? 9) -
                    (SEVERITY_ORDER[y.severity] ?? 9),
                ),
            }
          : null,
      attempts: attempts.rows.map((d) => ({
        delivery_id: d.id,
        revision: d.revision_number,
        submitted_at: d.created_at,
        verdict: d.verdict ?? d.status,
        reasons: parse(d.reasons) ?? [],
        checks_passed: count(d.checks, true),
        checks_failed: count(d.checks, false),
        model: d.model ?? null,
      })),
    };
  }
}
