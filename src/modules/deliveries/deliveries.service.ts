import { DbClient } from "../../db/connection.js";
import { PaymentRequiredError } from "../payments/funding.service.js";
import { EventsService } from "../events/events.service.js";
import { ArtifactsService } from "../artifacts/artifacts.service.js";
import { GroundedVerifierService } from "../verification/grounded-verifier.service.js";
import { releaseReservation } from "../wallet/reservation.service.js";
import { NotFoundError, ConflictError } from "../../common/errors.js";

export interface SubmitDeliveryInput {
  tenantId: string;
  agreementId: string;
  providerId: string;
  artifactId: string;
  agentRunId?: string;
  declaredResult?: Record<string, any>;
  correlationId?: string;
}

export class DeliveriesService {
  private eventsService: EventsService;
  private artifactsService: ArtifactsService;
  private verifierService: GroundedVerifierService;

  constructor(
    private db: DbClient,
    fixtureDir?: string,
  ) {
    this.eventsService = new EventsService(db);
    this.artifactsService = new ArtifactsService(db);
    this.verifierService = new GroundedVerifierService(db, fixtureDir);
  }

  getFixtureRoot(): string {
    return this.verifierService.getFixtureRoot();
  }

  async submitDelivery(input: SubmitDeliveryInput): Promise<any> {
    // 1. Fetch agreement
    const agreementRes = await this.db.query(
      `SELECT a.id, a.mission_id, a.quote_id, a.buyer_id, a.provider_id, a.status,
              a.revision_count, a.max_revisions, a.price, a.currency, a.funding_status, s.verification_profile
       FROM agreements a
       JOIN quotes q ON q.id = a.quote_id
       JOIN services s ON s.id = q.service_id
       WHERE a.tenant_id = $1 AND a.id = $2`,
      [input.tenantId, input.agreementId],
    );

    if (agreementRes.rows.length === 0) {
      throw new NotFoundError("Agreement", input.agreementId);
    }

    const agreement = agreementRes.rows[0];
    if (
      agreement.status !== "accepted" &&
      agreement.status !== "revision_requested"
    ) {
      throw new ConflictError(
        "INVALID_TRANSITION",
        `Cannot submit delivery for agreement with status '${agreement.status}'.`,
      );
    }

    // Evidence unlocks money, and money unlocks work: with REQUIRE_FUNDING=true the buyer must
    // have paid (captured through PayPal) before a provider can deliver.
    if (
      process.env.REQUIRE_FUNDING === "true" &&
      Number(agreement.price) > 0 &&
      agreement.funding_status !== "funded"
    ) {
      throw new PaymentRequiredError(agreement.id);
    }
    // 2. Fetch artifact payload
    const artifact = await this.artifactsService.getArtifact(
      input.tenantId,
      input.artifactId,
    );
    const findings =
      artifact.metadata?.parsed?.findings || artifact.metadata?.parsed || [];

    // 3. Create delivery row
    const deliveryRes = await this.db.query(
      `INSERT INTO deliveries (
        id, tenant_id, agreement_id, provider_id, agent_run_id, artifact_id,
        declared_result, revision_number, status
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5,
        $6, $7, 'submitted'
      ) RETURNING id, tenant_id, agreement_id, provider_id, agent_run_id, artifact_id, revision_number, status, created_at`,
      [
        input.tenantId,
        input.agreementId,
        input.providerId,
        input.agentRunId || null,
        input.artifactId,
        JSON.stringify(input.declaredResult || {}),
        agreement.revision_count,
      ],
    );
    const delivery = deliveryRes.rows[0];

    // 4. Run Grounded Verification
    const verificationProfile =
      typeof agreement.verification_profile === "string"
        ? JSON.parse(agreement.verification_profile)
        : agreement.verification_profile;

    const verification = await this.verifierService.verifyReviewDelivery({
      tenantId: input.tenantId,
      deliveryId: delivery.id,
      findings,
      verificationProfile,
    });

    // 5. Update delivery and agreement status based on verdict
    await this.db.query(
      "UPDATE deliveries SET status = $1, updated_at = now() WHERE id = $2",
      [verification.verdict, delivery.id],
    );
    delivery.status = verification.verdict;

    await this.db.query(
      "UPDATE agreements SET status = $1, updated_at = now() WHERE id = $2",
      [verification.verdict, agreement.id],
    );

    // 6. Append economic event
    const eventType =
      verification.verdict === "verified"
        ? "DELIVERY_VERIFIED"
        : verification.verdict === "rejected"
          ? "DELIVERY_REJECTED"
          : "DELIVERY_NEEDS_REVIEW";

    await this.eventsService.appendEvent({
      tenantId: input.tenantId,
      aggregateType: "agreement",
      aggregateId: agreement.id,
      eventType,
      actorType: "agent",
      actorId: input.providerId,
      correlationId: input.correlationId,
      payload: {
        delivery_id: delivery.id,
        artifact_id: input.artifactId,
        verdict: verification.verdict,
        reasons: verification.reasons,
        checks_count: verification.checks.length,
      },
    });

    // 6b. Final rejection (revisions exhausted) frees the wallet Reservation (R5.8, R6.6).
    // A revisable rejection and needs_review keep it. No-op in direct mode (no Reservation).
    if (
      verification.verdict === "rejected" &&
      Number(agreement.revision_count) >= Number(agreement.max_revisions)
    ) {
      await releaseReservation({
        tenantId: input.tenantId,
        agreementId: agreement.id,
        reason: "delivery_rejected_final",
        correlationId: input.correlationId,
      });
    }

    // 7. Accrue obligation only if verified
    let obligationResult = null;
    if (verification.verdict === "verified") {
      const { LedgerService } = await import("../ledger/ledger.service.js");
      const ledgerService = new LedgerService(this.db);
      obligationResult = await ledgerService.accrueObligationForDelivery({
        tenantId: input.tenantId,
        agreementId: input.agreementId,
        deliveryId: delivery.id,
        correlationId: input.correlationId,
      });
    }

    return {
      delivery,
      verification,
      obligation: obligationResult?.obligation || null,
    };
  }

  async requestRevision(params: {
    tenantId: string;
    buyerId: string;
    deliveryId: string;
    reasons?: string[];
    correlationId?: string;
  }): Promise<any> {
    // 1. Fetch delivery & agreement
    const delRes = await this.db.query(
      `SELECT d.id, d.agreement_id, d.status as delivery_status, a.status as agreement_status,
              a.buyer_id,
              a.revision_count, a.max_revisions
       FROM deliveries d
       JOIN agreements a ON a.id = d.agreement_id
       WHERE d.tenant_id = $1 AND d.id = $2`,
      [params.tenantId, params.deliveryId],
    );

    if (delRes.rows.length === 0) {
      throw new NotFoundError("Delivery", params.deliveryId);
    }

    const {
      agreement_id,
      buyer_id,
      revision_count,
      max_revisions,
      delivery_status,
    } = delRes.rows[0];
    if (buyer_id !== params.buyerId) {
      throw new NotFoundError("Delivery", params.deliveryId);
    }

    if (delivery_status !== "rejected") {
      throw new ConflictError(
        "INVALID_TRANSITION",
        `Revision can only be requested for rejected delivery, current status is '${delivery_status}'.`,
      );
    }

    // 2. Check limits
    if (revision_count >= max_revisions) {
      throw new ConflictError(
        "MAX_REVISIONS_EXCEEDED",
        `Agreement has reached maximum allowed revisions (${max_revisions}). Cannot request further revision.`,
      );
    }

    const nextRevision = revision_count + 1;

    // 3. Update agreement status to revision_requested
    await this.db.query(
      `UPDATE agreements 
       SET status = 'revision_requested', revision_count = $1, updated_at = now() 
       WHERE id = $2`,
      [nextRevision, agreement_id],
    );

    // 4. Append economic event
    await this.eventsService.appendEvent({
      tenantId: params.tenantId,
      aggregateType: "agreement",
      aggregateId: agreement_id,
      eventType: "REVISION_REQUESTED",
      actorType: "agent",
      actorId: params.buyerId,
      correlationId: params.correlationId,
      payload: {
        delivery_id: params.deliveryId,
        revision_number: nextRevision,
        max_revisions,
        reasons: params.reasons || [],
      },
    });

    return {
      agreement_id,
      revision_number: nextRevision,
      status: "revision_requested",
      max_revisions,
    };
  }

  async getDelivery(tenantId: string, deliveryId: string): Promise<any> {
    const res = await this.db.query(
      `SELECT d.id, d.agreement_id, d.provider_id, d.agent_run_id, d.artifact_id,
              d.declared_result, d.revision_number, d.status, d.created_at,
              v.verdict, v.checks, v.verifier_version, v.reasons, v.verified_at
       FROM deliveries d
       LEFT JOIN verifications v ON v.delivery_id = d.id
       WHERE d.tenant_id = $1 AND d.id = $2`,
      [tenantId, deliveryId],
    );

    if (res.rows.length === 0) {
      throw new NotFoundError("Delivery", deliveryId);
    }

    const row = res.rows[0];
    return {
      ...row,
      checks:
        typeof row.checks === "string" ? JSON.parse(row.checks) : row.checks,
      reasons:
        typeof row.reasons === "string" ? JSON.parse(row.reasons) : row.reasons,
      declared_result:
        typeof row.declared_result === "string"
          ? JSON.parse(row.declared_result)
          : row.declared_result,
    };
  }
}
