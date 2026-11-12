import { randomBytes, randomUUID } from "node:crypto";
import { DbClient, transaction } from "../../db/connection.js";
import {
  ConflictError,
  ForbiddenActionError,
  NotFoundError,
  StoatError,
  ValidationError,
} from "../../common/errors.js";
import {
  accessTokenTtlSeconds,
  hashCredential,
  issueAccessToken,
  verifyAgainstDummy,
  verifyCredential,
} from "../../common/auth-crypto.js";
import { loginThrottle } from "../../common/login-throttle.js";
import { seedFundingMode } from "../wallet/funding-mode.js";

const BUYER_AGENT_SCOPES = [
  "discover",
  "quote",
  "accept",
  "revision",
  "read_mission",
];
const PROVIDER_AGENT_SCOPES = ["service_publish", "quote_offer", "deliver"];
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AGENTS_PER_TENANT = Number(process.env.MAX_AGENTS_PER_TENANT ?? 50);

/** Every organisation needs this chart of accounts or obligation accrual fails (LEDGER_AND_ACCOUNTING.md). */
const DEFAULT_ACCOUNTS: Array<
  [code: string, name: string, normal: "debit" | "credit"]
> = [
  ["5001", "Buyer Service Expense", "debit"],
  ["2001", "Provider Payable", "credit"],
  ["2002", "Settlement Clearing", "credit"],
];

const DEFAULT_POLICY_RULES = {
  max_mission_budget: "50.00",
  max_transaction_amount: "10.00",
  daily_spend_limit: "100.00",
  allowed_categories: ["code_review", "security_scan", "data_analysis"],
  require_human_approval_above: "0.00",
  max_revisions: 2,
};

/** Everything a brand-new organisation needs before it can transact: chart of accounts and an active policy. */
async function scaffoldTenant(tx: DbClient, tenantId: string): Promise<void> {
  for (const [code, name, normal] of DEFAULT_ACCOUNTS) {
    await tx.query(
      `INSERT INTO accounts (tenant_id, account_code, name, normal_balance, currency, is_active)
       VALUES ($1, $2, $3, $4, 'USD', TRUE)`,
      [tenantId, code, name, normal],
    );
  }
  await tx.query(
    `INSERT INTO policy_versions (tenant_id, version, rules, description, is_active)
     VALUES ($1, 1, $2, 'Default organization procurement policy', TRUE)`,
    [tenantId, JSON.stringify(DEFAULT_POLICY_RULES)],
  );
  await seedFundingMode(tx, tenantId);
}
function validateCredentials(
  email: unknown,
  password: unknown,
): { email: string; password: string } {
  if (typeof email !== "string" || typeof password !== "string") {
    throw new ValidationError("Email and password are required.");
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (
    normalizedEmail.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
  ) {
    throw new ValidationError("Enter a valid email address.");
  }
  if (password.length < 12 || password.length > 128) {
    throw new ValidationError(
      "Password must be between 12 and 128 characters.",
    );
  }
  return { email: normalizedEmail, password };
}

function accessTokenResponse(subject: string, type: "user" | "agent") {
  return {
    access_token: issueAccessToken(subject, type),
    token_type: "Bearer",
    expires_in: accessTokenTtlSeconds(type),
  };
}

const invalidCredentials = (message: string) =>
  new StoatError("INVALID_CREDENTIALS", message, 401);

export class AuthService {
  constructor(private readonly db: DbClient) {}

  private async audit(entry: {
    tenantId: string;
    actorType: "user" | "agent";
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    outcome: "success" | "failure";
    reason?: string;
    correlationId?: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_logs (
         tenant_id, actor_type, actor_id, action, resource_type, resource_id,
         correlation_id, outcome, reason, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}')`,
      [
        entry.tenantId,
        entry.actorType,
        entry.actorId,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        entry.correlationId && UUID_RE.test(entry.correlationId)
          ? entry.correlationId
          : randomUUID(),
        entry.outcome,
        entry.reason ?? null,
      ],
    );
  }

  async signup(input: {
    email?: unknown;
    password?: unknown;
    organization_name?: unknown;
    correlationId?: string;
  }): Promise<Record<string, unknown>> {
    const { email, password } = validateCredentials(
      input.email,
      input.password,
    );
    const organizationName =
      typeof input.organization_name === "string"
        ? input.organization_name.trim()
        : "";
    if (!organizationName || organizationName.length > 120) {
      throw new ValidationError(
        "Organization name is required and must be at most 120 characters.",
      );
    }

    const passwordHash = await hashCredential(password);
    const agentCredentialHash = await hashCredential(
      randomBytes(32).toString("base64url"),
    );

    try {
      const created = await transaction(async (tx) => {
        const tenantResult = await tx.query<{ id: string }>(
          `INSERT INTO tenants (name, settings) VALUES ($1, $2) RETURNING id`,
          [organizationName, JSON.stringify({ data_source: "live" })],
        );
        const tenantId = tenantResult.rows[0].id;

        const userResult = await tx.query<{
          id: string;
          email: string;
          role: string;
        }>(
          `INSERT INTO users (tenant_id, email, role, password_hash)
           VALUES ($1, $2, 'buyer', $3)
           RETURNING id, email, role`,
          [tenantId, email, passwordHash],
        );
        const user = userResult.rows[0];

        await tx.query(
          `INSERT INTO agents (
             tenant_id, owner_user_id, role, name, status, scopes, credential_hash
           ) VALUES ($1, $2, 'buyer', $3, 'active', $4, $5)`,
          [
            tenantId,
            user.id,
            `${organizationName} Buyer`,
            JSON.stringify(BUYER_AGENT_SCOPES),
            agentCredentialHash,
          ],
        );

        await scaffoldTenant(tx, tenantId);

        await tx.query(
          `INSERT INTO audit_logs (
             tenant_id, actor_type, actor_id, action, resource_type, resource_id,
             correlation_id, outcome, metadata
           ) VALUES ($1, 'user', $2, 'account.signup', 'tenant', $3, $4, 'success', $5)`,
          [
            tenantId,
            user.id,
            tenantId,
            input.correlationId && UUID_RE.test(input.correlationId)
              ? input.correlationId
              : randomUUID(),
            JSON.stringify({ role: user.role }),
          ],
        );
        return { tenantId, user };
      });

      return {
        user: {
          id: created.user.id,
          tenant_id: created.tenantId,
          email: created.user.email,
          role: created.user.role,
        },
        ...accessTokenResponse(created.user.id, "user"),
      };
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new ConflictError(
          "EMAIL_ALREADY_REGISTERED",
          "An account with this email already exists.",
        );
      }
      throw error;
    }
  }

  async login(
    emailInput: unknown,
    passwordInput: unknown,
    ip?: string,
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    if (
      typeof emailInput !== "string" ||
      typeof passwordInput !== "string" ||
      !emailInput ||
      !passwordInput
    ) {
      throw new ValidationError("Email and password are required.");
    }
    if (passwordInput.length > 128)
      throw invalidCredentials("Invalid email or password.");

    const email = emailInput.trim().toLowerCase();
    loginThrottle.assertAllowed(email, ip);

    const result = await this.db.query<{
      id: string;
      tenant_id: string;
      email: string;
      role: string;
      password_hash: string | null;
    }>(
      `SELECT id, tenant_id, email, role, password_hash FROM users WHERE email = $1`,
      [email],
    );
    const user = result.rows[0];

    // Always spend one hash verification, whether or not the account exists, so response
    // time does not reveal which emails are registered.
    const valid = user?.password_hash
      ? await verifyCredential(passwordInput, user.password_hash)
      : await verifyAgainstDummy(passwordInput);

    if (!user || !valid) {
      loginThrottle.recordFailure(email, ip);
      if (user) {
        await this.audit({
          tenantId: user.tenant_id,
          actorType: "user",
          actorId: user.id,
          action: "auth.login",
          resourceType: "user",
          resourceId: user.id,
          outcome: "failure",
          reason: "invalid_password",
          correlationId,
        });
      }
      throw invalidCredentials("Invalid email or password.");
    }

    loginThrottle.recordSuccess(email);
    await this.audit({
      tenantId: user.tenant_id,
      actorType: "user",
      actorId: user.id,
      action: "auth.login",
      resourceType: "user",
      resourceId: user.id,
      outcome: "success",
      correlationId,
    });
    return {
      user: {
        id: user.id,
        tenant_id: user.tenant_id,
        email: user.email,
        role: user.role,
      },
      ...accessTokenResponse(user.id, "user"),
    };
  }

  async loginAgent(
    agentId: unknown,
    secret: unknown,
    ip?: string,
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    if (
      typeof agentId !== "string" ||
      typeof secret !== "string" ||
      !agentId ||
      !secret
    ) {
      throw new ValidationError("Agent ID and secret are required.");
    }
    const key = `agent:${agentId.toLowerCase()}`;
    loginThrottle.assertAllowed(key, ip);

    // A malformed id can never match a row; treat it exactly like an unknown agent
    // (same status, same cost) instead of letting Postgres raise a 500.
    const agent = UUID_RE.test(agentId)
      ? (
          await this.db.query<{
            id: string;
            tenant_id: string;
            role: string;
            name: string;
            status: string;
            credential_hash: string;
          }>(
            `SELECT id, tenant_id, role, name, status, credential_hash FROM agents WHERE id = $1`,
            [agentId],
          )
        ).rows[0]
      : undefined;

    const secretOk = agent
      ? await verifyCredential(secret, agent.credential_hash)
      : await verifyAgainstDummy(secret);

    if (!agent || !secretOk || agent.status !== "active") {
      loginThrottle.recordFailure(key, ip);
      if (agent) {
        await this.audit({
          tenantId: agent.tenant_id,
          actorType: "agent",
          actorId: agent.id,
          action: "auth.agent_login",
          resourceType: "agent",
          resourceId: agent.id,
          outcome: "failure",
          reason:
            agent.status !== "active"
              ? `agent_${agent.status}`
              : "invalid_secret",
          correlationId,
        });
      }
      throw invalidCredentials("Invalid agent ID or secret.");
    }

    loginThrottle.recordSuccess(key);
    await this.audit({
      tenantId: agent.tenant_id,
      actorType: "agent",
      actorId: agent.id,
      action: "auth.agent_login",
      resourceType: "agent",
      resourceId: agent.id,
      outcome: "success",
      correlationId,
    });
    return {
      agent: { id: agent.id, role: agent.role, name: agent.name },
      ...accessTokenResponse(agent.id, "agent"),
    };
  }

  async createAgent(
    tenantId: string,
    ownerUserId: string,
    input: { name?: unknown; role?: unknown },
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 120) {
      throw new ValidationError(
        "Agent name is required and must be at most 120 characters.",
      );
    }
    if (input.role !== "buyer" && input.role !== "provider") {
      throw new ValidationError(
        "Only buyer and provider agents can be provisioned.",
      );
    }

    const count = await this.db.query<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM agents WHERE tenant_id = $1`,
      [tenantId],
    );
    if (Number(count.rows[0]?.n ?? 0) >= MAX_AGENTS_PER_TENANT) {
      throw new ConflictError(
        "AGENT_LIMIT_REACHED",
        `An organization can have at most ${MAX_AGENTS_PER_TENANT} agents.`,
      );
    }

    const secret = randomBytes(32).toString("base64url");
    const credentialHash = await hashCredential(secret);
    const scopes =
      input.role === "buyer" ? BUYER_AGENT_SCOPES : PROVIDER_AGENT_SCOPES;

    const agent = await transaction(async (tx) => {
      const result = await tx.query<{
        id: string;
        role: string;
        name: string;
        status: string;
        scopes: string[];
        created_at: string;
      }>(
        `INSERT INTO agents (tenant_id, owner_user_id, role, name, status, scopes, credential_hash)
         VALUES ($1, $2, $3, $4, 'active', $5, $6)
         RETURNING id, role, name, status, scopes, created_at`,
        [
          tenantId,
          ownerUserId,
          input.role,
          name,
          JSON.stringify(scopes),
          credentialHash,
        ],
      );
      await tx.query(
        `INSERT INTO audit_logs (
           tenant_id, actor_type, actor_id, action, resource_type, resource_id,
           correlation_id, outcome, metadata
         ) VALUES ($1, 'user', $2, 'agent.provision', 'agent', $3, $4, 'success', $5)`,
        [
          tenantId,
          ownerUserId,
          result.rows[0].id,
          correlationId && UUID_RE.test(correlationId)
            ? correlationId
            : randomUUID(),
          JSON.stringify({ role: input.role, scopes }),
        ],
      );
      return result.rows[0];
    });

    // The secret is returned exactly once; only its hash is stored.
    return { agent, secret };
  }

  /**
   * FR-002 kill switch. Suspending takes effect immediately: live tokens are refused on
   * their next request (AGENT_SUSPENDED) and the agent cannot sign in again. Only the
   * agent's owner, or an operator/supervisor in the same tenant, may change status.
   */
  async setAgentStatus(
    actor: { id: string; tenantId: string; role: string },
    agentId: unknown,
    status: unknown,
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    if (typeof agentId !== "string" || !UUID_RE.test(agentId)) {
      throw new ValidationError("A valid agent id is required.");
    }
    if (status !== "active" && status !== "suspended") {
      throw new ValidationError("Status must be 'active' or 'suspended'.");
    }

    const found = await this.db.query<{
      id: string;
      owner_user_id: string | null;
    }>(
      `SELECT id, owner_user_id FROM agents WHERE tenant_id = $1 AND id = $2`,
      [actor.tenantId, agentId],
    );
    const agent = found.rows[0];
    if (!agent) throw new NotFoundError("Agent", agentId);

    const privileged = actor.role === "operator" || actor.role === "supervisor";
    if (agent.owner_user_id !== actor.id && !privileged) {
      throw new ForbiddenActionError(
        "Only the agent's owner or an operator can change its status.",
      );
    }

    const updated = await this.db.query<{
      id: string;
      role: string;
      name: string;
      status: string;
    }>(
      `UPDATE agents SET status = $1, updated_at = now()
       WHERE tenant_id = $2 AND id = $3
       RETURNING id, role, name, status`,
      [status, actor.tenantId, agentId],
    );
    await this.audit({
      tenantId: actor.tenantId,
      actorType: "user",
      actorId: actor.id,
      action: status === "suspended" ? "agent.suspend" : "agent.activate",
      resourceType: "agent",
      resourceId: agentId,
      outcome: "success",
      correlationId,
    });
    return updated.rows[0];
  }
  /**
   * Create or update an operator/supervisor who can use the operator console and approve
   * settlement. Used by `npm run admin:create`; there is intentionally no public endpoint.
   * Attaches to an existing organisation when tenantId is given, otherwise creates one.
   * Re-running with the same email resets that operator's password and role.
   */
  async createOperator(input: {
    email: unknown;
    password: unknown;
    role?: unknown;
    tenantId?: unknown;
    organizationName?: unknown;
  }): Promise<{
    user_id: string;
    tenant_id: string;
    role: string;
    created: boolean;
  }> {
    const { email, password } = validateCredentials(
      input.email,
      input.password,
    );
    const role =
      input.role === undefined || input.role === "" ? "operator" : input.role;
    if (role !== "operator" && role !== "supervisor") {
      throw new ValidationError("Role must be 'operator' or 'supervisor'.");
    }
    const hash = await hashCredential(password);

    return transaction(async (tx) => {
      let tenantId: string;
      if (typeof input.tenantId === "string" && input.tenantId !== "") {
        if (!UUID_RE.test(input.tenantId))
          throw new ValidationError("ADMIN_TENANT_ID must be a UUID.");
        const found = await tx.query<{ id: string }>(
          `SELECT id FROM tenants WHERE id = $1`,
          [input.tenantId],
        );
        if (!found.rows[0]) throw new NotFoundError("Tenant", input.tenantId);
        tenantId = input.tenantId;
      } else {
        const existing = await tx.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM users WHERE email = $1`,
          [email],
        );
        if (existing.rows[0]) {
          tenantId = existing.rows[0].tenant_id;
        } else {
          const name =
            typeof input.organizationName === "string" &&
            input.organizationName.trim()
              ? input.organizationName.trim().slice(0, 120)
              : "Stoat Operations";
          const created = await tx.query<{ id: string }>(
            `INSERT INTO tenants (name, settings) VALUES ($1, $2) RETURNING id`,
            [name, JSON.stringify({ data_source: "live" })],
          );
          tenantId = created.rows[0].id;
          await scaffoldTenant(tx, tenantId);
        }
      }

      const existing = await tx.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM users WHERE email = $1`,
        [email],
      );
      let userId: string;
      let createdUser: boolean;
      if (existing.rows[0]) {
        if (existing.rows[0].tenant_id !== tenantId) {
          throw new ConflictError(
            "EMAIL_ALREADY_REGISTERED",
            "That email already belongs to a different organization.",
          );
        }
        userId = existing.rows[0].id;
        createdUser = false;
        await tx.query(
          `UPDATE users SET password_hash = $1, role = $2, updated_at = now() WHERE id = $3`,
          [hash, role, userId],
        );
      } else {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO users (tenant_id, email, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
          [tenantId, email, role, hash],
        );
        userId = inserted.rows[0].id;
        createdUser = true;
      }
      await tx.query(
        `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, resource_type, resource_id, correlation_id, outcome, metadata)
         VALUES ($1, 'user', $2, $3, 'user', $2, $4, 'success', $5)`,
        [
          tenantId,
          userId,
          createdUser ? "operator.create" : "operator.reset",
          randomUUID(),
          JSON.stringify({ role }),
        ],
      );
      return {
        user_id: userId,
        tenant_id: tenantId,
        role: role as string,
        created: createdUser,
      };
    });
  }
}
