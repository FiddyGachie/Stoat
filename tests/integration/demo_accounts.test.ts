// The public test logins in TEST_ACCOUNTS.md must actually work on a fresh local database.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase } from "../../src/db/seed.js";
import { DEMO_ACCOUNTS, demoAccountsEnabled, seedDemoAccounts } from "../../src/db/demo-accounts.js";
import { dispatch } from "../test-utils.js";

let app: any;
describe("demo test accounts", () => {
  beforeAll(async () => {
    await resetDb();
    await runMigrations(getDb());
    await seedDatabase(getDb());
    await seedDemoAccounts(getDb());
    await seedDemoAccounts(getDb()); // idempotent
    app = createApp();
  });
  afterAll(async () => { await closeDb(); });

  it("the demo buyer and admin sign in with the published password", async () => {
    for (const u of [DEMO_ACCOUNTS.buyer, DEMO_ACCOUNTS.admin]) {
      const r = await dispatch(app, { method: "POST", url: "/v1/auth/login", body: { email: u.email, password: DEMO_ACCOUNTS.password } });
      expect(r.status).toBe(200);
      expect(typeof (r.body.token ?? r.body.access_token)).toBe("string");
    }
    const bad = await dispatch(app, { method: "POST", url: "/v1/auth/login", body: { email: DEMO_ACCOUNTS.buyer.email, password: "wrong-password" } });
    expect(bad.status).toBe(401);
  });

  it("the demo buyer and provider agents sign in with their published secrets, owned by the demo buyer", async () => {
    for (const a of [DEMO_ACCOUNTS.buyerAgent, DEMO_ACCOUNTS.providerAgent]) {
      const r = await dispatch(app, { method: "POST", url: "/v1/auth/agent/login", body: { agent_id: a.id, secret: a.secret } });
      expect(r.status).toBe(200);
      const owner = await getDb().query(`SELECT owner_user_id FROM agents WHERE id = $1`, [a.id]);
      expect(owner.rows[0].owner_user_id).toBe(DEMO_ACCOUNTS.buyer.id);
    }
  });

  it("is switched off in production", () => {
    expect(demoAccountsEnabled({ NODE_ENV: "production" } as any)).toBe(false);
    expect(demoAccountsEnabled({ DEMO_ACCOUNTS: "false" } as any)).toBe(false);
    expect(demoAccountsEnabled({} as any)).toBe(true);
  });
});
