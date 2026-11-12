/**
 * PayPal Sandbox verifier (checks WR-01 .. WR-10), run by agents/wallet-reconciliation-agent.md.
 *   npx tsx scripts/verify/wallet-reconciliation.ts                 create one real Sandbox order, stop at MANUAL approval
 *   npx tsx scripts/verify/wallet-reconciliation.ts --order <id>    verify capture, credit, refund and reconciliation
 * Terminal signals: WALLET_RECONCILIATION_VERIFIED | WALLET_RECONCILIATION_AWAITING_MANUAL | WALLET_RECONCILIATION_BLOCKED
 *
 * THIS SCRIPT USES NO TEST DOUBLE. Every PayPal call goes through the real gateway to the
 * PayPal Sandbox. Only the database is scratch (embedded PGlite via resetDb); production data is
 * never touched.
 *
 * Rules:
 *  - No PayPal credentials, or a non-Sandbox base URL: nothing is called, no order is created,
 *    and every check is recorded as FAIL "could not complete: ..." (never PASS, never skipped).
 *  - Approving a PayPal order needs a person in the Sandbox buyer account. That step is reported
 *    as MANUAL and is never simulated. Checks that depend on it stay MANUAL until it is done.
 *  - With --order <id>, the order (created by an earlier run of this script) is adopted into the
 *    scratch database under its original custom_id, so the product's own capture path runs
 *    against the real order. The amount, capture ID and status that count are PayPal's.
 *  - --order moves Sandbox money (capture, then a 1.00 refund). A person supplies it; an agent
 *    must never choose to pass it (Money Boundary).
 */
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import {
  Harness,
  STRONG_PASSWORD,
  expect,
  expectStatus,
  runVerifier,
  signup,
  uniqueEmail,
} from "./harness.js";

const AGENT = "wallet-reconciliation";
const DEPOSIT_AMOUNT = "5.00";
const REFUND_AMOUNT = "1.00";
const CURRENCY = "USD";

const CHECKS: Array<[string, string]> = [
  ["WR-01", "PayPal Sandbox credentials are configured"],
  ["WR-02", "The configured PayPal environment is Sandbox, never Live"],
  ["WR-03", "PayPal Sandbox issues an OAuth token to the configured app"],
  ["WR-04", "A deposit order exists at PayPal and is readable"],
  ["WR-05", "The buyer approved the order at PayPal"],
  ["WR-06", "Capture is COMPLETED at PayPal and Stoat credits exactly that amount"],
  ["WR-07", "PayPal's capture amount and currency equal the deposit's"],
  ["WR-08", "A partial refund completes at PayPal and debits the wallet"],
  ["WR-09", "A reconciliation run compares Stoat to PayPal and finds it clean"],
  ["WR-10", "Reconciliation changed no balance and the trial balance is zero"],
];

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Record every check from `fromId` onward as FAIL: it could not complete. Never PASS or skipped. */
function couldNot(h: Harness, fromId: string, reason: string): void {
  let on = false;
  for (const [id, name] of CHECKS) {
    if (id === fromId) on = true;
    if (on && !h.checks.some((c) => c.id === id)) {
      h.checks.push({ id, name, status: "FAIL", evidence: `could not complete: ${reason}` });
    }
  }
}

/** Record every check from `fromId` onward as MANUAL because a person must act first. */
function pendingManual(h: Harness, fromId: string, reason: string): void {
  let on = false;
  for (const [id, name] of CHECKS) {
    if (id === fromId) on = true;
    if (on && !h.checks.some((c) => c.id === id)) h.manual(id, name, reason);
  }
}

const nameOf = (id: string) => CHECKS.find(([i]) => i === id)![1];
const dec = (v: unknown) => new Decimal(String(v));

async function main(): Promise<number> {
  const h = await Harness.boot(); // real gateway: no double
  const orderArg = argValue("--order");
  let manualPending = false;
  try {
    const { readPayPalConfig, fetchPayPalToken, getPayPalGateway } = await import(
      "../../src/modules/paypal/paypal.gateway.js"
    );
    const cfg = readPayPalConfig();

    // WR-01 / WR-02: refuse without credentials or against Live, before any PayPal call.
    await h.check("WR-01", nameOf("WR-01"), async () => {
      expect(cfg, "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set; nothing was called and no order was created");
      return "client id and secret present (values not printed)";
    });
    if (!cfg) {
      couldNot(h, "WR-02", "no PayPal credentials");
      return finish(h, manualPending);
    }
    await h.check("WR-02", nameOf("WR-02"), async () => {
      const host = new URL(cfg.baseUrl).hostname;
      expect(/(^|\.)sandbox\.paypal\.com$/i.test(host), `PAYPAL_BASE_URL host ${host} is not a Sandbox host; refusing to run`);
      expect(getPayPalGateway().environment === "sandbox", "gateway reports a non-sandbox environment");
      return `Sandbox host ${host}`;
    });
    if (h.checks.some((c) => c.id === "WR-02" && c.status !== "PASS")) {
      couldNot(h, "WR-03", "not a Sandbox environment; no PayPal call was made and no order was created");
      return finish(h, manualPending);
    }
    await h.checkWithin("WR-03", nameOf("WR-03"), 20_000, async () => {
      const t = await fetchPayPalToken(cfg);
      expect(t.accessToken.length > 0, "empty token");
      return `token issued, expires in ${t.expiresIn}s`;
    });
    if (h.checks.some((c) => c.id === "WR-03" && c.status !== "PASS")) {
      couldNot(h, "WR-04", "PayPal Sandbox did not accept the credentials or was unreachable");
      return finish(h, manualPending);
    }

    // Scratch fixtures: one tenant, an Owner, an operator, wallet mode.
    const { getDb } = await import("../../src/db/connection.js");
    const { AuthService } = await import("../../src/modules/auth/auth.service.js");
    const { getOrCreateWallet } = await import("../../src/modules/wallet/wallet.service.js");
    const { depositRequestHash, deriveDepositRequestId } = await import("../../src/modules/wallet/wallet-math.js");
    const db = getDb();
    const gateway = getPayPalGateway();
    const owner = await signup(h, "WR-owner", "PayPal Sandbox Org");
    await db.query(
      `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object('funding_mode','wallet') WHERE id = $1`,
      [owner.tenantId],
    );
    const adminEmail = uniqueEmail("WR-admin");
    await new AuthService(db).createOperator({ email: adminEmail, password: STRONG_PASSWORD, tenantId: owner.tenantId });
    const adminLogin = await h.http("POST", "/v1/auth/login", { body: { email: adminEmail, password: STRONG_PASSWORD } });
    expectStatus(adminLogin, 200, "operator login");
    const adminToken: string = adminLogin.body.access_token;
    const key = () => ({ "idempotency-key": `WR-${randomUUID()}` });

    let orderId = orderArg ?? "";
    let depositId = "";

    if (!orderArg) {
      // WR-04: create one real Sandbox order through the product's own deposit route.
      await h.checkWithin("WR-04", nameOf("WR-04"), 60_000, async () => {
        const res = await h.http("POST", "/v1/wallet/deposits", {
          token: owner.token,
          headers: key(),
          body: { amount: DEPOSIT_AMOUNT, currency: CURRENCY },
        });
        expectStatus(res, 201, "create deposit");
        expect(res.body.status === "awaiting_approval" && res.body.paypal_order_id && res.body.approve_url, `deposit not awaiting approval: ${JSON.stringify(res.body).slice(0, 200)}`);
        orderId = res.body.paypal_order_id;
        const read = await gateway.getOrder(orderId);
        expect(read.orderStatus.toUpperCase() === "CREATED" || read.orderStatus.toUpperCase() === "PAYER_ACTION_REQUIRED", `PayPal reports order ${orderId} as ${read.orderStatus}`);
        expect(read.customId === `wallet:${res.body.id}`, "PayPal custom_id does not match the deposit");
        h.note("WR-04a", "Approval link (open in the Sandbox buyer account)", String(res.body.approve_url));
        return `order ${orderId} created at PayPal Sandbox, status ${read.orderStatus}`;
      });
      if (h.checks.some((c) => c.id === "WR-04" && c.status !== "PASS")) {
        couldNot(h, "WR-05", "no order could be created");
        return finish(h, manualPending);
      }
      h.manual(
        "WR-05",
        nameOf("WR-05"),
        `MANUAL: a person must approve order ${orderId} with a Sandbox buyer account using the approval link above. ` +
          `Then run: npx tsx scripts/verify/wallet-reconciliation.ts --order ${orderId}`,
      );
      manualPending = true;
      pendingManual(h, "WR-06", `waiting for approval of order ${orderId}; not run, not passed`);
      return finish(h, manualPending);
    }

    // --order <id>: read the real order first.
    let adopted: { amount: string; customDepositId: string } | null = null;
    await h.checkWithin("WR-04", nameOf("WR-04"), 60_000, async () => {
      const read = await gateway.getOrder(orderId);
      const m = /^wallet:([0-9a-f-]{36})$/i.exec(read.customId ?? "");
      expect(m, `order ${orderId} has no Stoat wallet custom_id; it was not created by this verifier`);
      adopted = { amount: read.amount ?? DEPOSIT_AMOUNT, customDepositId: m![1] };
      return `order ${orderId} readable at PayPal, status ${read.orderStatus}`;
    });
    if (!adopted) {
      couldNot(h, "WR-05", "the order could not be read from PayPal");
      return finish(h, manualPending);
    }
    const adoption = adopted as { amount: string; customDepositId: string };

    await h.checkWithin("WR-05", nameOf("WR-05"), 60_000, async () => {
      const read = await gateway.getOrder(orderId);
      const s = read.orderStatus.toUpperCase();
      expect(s === "APPROVED" || s === "COMPLETED", `PENDING_MANUAL:${s}`);
      return `PayPal reports the order ${s}`;
    });
    const wr05 = h.checks.find((c) => c.id === "WR-05")!;
    if (wr05.status === "FAIL" && wr05.evidence.startsWith("PENDING_MANUAL:")) {
      h.checks.splice(h.checks.indexOf(wr05), 1);
      h.manual("WR-05", nameOf("WR-05"), `MANUAL: PayPal reports the order as ${wr05.evidence.split(":")[1]}. A person must approve it in the Sandbox buyer account, then re-run with --order ${orderId}.`);
      manualPending = true;
      pendingManual(h, "WR-06", "waiting for buyer approval; not run, not passed");
      return finish(h, manualPending);
    }
    if (wr05.status !== "PASS") {
      couldNot(h, "WR-06", "approval state could not be read");
      return finish(h, manualPending);
    }

    // Adopt the real order into the scratch DB under its original custom_id.
    const wallet = await getOrCreateWallet(db, { tenantId: owner.tenantId, ownerUserId: owner.userId, currency: CURRENCY, environment: "sandbox" });
    depositId = adoption.customDepositId;
    const idemKey = `adopted-${orderId}`;
    await db.query(
      `INSERT INTO wallet_deposits
         (id, tenant_id, wallet_id, owner_user_id, mission_id, is_top_up, provider, amount, currency,
          status, idempotency_key, request_hash, paypal_request_id, paypal_environment, paypal_order_id)
       VALUES ($1,$2,$3,$4,NULL,false,'paypal',$5,$6,'awaiting_approval',$7,$8,$9,'sandbox',$10)`,
      [
        depositId, owner.tenantId, wallet.id, owner.userId, adoption.amount, CURRENCY, idemKey,
        depositRequestHash(adoption.amount, CURRENCY, null),
        deriveDepositRequestId(owner.tenantId, owner.userId, idemKey),
        orderId,
      ],
    );

    const balance = async (): Promise<Decimal> => {
      const res = await h.http("GET", "/v1/wallet", { token: owner.token });
      expectStatus(res, 200, "GET /v1/wallet");
      const w = res.body.wallets.find((x: any) => x.currency === CURRENCY);
      return dec(w?.balance ?? "0");
    };

    let captureId = "";
    let paypalAmount = "";
    await h.checkWithin("WR-06", nameOf("WR-06"), 90_000, async () => {
      const before = await balance();
      const res = await h.http("POST", `/v1/wallet/deposits/${depositId}/refresh`, { token: owner.token, headers: key() });
      expectStatus(res, 200, "refresh deposit (product capture path)");
      expect(res.body.status === "captured", `deposit is ${res.body.status} (${res.body.failure_reason ?? "no reason"}), expected captured`);
      const row = (await db.query(`SELECT paypal_capture_id FROM wallet_deposits WHERE id = $1`, [depositId])).rows[0];
      captureId = row?.paypal_capture_id ?? "";
      expect(captureId, "no PayPal capture ID stored");
      const cap = await gateway.getCapture(captureId); // fresh read from PayPal
      expect(String(cap.captureStatus).toUpperCase() === "COMPLETED", `PayPal capture ${captureId} is ${cap.captureStatus}`);
      paypalAmount = String(cap.amount);
      const credited = dec(res.body.credited_amount);
      expect(credited.eq(dec(paypalAmount)), `credited ${credited} != PayPal capture ${paypalAmount}`);
      const after = await balance();
      expect(after.minus(before).eq(dec(paypalAmount)), `wallet moved by ${after.minus(before)}, PayPal captured ${paypalAmount}`);
      return `capture ${captureId} COMPLETED at PayPal for ${paypalAmount}; wallet credited ${credited}`;
    });
    if (h.checks.some((c) => c.id === "WR-06" && c.status !== "PASS")) {
      couldNot(h, "WR-07", "capture did not complete");
      return finish(h, manualPending);
    }

    await h.checkWithin("WR-07", nameOf("WR-07"), 60_000, async () => {
      const cap = await gateway.getCapture(captureId);
      const d = (await db.query(`SELECT amount, currency FROM wallet_deposits WHERE id = $1`, [depositId])).rows[0];
      expect(cap.currency === d.currency, `currency PayPal ${cap.currency} vs Stoat ${d.currency}`);
      expect(dec(cap.amount).eq(dec(d.amount)), `amount PayPal ${cap.amount} vs Stoat ${d.amount}`);
      return `PayPal ${cap.amount} ${cap.currency} equals Stoat ${d.amount} ${d.currency}`;
    });

    let balanceAfterRefund = new Decimal(0);
    await h.checkWithin("WR-08", nameOf("WR-08"), 90_000, async () => {
      const before = await balance();
      const res = await h.http("POST", "/v1/wallet/refunds", {
        token: owner.token,
        headers: key(),
        body: { amount: REFUND_AMOUNT, currency: CURRENCY },
      });
      expectStatus(res, 201, "owner refund");
      const item = res.body.items?.[0];
      expect(res.body.status === "completed", `refund is ${res.body.status} (item ${item?.paypal_status ?? "?"}), expected completed`);
      expect(item?.paypal_refund_id, "no PayPal refund ID stored");
      const r = await gateway.getRefund(item.paypal_refund_id); // fresh read from PayPal
      expect(String(r.status).toUpperCase() === "COMPLETED", `PayPal refund ${r.refundId} is ${r.status}`);
      expect(dec(r.amount).eq(dec(REFUND_AMOUNT)) && r.currency === CURRENCY, `PayPal refunded ${r.amount} ${r.currency}`);
      balanceAfterRefund = await balance();
      expect(before.minus(balanceAfterRefund).eq(dec(REFUND_AMOUNT)), `wallet fell by ${before.minus(balanceAfterRefund)}, expected ${REFUND_AMOUNT}`);
      return `refund ${r.refundId} COMPLETED at PayPal for ${r.amount}; wallet debited ${REFUND_AMOUNT}`;
    });

    let runBody: any = null;
    await h.checkWithin("WR-09", nameOf("WR-09"), 180_000, async () => {
      const res = await h.http("POST", "/v1/admin/reconciliation/runs", { token: adminToken });
      expectStatus(res, 201, "start reconciliation run");
      runBody = res.body;
      expect(res.body.status === "clean", `run status ${res.body.status}, counts ${JSON.stringify(res.body.counts)}, exceptions ${JSON.stringify(res.body.exceptions ?? []).slice(0, 300)}`);
      expect(res.body.counts.captures >= 1, `run compared ${res.body.counts.captures} captures, expected at least 1`);
      expect(res.body.counts.refunds >= 1, `run compared ${res.body.counts.refunds} refunds, expected at least 1`);
      const t = res.body.totals?.[CURRENCY];
      expect(t && dec(t.captures.stoat).eq(dec(t.captures.paypal)) && dec(t.refunds.stoat).eq(dec(t.refunds.paypal)), `totals differ: ${JSON.stringify(t)}`);
      return `clean: ${res.body.counts.captures} capture(s), ${res.body.counts.refunds} refund(s) match PayPal`;
    });

    await h.check("WR-10", nameOf("WR-10"), async () => {
      expect(runBody, "no reconciliation run to inspect (WR-09 did not complete)");
      const after = await balance();
      expect(after.eq(balanceAfterRefund), `wallet balance moved from ${balanceAfterRefund} to ${after} during reconciliation`);
      const bad = (runBody.trial_balance ?? []).filter((t: any) => !t.balanced);
      expect(bad.length === 0, `trial balance not zero: ${JSON.stringify(bad)}`);
      return `balance unchanged at ${after}; trial balance zero for ${(runBody.trial_balance ?? []).length} currency(ies)`;
    });
    return finish(h, manualPending);
  } finally {
    await h.close();
  }
}

function finish(h: Harness, manualPending: boolean): number {
  return h.report(AGENT, manualPending ? "WALLET_RECONCILIATION_AWAITING_MANUAL" : "WALLET_RECONCILIATION_VERIFIED", "WALLET_RECONCILIATION_BLOCKED");
}

void runVerifier(AGENT, main);
