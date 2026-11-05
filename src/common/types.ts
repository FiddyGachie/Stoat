export type AgentRole =
  | 'buyer'
  | 'provider'
  | 'treasury'
  | 'watchdog'
  | 'verifier_advisor'
  | 'copilot';

export type UserRole = 'operator' | 'supervisor' | 'viewer';

export interface AuthenticatedPrincipal {
  id: string;
  tenantId: string;
  type: 'agent' | 'user';
  role: AgentRole | UserRole;
  scopes: string[];
  name: string;
}
