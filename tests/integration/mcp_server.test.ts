import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { getDb, resetDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedDatabase, SEED_IDS } from '../../src/db/seed.js';
import { McpServer, FORBIDDEN_MCP_TOOLS } from '../../src/mcp/server.js';
import { dispatch } from '../test-utils.js';

describe('Slice 6: Model Context Protocol (MCP) Server (P0-21 & P0-22)', () => {
  let app: any;
  let mcpServer: McpServer;

  beforeAll(async () => {
    await resetDb();
    const db = getDb();
    await runMigrations(db);
    await seedDatabase(db);
    app = createApp();
    mcpServer = new McpServer(db);
  });

  beforeEach(async () => {
    const db = getDb();
    await db.exec(`
      TRUNCATE TABLE reconciliation_records, webhook_events, payment_transactions,
                     settlement_batch_items, settlement_batches, approvals,
                     journal_lines, journal_transactions, obligations, verifications,
                     deliveries, artifacts, agreements, quotes, quote_requests, missions,
                     economic_events, idempotency_keys, policy_decisions CASCADE;
    `);
  });

  afterAll(async () => {
    await closeDb();
  });

  it('P0-21: External agents can execute full mission lifecycle over MCP protocol', async () => {
    // 1. Handshake (initialize)
    const initRes = await dispatch(app, {
      method: 'POST',
      url: '/mcp',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          clientInfo: { name: 'external-agent-client', version: '1.0.0' },
        },
      },
    });

    expect(initRes.status).toBe(200);
    expect(initRes.body.result.serverInfo.name).toBe('stoat-mcp-server');
    expect(initRes.body.result.capabilities.tools).toBeDefined();

    // 2. Buyer agent lists tools
    const listRes = await dispatch(app, {
      method: 'POST',
      url: '/mcp',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      },
    });

    expect(listRes.status).toBe(200);
    const buyerTools = listRes.body.result.tools.map((t: any) => t.name);
    expect(buyerTools).toContain('discover_services');
    expect(buyerTools).toContain('request_quote');
    expect(buyerTools).toContain('accept_quote');
    expect(buyerTools).toContain('get_mission');
    expect(buyerTools).not.toContain('submit_delivery'); // Provider only
    expect(buyerTools).not.toContain('propose_settlement_batch'); // Treasury only

    // 3. Buyer discovers services via MCP
    const discoverRes = await dispatch(app, {
      method: 'POST',
      url: '/mcp',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'discover_services',
          arguments: { category: 'code_review' },
        },
      },
    });

    expect(discoverRes.status).toBe(200);
    const discoverData = JSON.parse(discoverRes.body.result.content[0].text);
    expect(discoverData.services.length).toBeGreaterThan(0);
    const serviceId = discoverData.services[0].id;

    // Create a mission for the buyer
    const missionRes = await dispatch(app, {
      method: 'POST',
      url: '/missions',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: {
        title: 'MCP Autonomous Review Mission',
        brief: 'Run full review over MCP protocol',
        budget: '50.000000',
        currency: 'USD',
      },
    });
    const missionId = missionRes.body.id;

    // 4. Buyer requests quote via MCP
    const quoteCallRes = await dispatch(app, {
      method: 'POST',
      url: '/mcp',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'request_quote',
          arguments: {
            mission_id: missionId,
            service_id: serviceId,
            requested_scope: { files: ['src/auth.ts'] },
            quantity: 1,
            currency: 'USD',
          },
        },
      },
    });

    expect(quoteCallRes.status).toBe(200);
    const quoteData = JSON.parse(quoteCallRes.body.result.content[0].text);
    expect(quoteData.id).toBeDefined();
    expect(quoteData.price).toBe('0.120000');
    const quoteId = quoteData.id;

    // 5. Buyer accepts quote via MCP -> Immutable Agreement
    const acceptCallRes = await dispatch(app, {
      method: 'POST',
      url: '/mcp',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'accept_quote',
          arguments: { quote_id: quoteId },
        },
      },
    });

    expect(acceptCallRes.status).toBe(200);
    const agreementData = JSON.parse(acceptCallRes.body.result.content[0].text);
    expect(agreementData.id).toBeDefined();
    expect(agreementData.status).toBe('accepted');
    const agreementId = agreementData.id;

    // 6. Provider agent creates artifact and submits delivery via MCP
    const artifactRes = await dispatch(app, {
      method: 'POST',
      url: '/artifacts',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: {
        findings: [
          {
            file: 'src/auth.ts',
            line_start: 4,
            line_end: 4,
            snippet: 'const JWT_SECRET = "sk_live_insecure_hardcoded_secret_token_12345";',
            rule_id: 'SEC-002',
            severity: 'critical',
          },
        ],
      },
    });

    const deliveryCallRes = await dispatch(app, {
      method: 'POST',
      url: '/mcp',
      headers: { Authorization: `Bearer agent:${SEED_IDS.providerAgentId}` },
      body: {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'submit_delivery',
          arguments: {
            agreement_id: agreementId,
            artifact_id: artifactRes.body.id,
          },
        },
      },
    });

    expect(deliveryCallRes.status).toBe(200);
    const deliveryData = JSON.parse(deliveryCallRes.body.result.content[0].text);
    expect(deliveryData.verification.verdict).toBe('verified');
    expect(deliveryData.obligation).toBeDefined();
    const obligationId = deliveryData.obligation.id;

    // 7. Treasury agent queries obligations and proposes batch via MCP
    const treasuryObligationsRes = await dispatch(app, {
      method: 'POST',
      url: '/mcp',
      headers: { Authorization: `Bearer agent:${SEED_IDS.treasuryAgentId}` },
      body: {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'get_obligations',
          arguments: { status: 'payable' },
        },
      },
    });

    expect(treasuryObligationsRes.status).toBe(200);
    const obligationsData = JSON.parse(treasuryObligationsRes.body.result.content[0].text);
    expect(obligationsData.length).toBeGreaterThan(0);

    const batchCallRes = await dispatch(app, {
      method: 'POST',
      url: '/mcp',
      headers: { Authorization: `Bearer agent:${SEED_IDS.treasuryAgentId}` },
      body: {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'propose_settlement_batch',
          arguments: {
            obligation_ids: [obligationId],
          },
        },
      },
    });

    expect(batchCallRes.status).toBe(200);
    const batchData = JSON.parse(batchCallRes.body.result.content[0].text);
    expect(batchData.id).toBeDefined();
    expect(batchData.status).toBe('approval_required');
    expect(batchData.total_amount).toBe('0.120000');
  });

  it('P0-22: Forbidden tools (approve/capture/release/override) are excluded and strictly denied on MCP server', async () => {
    // 1. Verify tools/list NEVER exposes forbidden actions for any agent role
    const agentRoles = [
      SEED_IDS.buyerAgentId,
      SEED_IDS.providerAgentId,
      SEED_IDS.treasuryAgentId,
      SEED_IDS.watchdogAgentId,
      SEED_IDS.copilotAgentId,
    ];

    for (const agentId of agentRoles) {
      const listRes = await dispatch(app, {
        method: 'POST',
        url: '/mcp',
        headers: { Authorization: `Bearer agent:${agentId}` },
        body: { jsonrpc: '2.0', id: 10, method: 'tools/list' },
      });

      expect(listRes.status).toBe(200);
      const tools = listRes.body.result.tools.map((t: any) => t.name);

      for (const forbidden of FORBIDDEN_MCP_TOOLS) {
        expect(tools).not.toContain(forbidden);
      }
    }

    // 2. Explicitly attempting to call forbidden tools via tools/call fails with FORBIDDEN_ACTION
    for (const forbidden of FORBIDDEN_MCP_TOOLS) {
      const callRes = await dispatch(app, {
        method: 'POST',
        url: '/mcp',
        headers: { Authorization: `Bearer agent:${SEED_IDS.treasuryAgentId}` },
        body: {
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: forbidden,
            arguments: { batch_id: '00000000-0000-0000-0000-000000000001' },
          },
        },
      });

      expect(callRes.status).toBe(200);
      expect(callRes.body.error).toBeDefined();
      expect(callRes.body.error.code).toBe(-32601);
      expect(callRes.body.error.message).toContain('FORBIDDEN_ACTION');
      expect(callRes.body.error.data.code).toBe('FORBIDDEN_ACTION');
    }

    // 3. Cross-role enforcement: Buyer cannot call provider or treasury tools
    const unauthorizedCall = await dispatch(app, {
      method: 'POST',
      url: '/mcp',
      headers: { Authorization: `Bearer agent:${SEED_IDS.buyerAgentId}` },
      body: {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'propose_settlement_batch',
          arguments: { obligation_ids: [] },
        },
      },
    });

    expect(unauthorizedCall.status).toBe(200);
    expect(unauthorizedCall.body.error).toBeDefined();
    expect(unauthorizedCall.body.error.code).toBe(-32003);
    expect(unauthorizedCall.body.error.data.code).toBe('FORBIDDEN_ACTION');
    expect(unauthorizedCall.body.error.message).toContain("Role 'buyer' is not authorized");
  });
});
