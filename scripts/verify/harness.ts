/**
 * Verification harness — shared by the auth-verifier and platform-journey agents.
 *
 * Boots the real Express app on an ephemeral port with a fresh embedded Postgres
 * (PGlite), in PRODUCTION mode and WITHOUT seed data, then drives it over real HTTP
 * with fetch. That matches a fresh Render deploy: legacy `user:`/`agent:` ID tokens are
 * disabled, there is no seeded marketplace, and request bodies go through express.json.
 *
 * Nothing here is mocked. A check passes only on observed behaviour.
 */
import 'dotenv/config'; // real PayPal Sandbox credentials, if present
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PayPalGateway } from '../../src/modules/paypal/paypal.gateway.js';

export const TEST_JWT_SECRET = 'verify-harness-jwt-secret-0123456789abcdef';
export const NIL_UUID = '00000000-0000-4000-8000-000000000000';

export type CheckStatus = 'PASS' | 'FAIL' | 'NOTE' | 'MANUAL';
export interface Check {
  id: string;
  name: string;
  status: CheckStatus;
  evidence: string;
}

export interface HttpResult {
  status: number;
  body: any;
  ms: number;
}

export class AssertionFailure extends Error {}

export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionFailure(message);
}

export function expectStatus(res: HttpResult, status: number, context: string): void {
  expect(res.status === status, `${context}: expected HTTP ${status}, got ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
}

export class Harness {
  readonly checks: Check[] = [];
  private constructor(private server: Server, readonly base: string) {}

  /**
   * Boot the app on embedded PGlite (resetDb), never touching a production database.
   * gateway is passed to createApp({ gateway }); only verify scripts and tests may supply a double.
   */
  static async boot(opts: { gateway?: PayPalGateway } = {}): Promise<Harness> {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    delete process.env.DATABASE_URL;
    delete process.env.RENDER;
    process.env.LLM_MODE = 'replay';
    process.env.REQUIRE_FUNDING = 'false'; // individual checks switch it on to test the gate

    const { resetDb, getDb } = await import('../../src/db/connection.js');
    const { runMigrations } = await import('../../src/db/migrate.js');
    const { createApp } = await import('../../src/api/app.js');

    await resetDb();
    await runMigrations(getDb());
    const app = createApp(opts.gateway ? { gateway: opts.gateway } : undefined);
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    return new Harness(server, `http://127.0.0.1:${port}`);
  }

  async http(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<HttpResult> {
    const started = performance.now();
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body is kept as text */
    }
    return { status: res.status, body, ms: performance.now() - started };
  }

  /** Run one check. A thrown error is a FAIL; a returned string is the evidence. */
  async check(id: string, name: string, fn: () => Promise<string | void>): Promise<void> {
    try {
      const evidence = (await fn()) ?? 'ok';
      this.checks.push({ id, name, status: 'PASS', evidence });
    } catch (err) {
      this.checks.push({ id, name, status: 'FAIL', evidence: (err as Error).message });
    }
  }

  /** A check that cannot complete (timeout, unreachable dependency) is recorded as FAIL with the reason. */
  async checkWithin(id: string, name: string, timeoutMs: number, fn: () => Promise<string | void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('could not complete: timed out after ' + timeoutMs + ' ms')), timeoutMs);
    });
    try {
      await this.check(id, name, () => Promise.race([fn(), limit]));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** A step only a person can perform (for example PayPal Sandbox approval). Never fails the run. */
  manual(id: string, name: string, evidence: string): void {
    this.checks.push({ id, name, status: 'MANUAL', evidence });
  }

  note(id: string, name: string, evidence: string): void {
    this.checks.push({ id, name, status: 'NOTE', evidence });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    const { closeDb } = await import('../../src/db/connection.js');
    await closeDb();
  }

  /** Print a table, persist JSON for the agent to read, return the process exit code. */
  report(agent: string, terminalPass: string, terminalFail: string): number {
    const failed = this.checks.filter((c) => c.status === 'FAIL');
    const passed = this.checks.filter((c) => c.status === 'PASS').length;
    for (const c of this.checks) {
      const icon = c.status;
      console.log(`${icon}  ${c.id.padEnd(9)} ${c.name}${c.status === 'PASS' ? '' : `\n          -> ${c.evidence}`}`);
    }
    const manual = this.checks.filter((c) => c.status === 'MANUAL').length;
    const signal = failed.length === 0 ? terminalPass : terminalFail;
    console.log(`\n${agent}: ${passed} passed, ${failed.length} failed, ${manual} manual -> ${signal}`);

    const dir = join(process.cwd(), '.agents', 'reports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${agent}.json`),
      JSON.stringify({ agent, signal, generated_at: new Date().toISOString(), passed, failed: failed.length, manual, checks: this.checks }, null, 2),
    );
    return failed.length === 0 ? 0 : 1;
  }
}

let counter = 0;
export function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}.${Date.now().toString(36)}.${counter}@verify.stoat.test`;
}

export const STRONG_PASSWORD = 'correct-horse-battery-staple';

export interface Account {
  email: string;
  token: string;
  userId: string;
  tenantId: string;
}

export async function signup(h: Harness, prefix: string, org = `Org ${prefix}`): Promise<Account> {
  const email = uniqueEmail(prefix);
  const res = await h.http('POST', '/v1/auth/signup', {
    body: { email, password: STRONG_PASSWORD, organization_name: org },
  });
  expectStatus(res, 201, 'signup');
  return { email, token: res.body.access_token, userId: res.body.user.id, tenantId: res.body.user.tenant_id };
}

export interface ProvisionedAgent {
  id: string;
  secret: string;
  token: string;
}

export async function provisionAgent(h: Harness, owner: Account, role: 'buyer' | 'provider', name: string): Promise<ProvisionedAgent> {
  const created = await h.http('POST', '/v1/agents', { token: owner.token, body: { name, role } });
  expectStatus(created, 201, `provision ${role} agent`);
  const id = created.body.agent.id as string;
  const secret = created.body.secret as string;
  const login = await h.http('POST', '/v1/auth/agent/login', { body: { agent_id: id, secret } });
  expectStatus(login, 200, `${role} agent login`);
  return { id, secret, token: login.body.access_token };
}

/** Money-route status helpers shared by the wallet verifiers. */
export function expectCode(res: HttpResult, status: number, code: string, context: string): void {
  expectStatus(res, status, context);
  const got = res.body?.error?.code ?? res.body?.code;
  expect(got === code, `${context}: expected error code ${code}, got ${JSON.stringify(got)}`);
}

/** Read one wallet's balance as a string; 'undefined' routes fail the calling check. */
export async function walletBalance(h: Harness, who: Account): Promise<unknown> {
  const res = await h.http('GET', '/v1/wallet', { token: who.token });
  expectStatus(res, 200, 'GET /v1/wallet');
  return res.body;
}

/** Run a verifier main() and exit non-zero if it throws, so an unfinished script is never green. */
export async function runVerifier(agent: string, main: () => Promise<number>): Promise<never> {
  try {
    process.exit(await main());
  } catch (err) {
    console.error(`${agent}: could not complete: ${(err as Error).message}`);
    process.exit(1);
  }
}
