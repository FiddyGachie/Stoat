import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../../src/api/app.js";
import { getDb, resetDb, closeDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedDatabase, SEED_IDS } from "../../src/db/seed.js";
import { AGENTIC_ROUTE_PATHS } from "../../src/modules/agentic/agentic.routes.js";
import { TOOL_NAMES } from "../../src/modules/agent-tools/tool-schemas.js";
import { dispatch } from "../test-utils.js";

const FORBIDDEN =
  /deposit|reserve|charge|capture|refund_payment|approve|send|release_hold|recipient/i;

describe("Agent tools over REST and MCP (task 14.2)", () => {
  let app: any;
  const buyer = { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` };
  const treasury = { Authorization: `Bearer agent:${SEED_IDS.treasuryAgentId}` };

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

  it("lists the routes in AGENTIC_ROUTE_PATHS", () => {
    expect(AGENTIC_ROUTE_PATHS).toContain("/v1/agent-tools");
    expect(AGENTIC_ROUTE_PATHS).toContain("/v1/agent-tools/:tool");
  });

  it("REST and MCP list the same role tool set, with no money-moving tool", async () => {
    const rest = await dispatch(app, {
      method: "GET",
      url: "/v1/agent-tools",
      headers: buyer,
    });
    expect(rest.status).toBe(200);
    const restNames = rest.body.tools.map((t: any) => t.name).sort();
    expect(restNames).toEqual(["mandate_remaining", "payment_status", "wallet_summary"]);

    const mcp = await dispatch(app, {
      method: "POST",
      url: "/mcp",
      headers: buyer,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    const mcpNames = mcp.body.result.tools.map((t: any) => t.name);
    for (const n of restNames) expect(mcpNames).toContain(n);
    for (const n of mcpNames.filter((x: string) => (TOOL_NAMES as readonly string[]).includes(x))) {
      expect(n).not.toMatch(FORBIDDEN);
    }
  });

  it("refuses a tool outside the role set on both interfaces", async () => {
    const rest = await dispatch(app, {
      method: "POST",
      url: "/v1/agent-tools/wallet_summary",
      headers: treasury,
      body: { wallet_id: "00000000-0000-0000-0000-000000000001" },
    });
    expect(rest.status).toBe(403);

    const mcp = await dispatch(app, {
      method: "POST",
      url: "/mcp",
      headers: treasury,
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "wallet_summary", arguments: { wallet_id: "00000000-0000-0000-0000-000000000001" } },
      },
    });
    expect(mcp.body.error.data.code).toBe("FORBIDDEN_ACTION");
  });

  it("returns one NOT_FOUND for an unknown record and rejects unknown arguments", async () => {
    const missing = await dispatch(app, {
      method: "POST",
      url: "/v1/agent-tools/wallet_summary",
      headers: buyer,
      body: { wallet_id: "00000000-0000-0000-0000-000000000001" },
    });
    expect(missing.status).toBe(404);

    const bad = await dispatch(app, {
      method: "POST",
      url: "/v1/agent-tools/wallet_summary",
      headers: buyer,
      body: { wallet_id: "00000000-0000-0000-0000-000000000001", amount: "5" },
    });
    expect(bad.status).toBe(400);
  });

  it("does not expose a tool for an unregistered money action", async () => {
    const res = await dispatch(app, {
      method: "POST",
      url: "/v1/agent-tools/capture_payment",
      headers: buyer,
      body: {},
    });
    expect(res.status).toBe(403);
  });
});
