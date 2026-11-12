// Task 10.1: tenant funding mode (R17.3, R17.4).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { TRUNCATE_ALL, acceptedAgreement, USER } from "../funding-helpers.js";
import { dispatch } from "../test-utils.js";
import {
  getFundingMode,
  defaultFundingMode,
  seedFundingMode,
} from "../../src/modules/wallet/funding-mode.js";
import {
  walletCurrencies,
  walletMaxDeposit,
  walletLowBalancePct,
  paypalRefundWindowDays,
  walletDepositTtlMs,
  walletSweepRefundMs,
  walletReconcileIntervalMs,
} from "../../src/modules/wallet/wallet-config.js";

const T = SEED_IDS.tenantId;
const db = () => getDb();
const BUYER_USER = randomUUID();
const put = (headers: Record<string, string>, body: unknown) =>
  dispatch(createdApp, {
    method: "PUT",
    url: "/v1/admin/funding-mode",
    headers,
    body: body as any,
  });
let createdApp: any;

describe("tenant funding mode", () => {
  beforeAll(async () => {
    await resetDb();
    await runMigrations(db());
    await seedDatabase(db());
    createdApp = createApp({ gateway: new WalletPayPalDouble() });
  });
  afterAll(async () => {
    await closeDb();
  });
  beforeEach(async () => {
    await db().query(TRUNCATE_ALL);
    await db().query(
      `UPDATE tenants SET settings = settings - 'funding_mode' WHERE id = $1`,
      [T],
    );
    await db().query(
      `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, 'fm-buyer@x.test', 'buyer') ON CONFLICT (id) DO NOTHING`,
      [BUYER_USER, T],
    );
  });

  it("defaults to direct when the setting is absent", async () => {
    expect(await getFundingMode(db(), T)).toBe("direct");
  });

  it("operator switches to wallet and back; the change is audited", async () => {
    const r = await put(USER, { funding_mode: "wallet" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      funding_mode: "wallet",
      previous: "direct",
      changed: true,
    });
    expect(await getFundingMode(db(), T)).toBe("wallet");
    const again = await put(USER, { funding_mode: "wallet" });
    expect(again.body.changed).toBe(false);
    const back = await put(USER, { funding_mode: "direct" });
    expect(back.body.funding_mode).toBe("direct");
    const audit = await db().query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'admin.funding_mode.set' AND tenant_id = $1`,
      [T],
    );
    expect((audit.rows[0] as any).n).toBe(2);
    const get = await dispatch(createdApp, {
      method: "GET",
      url: "/v1/admin/funding-mode",
      headers: USER,
    });
    expect(get.body.funding_mode).toBe("direct");
  });

  it("rejects invalid modes", async () => {
    const r = await put(USER, { funding_mode: "crypto" });
    expect(r.status).toBe(400);
    expect(await getFundingMode(db(), T)).toBe("direct");
  });

  it("refuses buyers, agents and anonymous callers", async () => {
    for (const headers of <Record<string, string>[]>[
      { authorization: `Bearer user:${BUYER_USER}` },
      { authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      {},
    ]) {
      const r = await put(headers, { funding_mode: "wallet" });
      expect([401, 403]).toContain(r.status);
    }
    expect(await getFundingMode(db(), T)).toBe("direct");
  });

  it("refuses with FUNDING_MODE_BUSY while an agreement is live", async () => {
    const accepted = await acceptedAgreement(createdApp);
    expect(accepted.status).toBe(200);
    const r = await put(USER, { funding_mode: "wallet" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("FUNDING_MODE_BUSY");
    expect(await getFundingMode(db(), T)).toBe("direct");
    for (const status of ["revision_requested", "needs_review"]) {
      await db().query(
        `UPDATE agreements SET status = $1 WHERE tenant_id = $2`,
        [status, T],
      );
      expect(
        (await put(USER, { funding_mode: "wallet" })).body.error.code,
      ).toBe("FUNDING_MODE_BUSY");
    }
    await db().query(
      `UPDATE agreements SET status = 'completed' WHERE tenant_id = $1`,
      [T],
    );
    expect((await put(USER, { funding_mode: "wallet" })).status).toBe(200);
  });

  it("seedFundingMode sets the default for new tenants and never overwrites", async () => {
    const t = randomUUID();
    await db().query(
      `INSERT INTO tenants (id, name, settings) VALUES ($1, 'N', '{"data_source":"live"}')`,
      [t],
    );
    await seedFundingMode(db(), t, "direct");
    expect(await getFundingMode(db(), t)).toBe("direct");
    const s = (
      await db().query(`SELECT settings FROM tenants WHERE id = $1`, [t])
    ).rows[0] as any;
    const settings =
      typeof s.settings === "string" ? JSON.parse(s.settings) : s.settings;
    expect(settings).toEqual({ data_source: "live", funding_mode: "direct" });
    await db().query(
      `UPDATE tenants SET settings = settings || '{"funding_mode":"wallet"}' WHERE id = $1`,
      [t],
    );
    await seedFundingMode(db(), t, "direct");
    expect(await getFundingMode(db(), t)).toBe("wallet");
  });
});

describe("funding mode and wallet configuration defaults", () => {
  it("falls back to documented defaults and ignores bad values", () => {
    expect(defaultFundingMode({})).toBe("direct");
    expect(defaultFundingMode({ DEFAULT_FUNDING_MODE: "wallet" })).toBe(
      "wallet",
    );
    expect(defaultFundingMode({ DEFAULT_FUNDING_MODE: "bogus" })).toBe(
      "direct",
    );
    expect(walletCurrencies({})).toEqual(["USD"]);
    expect(walletMaxDeposit({})).toBe("10000.00");
    expect(walletLowBalancePct({})).toBe(20);
    expect(walletLowBalancePct({ WALLET_LOW_BALANCE_PCT: "35" })).toBe(35);
    expect(walletLowBalancePct({ WALLET_LOW_BALANCE_PCT: "-1" })).toBe(20);
    expect(paypalRefundWindowDays({})).toBe(180);
    expect(walletDepositTtlMs({})).toBe(10_800_000);
    expect(walletSweepRefundMs({})).toBe(900_000);
    expect(walletSweepRefundMs({ WALLET_SWEEP_REFUND_MS: "99999999" })).toBe(
      900_000,
    );
    expect(
      walletReconcileIntervalMs({ WALLET_RECONCILE_INTERVAL_MS: "x" }),
    ).toBe(86_400_000);
  });
});
