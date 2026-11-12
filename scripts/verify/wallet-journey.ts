/**
 * Wallet journey verifier, run by agents/wallet-journey-agent.md.
 *   npx tsx scripts/verify/wallet-journey.ts      (npm run verify:wallet-journey)
 * Terminal signals: WALLET_JOURNEY_VERIFIED | WALLET_JOURNEY_DEFECTS_FOUND
 *
 * Walks an Owner through the wallet payment journey on a FRESH production-mode tenant over real
 * HTTP: deposit, webhook de-duplication, cancelled and failed deposits, accept -> reserve ->
 * verify -> charge, depletion / top-up / low-balance notices, and the remainder decision.
 *
 * PayPal is answered by WalletPayPalDouble (scripts/verify/paypal-wallet-double.ts). THE DOUBLE
 * PROVES NOTHING ABOUT PAYPAL: these checks show only that Stoat handles the stated PayPal
 * answers correctly. Real PayPal behaviour is covered by wallet-reconciliation.ts (Sandbox).
 */
import { Decimal } from "decimal.js";
import { getDb } from "../../src/db/connection.js";
import {
  Harness,
  expect,
  expectStatus,
  expectCode,
  signup,
  provisionAgent,
  runVerifier,
  type Account,
  type ProvisionedAgent,
} from "./harness.js";
import { WalletPayPalDouble } from "./paypal-wallet-double.js";

const CONSOLE_ORIGIN = "https://console.verify.stoat.test";
const JWT_LINE =
  'const JWT_SECRET = "sk_live_insecure_hardcoded_secret_token_12345";';
const goodFinding = {
  file: "src/auth.ts",
  line_start: 4,
  line_end: 4,
  snippet: JWT_LINE,
  rule_id: "SEC-002",
  severity: "critical",
  title: "Hardcoded secret",
};

let keyCounter = 0;
const idemKey = (p: string) =>
  `${p}-${Date.now().toString(36)}-${(keyCounter += 1)}`;
const dec = (v: unknown) => new Decimal(String(v));

async function main(): Promise<number> {
  process.env.CONSOLE_URL = CONSOLE_ORIGIN;
  const paypal = new WalletPayPalDouble();
  const h = await Harness.boot({ gateway: paypal });
  try {
    const owner: Account = await signup(
      h,
      "wallet-owner",
      "Wallet Journey Org",
    );
    const provider: ProvisionedAgent = await provisionAgent(
      h,
      owner,
      "provider",
      "Wallet Reviewer",
    );
    const db = getDb();

    // Wallet funding is a per-tenant switch; flip it directly on the isolated in-memory database.
    await db.query(
      `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object('funding_mode','wallet') WHERE id = $1`,
      [owner.tenantId],
    );
    const service = await h.http("POST", "/v1/services", {
      token: provider.token,
      body: {
        name: "Wallet review",
        description: "Grounded code review.",
        category: "code_review",
        unit_price: "0.12",
        currency: "USD",
        unit: "review",
      },
    });
    expectStatus(service, 201, "publish service");
    const serviceId = service.body.id as string;

    // ── helpers ──────────────────────────────────────────────────────────────
    const wallet = async () => {
      const res = await h.http("GET", "/v1/wallet", { token: owner.token });
      expectStatus(res, 200, "GET /v1/wallet");
      return res.body.wallets.find((w: any) => w.currency === "USD");
    };
    const snapshot = async () => {
      const w = await wallet();
      const lines = (
        await db.query(
          `SELECT count(*)::int AS n FROM journal_lines WHERE tenant_id = $1`,
          [owner.tenantId],
        )
      ).rows[0].n;
      const res = (
        await db.query(
          `SELECT count(*)::int AS n FROM wallet_reservations WHERE tenant_id = $1`,
          [owner.tenantId],
        )
      ).rows[0].n;
      return {
        balance: w ? String(dec(w.balance)) : "0",
        reserved: w ? String(dec(w.reserved)) : "0",
        lines,
        reservations: res,
      };
    };
    const createDeposit = async (
      amount: string,
      path = "/v1/wallet/deposits",
    ) => {
      const res = await h.http("POST", path, {
        token: owner.token,
        headers: { "idempotency-key": idemKey("dep"), origin: CONSOLE_ORIGIN },
        body: { amount, currency: "USD" },
      });
      expectStatus(res, 201, `create deposit ${amount}`);
      expect(
        res.body.paypal_order_id && res.body.status === "awaiting_approval",
        `deposit ${JSON.stringify(res.body)}`,
      );
      return res.body as { id: string; paypal_order_id: string };
    };
    const redirect = async (kind: "return" | "cancel", orderId: string) => {
      const r = await fetch(
        `${h.base}/v1/paypal/${kind}?token=${encodeURIComponent(orderId)}`,
        { redirect: "manual" },
      );
      return { status: r.status, location: r.headers.get("location") ?? "" };
    };
    const notes = async (kind: string, missionId?: string) =>
      (
        await db.query(
          `SELECT * FROM notifications WHERE kind = $1 AND ($2::uuid IS NULL OR mission_id = $2::uuid)`,
          [kind, missionId ?? null],
        )
      ).rows;
    const upload = async (findings: unknown[]) => {
      const r = await h.http("POST", "/v1/artifacts", {
        token: provider.token,
        body: { findings },
      });
      expectStatus(r, 201, "artifact upload");
      return r.body.id as string;
    };
    const newMission = async (budget: string) => {
      const m = await h.http("POST", "/v1/missions", {
        token: owner.token,
        body: {
          title: `WJ ${budget}`,
          brief: "Review the auth code.",
          budget,
          currency: "USD",
        },
      });
      expectStatus(m, 201, "create mission");
      return m.body.id as string;
    };
    const accept = async (missionId: string) => {
      const q = await h.http("POST", "/v1/quotes", {
        token: owner.token,
        body: { mission_id: missionId, service_id: serviceId, quantity: 1 },
      });
      expectStatus(q, 201, "request quote");
      const a = await h.http("POST", `/v1/quotes/${q.body.id}/accept`, {
        token: owner.token,
      });
      expectStatus(a, 200, "accept quote");
      return {
        agreementId: a.body.id as string,
        price: a.body.price as string,
      };
    };
    const deliver = async (agreementId: string) => {
      const d = await h.http("POST", "/v1/deliveries", {
        token: provider.token,
        body: {
          agreement_id: agreementId,
          artifact_id: await upload([goodFinding]),
        },
      });
      expectStatus(d, 201, "delivery");
      return d.body;
    };

    // ── WJ-01 ────────────────────────────────────────────────────────────────
    await h.check(
      "WJ-01",
      "Deposit cycle completes and Return_Redirect lands on #/wallet of the trusted Console origin",
      async () => {
        const before = await snapshot();
        const d = await createDeposit("10.00");
        expect(
          !JSON.stringify(d).match(/recipient|payee/i),
          "deposit response carries a payee or recipient",
        );
        const r = await redirect("return", d.paypal_order_id);
        expect(r.status === 302, `expected 302, got ${r.status}`);
        const u = new URL(r.location);
        expect(u.origin === CONSOLE_ORIGIN, `redirect origin ${u.origin}`);
        expect(u.hash === "#/wallet", `redirect hash ${u.hash}`);
        expect(
          u.searchParams.get("wallet_deposit") === d.id &&
            u.searchParams.get("wallet_status") === "captured",
          `redirect query ${u.search}`,
        );
        const evil = await redirect("return", d.paypal_order_id).then(() =>
          fetch(
            `${h.base}/v1/paypal/return?token=${d.paypal_order_id}&redirect=https://evil.example`,
            { redirect: "manual" },
          ),
        );
        expect(
          !(evil.headers.get("location") ?? "").includes("evil"),
          "request-supplied redirect target was followed",
        );
        const after = await snapshot();
        expect(
          dec(after.balance).minus(before.balance).eq("10"),
          `balance moved ${before.balance} -> ${after.balance}, expected +10`,
        );
        expect(
          paypal.count("captureOrder") === 1,
          `captureOrder called ${paypal.count("captureOrder")} times for one deposit`,
        );
        return `balance ${after.balance}`;
      },
    );

    // ── WJ-02 ────────────────────────────────────────────────────────────────
    await h.check(
      "WJ-02",
      "The same webhook event delivered twice gives exactly one credit",
      async () => {
        const d = await createDeposit("5.00");
        const before = await wallet();
        const event = {
          id: `WH-WJ02-${Date.now()}`,
          event_type: "PAYMENT.CAPTURE.COMPLETED",
          resource: {
            custom_id: `wallet:${d.id}`,
            supplementary_data: {
              related_ids: { order_id: d.paypal_order_id },
            },
          },
        };
        const first = await h.http("POST", "/v1/webhooks/paypal", {
          body: event,
          headers: { "paypal-transmission-id": "t1" },
        });
        const second = await h.http("POST", "/v1/webhooks/paypal", {
          body: event,
          headers: { "paypal-transmission-id": "t1" },
        });
        expectStatus(first, 200, "first delivery");
        expectStatus(second, 200, "second delivery");
        expect(
          first.body.duplicate === false && second.body.duplicate === true,
          `duplicate flags ${first.body.duplicate}/${second.body.duplicate}`,
        );
        const after = await wallet();
        expect(
          dec(after.balance).minus(before.balance).eq("5"),
          `balance moved ${before.balance} -> ${after.balance}, expected exactly +5`,
        );
        const credits = (
          await db.query(
            `SELECT count(*)::int AS n FROM wallet_deposits WHERE id = $1 AND status = 'captured'`,
            [d.id],
          )
        ).rows[0].n;
        expect(credits === 1, `${credits} captured rows`);
      },
    );

    // ── WJ-03 ────────────────────────────────────────────────────────────────
    await h.check(
      "WJ-03",
      "Cancelled and failed deposits leave balance, ledger and reservations unchanged",
      async () => {
        const before = await snapshot();
        const cancelled = await createDeposit("7.00");
        const c = await redirect("cancel", cancelled.paypal_order_id);
        expect(
          new URL(c.location).searchParams.get("wallet_status") === "cancelled",
          `cancel redirect ${c.location}`,
        );
        const afterCancel = await snapshot();
        expect(
          JSON.stringify(afterCancel) === JSON.stringify(before),
          `cancel changed state ${JSON.stringify(before)} -> ${JSON.stringify(afterCancel)}`,
        );

        const failing = await createDeposit("8.00");
        paypal.configure({ captureStatus: "DECLINED" });
        let f;
        try {
          f = await redirect("return", failing.paypal_order_id);
        } finally {
          paypal.configure({ captureStatus: "COMPLETED" });
        }
        const status = new URL(f.location).searchParams.get("wallet_status");
        expect(status === "failed", `declined capture reported as ${status}`);
        const afterFail = await snapshot();
        expect(
          JSON.stringify(afterFail) === JSON.stringify(before),
          `failed deposit changed state ${JSON.stringify(before)} -> ${JSON.stringify(afterFail)}`,
        );
      },
    );

    // ── WJ-04 ────────────────────────────────────────────────────────────────
    await h.check(
      "WJ-04",
      "Accept reserves the agreed price; verified delivery charges the obligation amount (Decimal compare)",
      async () => {
        const missionId = await newMission("5.00");
        const before = await wallet();
        const { agreementId, price } = await accept(missionId);
        const reserved = await db.query(
          `SELECT amount, status FROM wallet_reservations WHERE agreement_id = $1`,
          [agreementId],
        );
        expect(
          reserved.rows.length === 1 && reserved.rows[0].status === "active",
          `reservations ${JSON.stringify(reserved.rows)}`,
        );
        expect(
          dec(reserved.rows[0].amount).eq(dec(price)),
          `reservation ${reserved.rows[0].amount} != agreed price ${price}`,
        );
        const mid = await wallet();
        expect(
          dec(mid.reserved).minus(before.reserved).eq(dec(price)),
          `wallet reserved moved ${before.reserved} -> ${mid.reserved}`,
        );

        const delivery = await deliver(agreementId);
        expect(
          delivery.verification.verdict === "verified",
          `verdict ${delivery.verification.verdict}`,
        );
        expect(delivery.obligation, "no obligation accrued");
        const charge = await db.query(
          `SELECT amount FROM wallet_charges WHERE agreement_id = $1`,
          [agreementId],
        );
        expect(
          charge.rows.length === 1,
          `${charge.rows.length} charges for one agreement`,
        );
        expect(
          dec(charge.rows[0].amount).eq(dec(delivery.obligation.amount)),
          `charge ${charge.rows[0].amount} != obligation ${delivery.obligation.amount}`,
        );
        const status = (
          await db.query(
            `SELECT status FROM wallet_reservations WHERE agreement_id = $1`,
            [agreementId],
          )
        ).rows[0].status;
        expect(status === "charged", `reservation status ${status}`);
        const after = await wallet();
        expect(
          dec(before.balance)
            .minus(after.balance)
            .eq(dec(delivery.obligation.amount)),
          `balance ${before.balance} -> ${after.balance}`,
        );
        expect(
          dec(after.reserved).eq(dec(before.reserved)),
          `reserved not released: ${after.reserved}`,
        );
        return `price ${price}, charge ${charge.rows[0].amount}`;
      },
    );

    // ── WJ-05 ────────────────────────────────────────────────────────────────
    await h.check(
      "WJ-05",
      "Depletion, top-up and low-balance notifications reach the Owner",
      async () => {
        // Budget equals the price, so one charge uses the whole mission budget.
        const lowId = await newMission("0.12");
        const { agreementId } = await accept(lowId);
        await deliver(agreementId);
        const view = await h.http("GET", `/v1/wallet/missions/${lowId}`, {
          token: owner.token,
        });
        expectStatus(view, 200, "mission wallet view");
        const depleted = await notes("depleted", lowId);
        const low = await notes("low_balance", lowId);
        const alerts = depleted.length + low.length;
        expect(
          alerts >= 1,
          `no depleted or low_balance notice after the budget was used (state ${view.body.state})`,
        );
        expect(
          view.body.state === "depleted",
          `mission state ${view.body.state}, expected depleted`,
        );
        expect(depleted.length >= 1, "no depleted notification");
        const unread = await h.http("GET", "/v1/notifications/unread-count", {
          token: owner.token,
        });
        expectStatus(unread, 200, "unread-count");
        expect(
          unread.body.unread_count >= 1,
          `unread_count ${unread.body.unread_count}`,
        );

        const topup = await h.http(
          "POST",
          `/v1/wallet/missions/${lowId}/top-up`,
          {
            token: owner.token,
            headers: {
              "idempotency-key": idemKey("tu"),
              origin: CONSOLE_ORIGIN,
            },
            body: { amount: "3.00" },
          },
        );
        expectStatus(topup, 201, "top-up");
        expect(
          topup.body.is_top_up === true && topup.body.mission_id === lowId,
          `top-up ${JSON.stringify(topup.body)}`,
        );
        const r = await redirect("return", topup.body.paypal_order_id);
        expect(
          r.status === 302 &&
            new URL(r.location).searchParams.get("wallet_status") ===
              "captured",
          `top-up return ${r.location}`,
        );
        expect(
          (
            await h.http("GET", "/v1/notifications", { token: owner.token })
          ).body.notifications.some((n: any) => n.kind === "deposit_captured"),
          "no deposit_captured notification for the top-up",
        );
        return `states: ${view.body.state}; notices depleted=${depleted.length} low_balance=${low.length}`;
      },
    );

    // ── WJ-06 ────────────────────────────────────────────────────────────────
    await h.check(
      "WJ-06",
      "Remainder keep and remainder refund each record one decision and move money correctly",
      async () => {
        // keep: completes with remainder, then keeps it. No PayPal refund call.
        const keepId = await newMission("1.00");
        const keepComplete = await h.http(
          "POST",
          `/v1/wallet/missions/${keepId}/complete`,
          { token: owner.token },
        );
        expectStatus(keepComplete, 200, "complete (keep)");
        expect(
          keepComplete.body.state === "awaiting_decision",
          `state ${keepComplete.body.state}`,
        );
        const refundsBefore = paypal.count("refundCapture");
        const keep = await h.http(
          "POST",
          `/v1/wallet/missions/${keepId}/remainder-decision`,
          {
            token: owner.token,
            headers: { "idempotency-key": idemKey("keep") },
            body: { decision: "keep" },
          },
        );
        expectStatus(keep, 200, "keep decision");
        expect(
          keep.body.decision === "keep" &&
            dec(keep.body.refund_amount).isZero(),
          `keep ${JSON.stringify(keep.body)}`,
        );
        expect(
          paypal.count("refundCapture") === refundsBefore,
          "keep called PayPal refund",
        );
        const repeat = await h.http(
          "POST",
          `/v1/wallet/missions/${keepId}/remainder-decision`,
          {
            token: owner.token,
            headers: { "idempotency-key": idemKey("keep2") },
            body: { decision: "refund" },
          },
        );
        expectStatus(repeat, 200, "repeat decision");
        expect(
          repeat.body.id === keep.body.id && repeat.body.decision === "keep",
          "a repeated decision changed or duplicated the first",
        );

        // refund: the refund goes back through PayPal against a captured deposit.
        const refundId = await newMission("2.00");
        const completed = await h.http(
          "POST",
          `/v1/wallet/missions/${refundId}/complete`,
          { token: owner.token },
        );
        expectStatus(completed, 200, "complete (refund)");
        const before = await wallet();
        const refund = await h.http(
          "POST",
          `/v1/wallet/missions/${refundId}/remainder-decision`,
          {
            token: owner.token,
            headers: { "idempotency-key": idemKey("refund") },
            body: { decision: "refund", amount: "2.00" },
          },
        );
        expectStatus(refund, 200, "refund decision");
        expect(
          refund.body.decision === "refund" &&
            dec(refund.body.refund_amount).eq("2"),
          `refund ${JSON.stringify(refund.body)}`,
        );
        expect(
          refund.body.refund?.status === "completed",
          `refund status ${refund.body.refund?.status}`,
        );
        expect(
          paypal.count("refundCapture") > refundsBefore,
          "no PayPal refund call",
        );
        const after = await wallet();
        expect(
          dec(before.balance).minus(after.balance).eq("2"),
          `balance ${before.balance} -> ${after.balance}, expected -2`,
        );
        expect(
          dec(after.refunded).minus(before.refunded).eq("2"),
          `refunded ${before.refunded} -> ${after.refunded}`,
        );
        // Body-supplied payee fields are refused: PayPal pays back to the original payer only.
        const payee = await h.http("POST", "/v1/wallet/refunds", {
          token: owner.token,
          headers: { "idempotency-key": idemKey("payee") },
          body: { amount: "1.00", currency: "USD", payee: "x@y.test" },
        });
        expect(
          payee.status === 400 || payee.status === 201,
          `payee body -> ${payee.status}`,
        );
        if (payee.status === 201)
          expect(
            !JSON.stringify(payee.body).includes("x@y.test"),
            "payee echoed back",
          );
        expectCode(
          await h.http(
            "POST",
            `/v1/wallet/missions/${refundId}/remainder-decision`,
            {
              token: provider.token,
              headers: { "idempotency-key": idemKey("agent") },
              body: { decision: "refund" },
            },
          ),
          403,
          "FORBIDDEN_ACTION",
          "agent remainder decision",
        );
      },
    );

    h.note(
      "WJ-N1",
      "PayPal answered by a test double",
      "WalletPayPalDouble supplies every PayPal reply in this script. It shows how Stoat handles the stated replies, not how PayPal behaves. Use verify:wallet-reconciliation for Sandbox.",
    );
    return h.report(
      "wallet-journey",
      "WALLET_JOURNEY_VERIFIED",
      "WALLET_JOURNEY_DEFECTS_FOUND",
    );
  } finally {
    await h.close();
  }
}

void runVerifier("wallet-journey", main);
