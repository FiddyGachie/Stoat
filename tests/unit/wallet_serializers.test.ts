// Task 8.11: allowlist serializers and the standing Admin-money-route check (R4.6, R4.11-4.14, R12.11).
import { describe, it, expect } from "vitest";
import {
  SensitiveKeyError,
  assertNoSensitiveKeys,
  serializeAdminWallet,
  serializeAnalyticsRow,
  serializeDeposit,
  serializeNotification,
  serializeRefund,
  serializeStatementLine,
  serializeWallet,
} from "../../src/modules/wallet/wallet-serializers.js";
import { createApp } from "../../src/api/app.js";

const LEAK = {
  recipient: "a@b.test",
  payee: "p",
  payout_recipient: "x@y.test",
  payment_source: { card: "4111" },
  api_token: "t",
  client_secret: "s",
  recipient_user_id: "u",
};
const bal = {
  balance: "5",
  reserved: "1",
  pendingRefund: "0",
  available: "4",
  deposited: "5",
  charged: "0",
  refunded: "0",
};

describe("wallet serializers", () => {
  it("drops unknown and sensitive columns", () => {
    const now = new Date();
    const views = [
      serializeWallet(
        {
          id: "w",
          currency: "USD",
          status: "active",
          paypal_environment: "sandbox",
          ...LEAK,
        },
        bal,
        "wallet",
      ),
      serializeDeposit({
        id: "d",
        wallet_id: "w",
        status: "captured",
        amount: "1",
        currency: "USD",
        paypal_environment: "sandbox",
        created_at: now,
        ...LEAK,
      }),
      serializeRefund({
        id: "r",
        wallet_id: "w",
        kind: "admin",
        amount: "1",
        currency: "USD",
        status: "planned",
        actor_user_id: "u",
        actor_role: "operator",
        paypal_environment: "sandbox",
        created_at: now,
        updated_at: now,
        ...LEAK,
      }),
      serializeNotification({
        id: "n",
        kind: "topped_up",
        title: "t",
        body: "b",
        created_at: now,
        ...LEAK,
      }),
      serializeStatementLine({
        wallet_id: "w",
        kind: "deposit",
        amount: "1",
        currency: "USD",
        occurred_at: now,
        ...LEAK,
      }),
      serializeAdminWallet(
        {
          id: "w",
          owner_user_id: "u",
          currency: "USD",
          status: "active",
          paypal_environment: "sandbox",
          ...LEAK,
        },
        bal,
      ),
      serializeAnalyticsRow(
        { day: now, amount: "2", ...LEAK },
        ["day", "amount"],
        ["amount"],
      ),
    ];
    for (const v of views) {
      expect(() => assertNoSensitiveKeys(v)).not.toThrow();
      expect(JSON.stringify(v)).not.toMatch(
        /recipient|payee|payment_source|secret|token|a@b\.test|4111/i,
      );
    }
  });

  it("deep check rejects a sensitive key at any depth", () => {
    expect(() =>
      assertNoSensitiveKeys({ a: [{ b: { payout_recipient: 1 } }] }),
    ).toThrow(SensitiveKeyError);
    expect(() => assertNoSensitiveKeys({ a: { Payee: 1 } })).toThrow(
      SensitiveKeyError,
    );
    expect(() => assertNoSensitiveKeys({ a: { paymentSource: 1 } })).toThrow(
      SensitiveKeyError,
    );
    expect(() =>
      assertNoSensitiveKeys({ amount: "1", paypal_order_id: "o" }),
    ).not.toThrow();
  });
});

describe("standing check: Admins have no wallet money route except the Admin refund route", () => {
  it("only POST /v1/admin/wallets/:walletId/refunds is an admin route that moves money", () => {
    const app: any = createApp();
    const stack: any[] = app._router?.stack ?? [];
    const routes: string[] = [];
    const walk = (layers: any[]) => {
      for (const l of layers) {
        if (l.route) {
          for (const m of Object.keys(l.route.methods))
            routes.push(`${m.toUpperCase()} ${l.route.path}`);
        } else if (l.handle?.stack) walk(l.handle.stack);
      }
    };
    walk(stack);
    const wallet = routes.filter((r) => /\/(admin\/)?wallets?\b/.test(r));
    expect(wallet.length).toBeGreaterThan(0);
    const moneyVerb = /reserv|charge|refund|payout/i;
    const adminMoney = wallet.filter(
      (r) => r.includes("/admin/") && r.startsWith("POST") && moneyVerb.test(r),
    );
    const allowed = new Set(["POST /v1/admin/wallets/:walletId/refunds"]);
    for (const r of adminMoney) expect(allowed.has(r), r).toBe(true);
    // Owner-scoped wallet routes never carry a recipient or payout path.
    for (const r of wallet)
      expect(r).not.toMatch(/recipient|payee|payout-account/i);
  });
});
