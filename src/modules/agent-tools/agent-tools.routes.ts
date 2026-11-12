/**
 * Agent tool REST routes (agentic-commerce task 14.2, R14.1, R14.2, R14.6, R14.10).
 *
 * Thin transport over AgentToolGateway, the same gateway MCP uses. Authorization, validation, rate
 * limiting and auditing all live in the gateway. No deposit, reserve, charge, capture, refund,
 * approve, send, release or recipient route exists here.
 */
import type { Express, NextFunction, Request, Response } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { getDb } from "../../db/connection.js";
import { AgentToolGateway } from "./tool-gateway.js";

export const AGENT_TOOL_ROUTE_PATHS = [
  "/v1/agent-tools",
  "/v1/agent-tools/:tool",
] as const;

export function registerAgentToolRoutes(app: Express): void {
  const P = AGENT_TOOL_ROUTE_PATHS;
  const gateway = () => new AgentToolGateway(getDb());

  app.get(
    P[0],
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const tools = gateway()
          .listTools(req.principal!)
          .map((t) => ({
            name: t.name,
            description: t.description,
            kind: t.kind,
            inputSchema: t.inputSchema,
          }));
        res.status(200).json({ tools });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    P[1],
    authMiddleware(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const out = await gateway().call({
          principal: req.principal!,
          tool: req.params.tool,
          args: req.body ?? {},
          correlationId: req.correlationId,
          via: "rest",
        });
        res.status(200).json(out);
      } catch (error) {
        next(error);
      }
    },
  );
}
