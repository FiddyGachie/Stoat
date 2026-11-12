// Task 8.4: PayPal return and cancel for wallet deposits (R3.8, R3.9, R3.14, R3.16).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { DepositService } from "../../src/modules/wallet/deposit.service.js";
import { WalletPayPalDouble } from "../../scripts/verify/paypal-wallet-double.js";
import { TRUNCATE_ALL } from "../funding-helpers.js";
import type { AuthenticatedPrincipal } from "../../src/common/types.js";

const T = SEED_IDS.tenantId;
const owner: AuthenticatedPrincipal = {
  id: SEED_IDS.userId,
  tenantId: T,
  type: "user",
  role: "buyer",
  scopes: [],
  name: "Owner",
};

describe("wallet deposit PayPal return and cancel", () => {
  let server: Server;
  let base = "";
  let paypal: WalletPayPalDouble;
  let svc: DepositService;
  const savedConsole = process.env.CONSOLE_URL;

  beforeAll(async () => {
    await resetDb();
    await runMigrations(getDb());
    await seedDatabase(getDb());
  });
  beforeEach(async () => {
    await getDb().query(TRUNCATE_ALL);
    await getDb().query(
      `UPDATE tenants SET settings = settings || $2::jsonb WHERE id = $1`,
      [T, JSON.stringify({ funding_mode: "wallet" })],
    );
    process.env.CONSOLE_URL = "https://console.example.test";
    paypal = new WalletPayPalDouble();
    svc = new DepositService({ gateway: paypal });
    if (server) await new Promise((r) => server.close(r));
    const app = createApp({ gateway: paypal });
    server = await new Promise<Server>((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (savedConsole === undefined) delete process.env.CONSOLE_URL;
    else process.env.CONSOLE_URL = savedConsole;
    await new Promise((r) => server.close(r));
    await closeDb();
  });

  const hit = async (path: string) => {
    const res = await fetch(`${base}${path}`, { redirect: "manual" });
    return { status: res.status, location: res.headers.get("location") ?? "" };
  };
  const newDeposit = () =>
    svc.createDeposit({
      tenantId: T,
      owner,
      amount: "10.00",
      currency: "USD",
      idempotencyKey: `k-${randomUUID()}`,
    });
  const captures = () =>
    paypal.calls.filter((c) => c.method === "captureOrder").length;

  it("return captures once and redirects to #/wallet on the trusted origin", async () => {
    const d = await newDeposit();
    const r = await hit(`/v1/paypal/return?token=${d.paypal_order_id}`);
    expect(r.status).toBe(302);
    const u = new URL(r.location);
    expect(u.origin).toBe("https://console.example.test");
    expect(u.hash).toBe("#/wallet");
    expect(u.searchParams.get("wallet_deposit")).toBe(d.id);
    expect(u.searchParams.get("wallet_status")).toBe("captured");
    // A second return does not capture again.
    await hit(`/v1/paypal/return?token=${d.paypal_order_id}`);
    expect(captures()).toBe(1);
  });

  it("cancel marks the deposit cancelled without a capture", async () => {
    const d = await newDeposit();
    const r = await hit(`/v1/paypal/cancel?token=${d.paypal_order_id}`);
    const u = new URL(r.location);
    expect(u.hash).toBe("#/wallet");
    expect(u.searchParams.get("wallet_status")).toBe("cancelled");
    expect(captures()).toBe(0);
  });

  it("ignores a request-supplied redirect target", async () => {
    const d = await newDeposit();
    const r = await hit(
      `/v1/paypal/return?token=${d.paypal_order_id}&redirect=https://evil.example&return_to=https://evil.example`,
    );
    expect(r.location).not.toContain("evil");
    expect(r.location.startsWith("https://console.example.test/")).toBe(true);
  });

  it("an order from another environment redirects with error status and no capture", async () => {
    const d = await newDeposit();
    await getDb().query(
      `UPDATE wallet_deposits SET paypal_environment = 'live' WHERE id = $1`,
      [d.id],
    );
    const r = await hit(`/v1/paypal/return?token=${d.paypal_order_id}`);
    const u = new URL(r.location);
    expect(u.hash).toBe("#/wallet");
    expect(u.searchParams.get("wallet_status")).toBe("error");
    expect(captures()).toBe(0);
    const audit = await getDb().query(
      `SELECT 1 FROM audit_logs WHERE tenant_id = $1 AND action = 'wallet.deposit.capture'`,
      [T],
    );
    expect(audit.rows.length).toBe(1);
  });
});
