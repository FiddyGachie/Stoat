export type AgentRole =
  | "buyer"
  | "provider"
  | "treasury"
  | "watchdog"
  | "verifier_advisor"
  | "copilot"
  | "budget";

export type UserRole = "buyer" | "operator" | "supervisor" | "viewer";

export interface AuthenticatedPrincipal {
  id: string;
  tenantId: string;
  type: "agent" | "user";
  role: AgentRole | UserRole;
  scopes: string[];
  name: string;
}
