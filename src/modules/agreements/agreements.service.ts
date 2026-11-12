import { DbClient, transaction } from "../../db/connection.js";
import { Decimal } from "decimal.js";
import { EventsService } from "../events/events.service.js";
import { PolicyService } from "../policy/policy.service.js";
import {
  NotFoundError,
  ConflictError,
  QuoteExpiredError,
  PolicyDeniedError,
  BudgetExceededError,
} from "../../common/errors.js";
import { toDecimalString } from "../../common/decimal.js";
import { enqueueProviderReview } from "../../jobs/enqueue.js";
import { getFundingMode } from "../wallet/funding-mode.js";
import {
  reserveInTx,
  notifyInsufficientFunds,
} from "../wallet/reservation.service.js";

const agreementPrice = (a: { price: unknown }) => String(a.price);

export interface AcceptQuoteInput {
  tenantId: string;
  buyerId: string;
  quoteId: string;
  /** A SELECTION proposal from the buyer agent's negotiation. Re-validated here; never trusted as given. */
  proposalId?: string;
  correlationId?: string;
}

export class AgreementsService {
  constructor(private db: DbClient) {}

  async acceptQuote(input: AcceptQuoteInput): Promise<any> {
    let result: any;
    try {
      result = await transaction(async (tx) => {
        // 1. Lock and fetch quote
        const quoteRes = await tx.query(
          `SELECT q.id, q.quote_request_id, q.service_id, q.provider_id, q.price, q.currency,
                q.terms, q.expires_at, q.status, s.category as service_category, qr.mission_id
         FROM quotes q
         JOIN services s ON s.id = q.service_id
         LEFT JOIN quote_requests qr ON qr.id = q.quote_request_id
         WHERE q.tenant_id = $1 AND q.id = $2
         FOR UPDATE OF q`,
          [input.tenantId, input.quoteId],
        );

        if (quoteRes.rows.length === 0) {
          throw new NotFoundError("Quote", input.quoteId);
        }

        const quote = quoteRes.rows[0];

        // Check state
        if (quote.status === "accepted") {
          throw new ConflictError(
            "QUOTE_ALREADY_ACCEPTED",
            "This quote has already been accepted.",
          );
        }
        if (quote.status !== "offered") {
          throw new ConflictError(
            "INVALID_TRANSITION",
            `Cannot accept quote with status '${quote.status}'.`,
          );
        }

        // Check expiry
        const now = new Date();
        const expiresAt = new Date(quote.expires_at);
        if (now > expiresAt) {
          await tx.query("UPDATE quotes SET status = 'expired' WHERE id = $1", [
            quote.id,
          ]);
          throw new QuoteExpiredError();
        }

        const missionId = quote.mission_id;
        if (!missionId) {
          throw new ConflictError(
            "MISSING_MISSION",
            "Quote is not associated with a mission.",
          );
        }

        // 2. Lock and fetch mission
        const missionRes = await tx.query(
          "SELECT id, buyer_id, budget, reserved_budget, currency, status FROM missions WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
          [missionId, input.tenantId],
        );
        if (missionRes.rows.length === 0) {
          throw new NotFoundError("Mission", missionId);
        }

        const mission = missionRes.rows[0];
        if (mission.buyer_id !== input.buyerId) {
          throw new NotFoundError("Quote", input.quoteId);
        }

        // 2b. Negotiated price (v2.1). The proposal is only a request: the price must still be inside the
        // quote and the provider's floor, and the spending policy below still decides.
        let agreedPrice = toDecimalString(quote.price);
        let proposal: { id: string; payload: any } | null = null;
        if (input.proposalId) {
          const pr = await tx.query(
            `SELECT id, payload FROM commercial_proposals
           WHERE tenant_id = $1 AND id = $2 AND mission_id = $3 AND quote_id = $4 AND proposal_type = 'SELECTION'
             AND deterministic_validation = 'passed' AND accepted_agreement_id IS NULL FOR UPDATE`,
            [input.tenantId, input.proposalId, missionId, quote.id],
          );
          if (pr.rows.length === 0) {
            throw new ConflictError(
              "PROPOSAL_INVALID",
              "That negotiated offer is not valid for this quote (wrong quote, already used, or not validated).",
            );
          }
          proposal = {
            id: pr.rows[0].id,
            payload:
              typeof pr.rows[0].payload === "string"
                ? JSON.parse(pr.rows[0].payload)
                : pr.rows[0].payload,
          };
          const amount = new Decimal(proposal.payload.agreed_amount);
          const floorRes = await tx.query(
            "SELECT min_price FROM services WHERE id = $1",
            [quote.service_id],
          );
          const floor = floorRes.rows[0]?.min_price;
          const listed = new Decimal(quote.price);
          const ok =
            amount.greaterThan(0) &&
            amount.lessThanOrEqualTo(listed) &&
            proposal.payload.currency === quote.currency &&
            (amount.equals(listed) ||
              (floor !== null &&
                floor !== undefined &&
                amount.greaterThanOrEqualTo(floor)));
          if (!ok)
            throw new ConflictError(
              "PROPOSAL_INVALID",
              "The negotiated price is outside what the provider allows.",
            );
          agreedPrice = toDecimalString(amount);
        }
        // 3. Evaluate deterministic policy
        const policyService = new PolicyService(tx);
        const evalResult = await policyService.evaluateQuoteAcceptance({
          tenantId: input.tenantId,
          actorId: input.buyerId,
          quoteId: quote.id,
          missionId,
          quotePrice: agreedPrice,
          currency: quote.currency,
          serviceCategory: quote.service_category,
        });

        if (!evalResult.allowed) {
          let err: Error;
          if (evalResult.reasonCodes.includes("BUDGET_EXCEEDED")) {
            err = new BudgetExceededError(
              `Quote price ${quote.price} exceeds remaining mission budget.`,
              { reasonCodes: evalResult.reasonCodes },
            );
          } else {
            err = new PolicyDeniedError(
              `Quote acceptance denied by policy: ${evalResult.reasonCodes.join(", ")}`,
              { reasonCodes: evalResult.reasonCodes },
            );
          }
          return { denied: true, error: err };
        }

        // 4. Reserve budget atomically
        const currentReserved = new Decimal(mission.reserved_budget);
        const quotePrice = new Decimal(agreedPrice);
        const newReserved = currentReserved.plus(quotePrice);

        await tx.query(
          "UPDATE missions SET reserved_budget = $1, updated_at = now() WHERE id = $2",
          [toDecimalString(newReserved), missionId],
        );

        // 5. Update quote status
        await tx.query(
          "UPDATE quotes SET status = 'accepted', updated_at = now() WHERE id = $1",
          [quote.id],
        );

        // 6. Create immutable Agreement
        const agreementRes = await tx.query(
          `INSERT INTO agreements (
          id, tenant_id, mission_id, quote_id, buyer_id, provider_id,
          terms, price, currency, max_revisions, revision_count, status,
          policy_decision_id, accepted_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5,
          $6, $7, $8, 2, 0, 'accepted',
          $9, now()
        ) RETURNING id, tenant_id, mission_id, quote_id, buyer_id, provider_id, terms, price, currency, max_revisions, revision_count, status, policy_decision_id, accepted_at, created_at`,
          [
            input.tenantId,
            missionId,
            quote.id,
            input.buyerId,
            quote.provider_id,
            JSON.stringify(
              proposal
                ? {
                    ...(typeof quote.terms === "string"
                      ? JSON.parse(quote.terms)
                      : quote.terms),
                    negotiation: {
                      proposal_id: proposal.id,
                      listed_price: toDecimalString(quote.price),
                      agreed_price: agreedPrice,
                      deadline_hours: proposal.payload.deadline_hours ?? null,
                      acceptance_criteria:
                        proposal.payload.acceptance_criteria ?? [],
                      scope_delta: proposal.payload.scope_delta ?? "",
                    },
                  }
                : quote.terms,
            ),
            agreedPrice,
            quote.currency,
            evalResult.decisionId,
          ],
        );

        const agreement = agreementRes.rows[0];
        // The provider can start once the deal is ready: now, unless the buyer must pay first
        // (then the job is queued when PayPal captures the payment).
        // Wallet mode (R5.1, R17.3): reserve from the Owner's wallet in this same transaction. A refusal
        // throws and rolls back the agreement, the quote status and the budget reservation together.
        const walletMode =
          (await getFundingMode(tx, input.tenantId)) === "wallet";
        if (walletMode) {
          await reserveInTx(tx, {
            tenantId: input.tenantId,
            agreementId: agreement.id,
            actorId: input.buyerId,
            correlationId: input.correlationId,
          });
          await tx.query(
            "UPDATE agreements SET funding_status = 'funded' WHERE id = $1",
            [agreement.id],
          );
        }
        if (
          walletMode ||
          process.env.REQUIRE_FUNDING !== "true" ||
          !(Number(agreementPrice(agreement)) > 0)
        ) {
          await enqueueProviderReview(tx, {
            tenantId: input.tenantId,
            agreementId: agreement.id,
          });
        }
        if (proposal) {
          await tx.query(
            "UPDATE agreements SET commercial_proposal_id = $1 WHERE id = $2",
            [proposal.id, agreement.id],
          );
          await tx.query(
            "UPDATE commercial_proposals SET accepted_agreement_id = $1 WHERE id = $2",
            [agreement.id, proposal.id],
          );
        }
        agreement.price = String(agreement.price);
        agreement.terms =
          typeof agreement.terms === "string"
            ? JSON.parse(agreement.terms)
            : agreement.terms;

        // 7. Append economic event
        const eventsService = new EventsService(tx);
        await eventsService.appendEvent({
          tenantId: input.tenantId,
          aggregateType: "agreement",
          aggregateId: agreement.id,
          eventType: "AGREEMENT_ACCEPTED",
          actorType: "agent",
          actorId: input.buyerId,
          correlationId: input.correlationId,
          amount: agreement.price,
          currency: agreement.currency,
          payload: {
            agreement_id: agreement.id,
            mission_id: agreement.mission_id,
            quote_id: agreement.quote_id,
            provider_id: agreement.provider_id,
            price: agreement.price,
            policy_decision_id: agreement.policy_decision_id,
          },
        });

        return agreement;
      });
    } catch (err: any) {
      // The acceptance rolled back; record the shortfall notice in a follow-up transaction (R5.3).
      await notifyInsufficientFunds(input.tenantId, err, input.quoteId);
      throw err;
    }

    if (result && (result as any).denied) {
      throw (result as any).error;
    }

    return result;
  }

  async getAgreement(
    tenantId: string,
    agreementId: string,
    buyerId?: string,
  ): Promise<any> {
    const res = await this.db.query(
      `SELECT a.id, a.mission_id, a.quote_id, a.buyer_id, a.provider_id, a.terms, a.price, a.currency,
              a.max_revisions, a.revision_count, a.status, a.policy_decision_id, a.accepted_at, a.created_at
       FROM agreements a
       JOIN missions m ON m.id = a.mission_id AND m.tenant_id = a.tenant_id
       WHERE a.tenant_id = $1 AND a.id = $2 AND ($3::uuid IS NULL OR m.buyer_id = $3)`,
      [tenantId, agreementId, buyerId ?? null],
    );

    if (res.rows.length === 0) {
      throw new NotFoundError("Agreement", agreementId);
    }

    const row = res.rows[0];
    return {
      ...row,
      price: String(row.price),
      terms: typeof row.terms === "string" ? JSON.parse(row.terms) : row.terms,
    };
  }
}
