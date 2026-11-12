import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { dispatch } from "../test-utils.js";

describe("User and agent portal API", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    await resetDb();
    const db = getDb();
    await runMigrations(db);
    await seedDatabase(db);
    app = createApp();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("creates an isolated buyer account with a signed session and no seeded marketplace records", async () => {
    const email = `buyer-${randomUUID()}@example.test`;
    const signup = await dispatch(app, {
      method: "POST",
      url: "/v1/auth/signup",
      body: {
        email,
        password: "A-longer-password-123",
        organization_name: "New buyer organization",
      },
    });

    expect(signup.status).toBe(201);
    expect(signup.body.user.email).toBe(email);
    expect(signup.body.user.role).toBe("buyer");
    expect(signup.body.access_token).toBeTruthy();
    expect(JSON.stringify(signup.body)).not.toContain("password_hash");

    const auth = { Authorization: `Bearer ${signup.body.access_token}` };
    const me = await dispatch(app, { method: "GET", url: "/v1/auth/me", headers: auth });
    expect(me.status).toBe(200);
    expect(me.body.tenant_name).toBe("New buyer organization");
    expect(me.body.buyer_agent_id).toBeTruthy();
    expect(me.body.data_source).toBe("live");

    const services = await dispatch(app, { method: "GET", url: "/v1/services", headers: auth });
    expect(services.status).toBe(200);
    expect(services.body.services).toEqual([]);

    const missions = await dispatch(app, { method: "GET", url: "/v1/missions", headers: auth });
    expect(missions.body.missions).toEqual([]);

    const seededMe = await dispatch(app, {
      method: "GET",
      url: "/v1/auth/me",
      headers: { Authorization: `Bearer user:${SEED_IDS.userId}` },
    });
    expect(seededMe.body.data_source).toBe("seeded_demo");
  });

  it("allows an owner to provision a provider that signs in and publishes a tenant-scoped service", async () => {
    const signup = await dispatch(app, {
      method: "POST",
      url: "/v1/auth/signup",
      body: {
        email: `owner-${randomUUID()}@example.test`,
        password: "Another-long-password-456",
        organization_name: "Provider organization",
      },
    });
    const userAuth = { Authorization: `Bearer ${signup.body.access_token}` };

    const provision = await dispatch(app, {
      method: "POST",
      url: "/v1/agents",
      headers: userAuth,
      body: { name: "Review provider", role: "provider" },
    });
    expect(provision.status).toBe(201);
    expect(provision.body.agent.role).toBe("provider");
    expect(provision.body.secret).toBeTruthy();

    const login = await dispatch(app, {
      method: "POST",
      url: "/v1/auth/agent/login",
      body: { agent_id: provision.body.agent.id, secret: provision.body.secret },
    });
    expect(login.status).toBe(200);
    const agentAuth = { Authorization: `Bearer ${login.body.access_token}` };
    const publish = await dispatch(app, {
      method: "POST",
      url: "/v1/services",
      headers: agentAuth,
      body: {
        name: "Grounded code review",
        description: "Reviews a scoped code fixture and returns grounded findings.",
        category: "code_review",
        unit_price: "0.12",
        currency: "USD",
        unit: "review",
        verification_profile: {
          method: "grounded_verification",
          allowed_rules: ["SEC-001"],
          allowed_severities: ["low", "medium", "high"],
          max_findings: 10,
          min_coverage_pct: 100,
        },
      },
    });
    expect(publish.status).toBe(201);
    expect(publish.body.provider_id).toBe(provision.body.agent.id);

    const services = await dispatch(app, { method: "GET", url: "/v1/services", headers: userAuth });
    expect(services.body.services).toHaveLength(1);
    expect(services.body.services[0].name).toBe("Grounded code review");
    const missions = await dispatch(app, { method: "GET", url: "/v1/missions", headers: agentAuth });
    expect(missions.status).toBe(403);
    const audit = await getDb().query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE tenant_id = $1 AND action IN ('account.signup', 'agent.provision', 'service.publish')`,
      [signup.body.user.tenant_id],
    );
    expect(audit.rows.map((row) => row.action).sort()).toEqual([
      "account.signup",
      "agent.provision",
      "service.publish",
    ]);
  });

  it("supports persisted buyer mission, quote, acceptance, and owner-only reads", async () => {
    const email = `buyer-flow-${randomUUID()}@example.test`;
    const signup = await dispatch(app, {
      method: "POST",
      url: "/v1/auth/signup",
      body: {
        email,
        password: "Buyer-flow-password-789",
        organization_name: "Buyer flow organization",
      },
    });
    const buyerAuth = { Authorization: `Bearer ${signup.body.access_token}` };

    const provider = await dispatch(app, {
      method: "POST",
      url: "/v1/agents",
      headers: buyerAuth,
      body: { name: "Provider", role: "provider" },
    });
    const providerLogin = await dispatch(app, {
      method: "POST",
      url: "/v1/auth/agent/login",
      body: { agent_id: provider.body.agent.id, secret: provider.body.secret },
    });
    const providerAuth = { Authorization: `Bearer ${providerLogin.body.access_token}` };
    const service = await dispatch(app, {
      method: "POST",
      url: "/v1/services",
      headers: providerAuth,
      body: {
        name: "Code review",
        description: "A scoped review service.",
        category: "code_review",
        unit_price: "0.12",
        currency: "USD",
        unit: "review",
      },
    });

    const mission = await dispatch(app, {
      method: "POST",
      url: "/v1/missions",
      headers: buyerAuth,
      body: {
        title: "Review checkout",
        brief: "Check payment validation and report grounded findings.",
        budget: "1.00",
        currency: "USD",
      },
    });
    expect(mission.status).toBe(201);

    const quote = await dispatch(app, {
      method: "POST",
      url: "/v1/quotes",
      headers: buyerAuth,
      body: { mission_id: mission.body.id, service_id: service.body.id, quantity: 1 },
    });
    expect(quote.status).toBe(201);

    const quotes = await dispatch(app, {
      method: "GET",
      url: `/v1/missions/${mission.body.id}/quotes`,
      headers: buyerAuth,
    });
    expect(quotes.status).toBe(200);
    expect(quotes.body.quotes[0].id).toBe(quote.body.id);

    const accepted = await dispatch(app, {
      method: "POST",
      url: `/v1/quotes/${quote.body.id}/accept`,
      headers: buyerAuth,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe("accepted");

    const missions = await dispatch(app, { method: "GET", url: "/v1/missions", headers: buyerAuth });
    expect(missions.body.missions.map((item: { id: string }) => item.id)).toEqual([mission.body.id]);

    const otherSignup = await dispatch(app, {
      method: "POST",
      url: "/v1/auth/signup",
      body: {
        email: `other-${randomUUID()}@example.test`,
        password: "Other-account-password-321",
        organization_name: "Other organization",
      },
    });
    const otherAuth = { Authorization: `Bearer ${otherSignup.body.access_token}` };
    const hiddenMission = await dispatch(app, {
      method: "GET",
      url: `/v1/missions/${mission.body.id}`,
      headers: otherAuth,
    });
    expect(hiddenMission.status).toBe(404);
    const otherServices = await dispatch(app, { method: "GET", url: "/v1/services", headers: otherAuth });
    expect(otherServices.body.services).toEqual([]);
  });

  it("rejects duplicate email and invalid credentials without returning credential material", async () => {
    const email = `unique-${randomUUID()}@example.test`;
    const body = {
      email,
      password: "Safe-password-12345",
      organization_name: "Credential test",
    };
    const first = await dispatch(app, { method: "POST", url: "/v1/auth/signup", body });
    expect(first.status).toBe(201);

    const duplicate = await dispatch(app, { method: "POST", url: "/v1/auth/signup", body });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("EMAIL_ALREADY_REGISTERED");

    const badLogin = await dispatch(app, {
      method: "POST",
      url: "/v1/auth/login",
      body: { email, password: "incorrect-password" },
    });
    expect(badLogin.status).toBe(401);

    const user = await getDb().query<{ password_hash: string; id: string }>(
      "SELECT password_hash, id FROM users WHERE email = $1",
      [email],
    );
    expect(user.rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(user.rows[0].id).not.toBe(SEED_IDS.userId);
  });
});
