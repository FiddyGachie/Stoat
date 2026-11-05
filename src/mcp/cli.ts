import readline from 'node:readline';
import { McpServer, JsonRpcRequest } from './server.js';
import { getDb, initDb } from '../db/connection.js';
import { AuthenticatedPrincipal } from '../common/types.js';

async function main() {
  await initDb();
  const db = getDb();
  const server = new McpServer(db);

  // Default principal for stdio connection via environment or arguments
  const principal: AuthenticatedPrincipal = {
    id: process.env.STOAT_AGENT_ID || '00000000-0000-0000-0000-000000000010',
    tenantId: process.env.STOAT_TENANT_ID || '00000000-0000-0000-0000-000000000001',
    type: 'agent',
    role: (process.env.STOAT_AGENT_ROLE as any) || 'buyer',
    scopes: ['commerce:buy', 'quotes:request'],
    name: 'MCP Stdio Agent',
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const request: JsonRpcRequest = JSON.parse(trimmed);
      const response = await server.handleRequest(request, principal);
      console.log(JSON.stringify(response));
    } catch (err: any) {
      console.log(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: 'Parse error',
            data: err.message,
          },
        })
      );
    }
  });
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    console.error('Fatal MCP stdio server error:', err);
    process.exit(1);
  });
}
