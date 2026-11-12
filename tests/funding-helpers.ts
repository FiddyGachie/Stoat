import { dispatch } from "./test-utils.js";
import { SEED_IDS } from "../src/db/seed.js";
import type { PayPalGateway } from "../src/modules/paypal/paypal.gateway.js";

export const BUYER = { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` };
export const PROVIDER = {
  Authorization: `Bearer agent:${SEED_IDS.providerAgentId}`,
};
export const USER = { Authorization: `Bearer user:${SEED_IDS.userId}` };

export const TRUNCATE_ALL = `
  TRUNCATE TABLE agreement_payments, reconciliation_records, webhook_events, payment_transactions,
                 settlement_batch_items, settlement_batches, approvals,
                 journal_lines, journal_transactions, obligations, verifications,
                 deliveries, artifacts, agreements, quotes, quote_requests, missions,
                 economic_events, idempotency_keys, policy_decisions,
                 wallet_refund_items, wallet_refunds, remainder_decisions, wallet_charges,
                 wallet_reservations, mission_funding, wallet_deposits, wallets,
                 notifications, reconciliation_exceptions, reconciliation_runs,
                 wallet_migration_report CASCADE;
`;

/** Mission -> quote -> accepted agreement, through the real HTTP routes. */
export async function acceptedAgreement(
  app: any,
  budget = "50.000000",
  serviceId: string = SEED_IDS.aiServiceId,
) {
  const mission = await dispatch(app, {
    method: "POST",
    url: "/missions",
    headers: BUYER,
    body: {
      title: `Funding Mission ${Date.now()}`,
      brief: "Review the fixture",
      budget,
      currency: "USD",
    },
  });
  const quote = await dispatch(app, {
    method: "POST",
    url: "/quotes",
    headers: BUYER,
    body: {
      mission_id: mission.body.id,
      service_id: serviceId,
      requested_scope: { files: ["src/auth.ts"] },
    },
  });
  const accept = await dispatch(app, {
    method: "POST",
    url: `/quotes/${quote.body.id}/accept`,
    headers: BUYER,
  });
  return accept;
}

export async function submitVerifiedDelivery(app: any, agreementId: string) {
  const artifact = await dispatch(app, {
    method: "POST",
    url: "/artifacts",
    headers: PROVIDER,
    body: {
      findings: [
        {
          file: "src/auth.ts",
          line_start: 4,
          line_end: 4,
          snippet:
            'const JWT_SECRET = "sk_live_insecure_hardcoded_secret_token_12345";',
          rule_id: "SEC-002",
          severity: "critical",
        },
      ],
    },
  });
  return dispatch(app, {
    method: "POST",
    url: "/deliveries",
    headers: PROVIDER,
    body: { agreement_id: agreementId, artifact_id: artifact.body.id },
  });
}

/**
 * TEST DOUBLE for PayPal's replies. It exists only in tests and is never wired into the app.
 * It lets us check what Stoat does with an order that PayPal has (hypothetically) approved,
 * captured, refunded or let lapse. It proves nothing about PayPal itself.
 */
export function stubPayPal(
  opts: {
    capturedAmount?: string;
    orderStatus?: "PAYER_ACTION_REQUIRED" | "APPROVED" | "COMPLETED" | "VOIDED";
    notFound?: boolean;
    webhookValid?: boolean;
    payoutItemStatus?: string;
    payoutSenderItemId?: string;
  } = {},
): PayPalGateway & { calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    environment: "sandbox",
    async createOrder(i) {
      calls.push("createOrder");
      return {
        id: `TESTORDER${++n}${i.customId.replace(/\W/g, "").slice(0, 12)}`,
        status: "PAYER_ACTION_REQUIRED",
        approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=TEST",
      };
    },
    async captureOrder(orderId) {
      calls.push("captureOrder");
      return {
        orderId,
        orderStatus: "COMPLETED",
        captureId: `TESTCAP${orderId}`,
        captureStatus: "COMPLETED",
        amount: opts.capturedAmount ?? "0.12",
        currency: "USD",
        customId: null,
      };
    },
    async getOrder(orderId) {
      calls.push("getOrder");
      if (opts.notFound) {
        const { PayPalApiError } =
          await import("../src/modules/paypal/paypal.gateway.js");
        throw new PayPalApiError("PAYPAL_REQUEST_REJECTED", "not found", 422, {
          paypal_status: 404,
        });
      }
      const s = opts.orderStatus ?? "PAYER_ACTION_REQUIRED";
      return {
        orderId,
        orderStatus: s,
        captureId: s === "COMPLETED" ? `TESTCAP${orderId}` : null,
        captureStatus: s === "COMPLETED" ? "COMPLETED" : null,
        amount: s === "COMPLETED" ? (opts.capturedAmount ?? "0.12") : null,
        currency: s === "COMPLETED" ? "USD" : null,
        customId: null,
      };
    },
    async getCapture(captureId) {
      calls.push("getCapture");
      return {
        orderId: "",
        orderStatus: "COMPLETED",
        captureId,
        captureStatus: "COMPLETED",
        amount: opts.capturedAmount ?? "0.12",
        currency: "USD",
        customId: null,
      };
    },
    async getRefund(refundId) {
      calls.push("getRefund");
      return {
        refundId,
        status: "COMPLETED",
        amount: null,
        currency: "USD",
        captureId: null,
      };
    },
    async refundCapture() {
      calls.push("refundCapture");
      return { refundId: "TESTREFUND", status: "COMPLETED" };
    },
    async createPayout(i) {
      calls.push("createPayout");
      return {
        batchId: "TESTPAYOUT" + i.senderBatchId.slice(-6),
        batchStatus: "PENDING",
        items: i.items.map((x) => ({
          senderItemId: x.senderItemId,
          itemId: "ITEM1",
          status: "PENDING",
          reason: null,
        })),
      };
    },
    async getPayout(batchId) {
      calls.push("getPayout");
      return {
        batchId,
        batchStatus: "SUCCESS",
        items: [
          {
            senderItemId: opts.payoutSenderItemId ?? "",
            itemId: "ITEM1",
            status: opts.payoutItemStatus ?? "SUCCESS",
            reason: null,
          },
        ],
      };
    },
    async verifyWebhook() {
      return opts.webhookValid ?? true;
    },
  };
}

/** Mission with an open quote on a service, through the real routes. Does not accept it. */
export async function openQuote(
  app: any,
  opts: { budget?: string; serviceId?: string } = {},
) {
  const mission = await dispatch(app, {
    method: "POST",
    url: "/missions",
    headers: BUYER,
    body: {
      title: `Negotiation Mission ${Date.now()}`,
      brief: "Review the fixture for security defects",
      budget: opts.budget ?? "50.000000",
      currency: "USD",
    },
  });
  const quote = await dispatch(app, {
    method: "POST",
    url: "/quotes",
    headers: BUYER,
    body: {
      mission_id: mission.body.id,
      service_id: opts.serviceId ?? SEED_IDS.aiServiceId,
      requested_scope: { files: ["src/auth.ts"] },
    },
  });
  return {
    missionId: mission.body.id as string,
    quoteId: quote.body.id as string,
  };
}
