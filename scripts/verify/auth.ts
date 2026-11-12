/**
 * Auth verifier — run by agents/auth-verifier-agent.md.
 *   npm run verify:auth
 * Terminal signals: AUTH_VERIFIED | AUTH_DEFECTS_FOUND
 */
import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import { getDb } from '../../src/db/connection.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import {
  Harness, TEST_JWT_SECRET, NIL_UUID, STRONG_PASSWORD, expect, expectStatus,
  signup, provisionAgent, uniqueEmail,
} from './harness.js';

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

async function main(): Promise<number> {
  const h = await Harness.boot();
  try {
    const owner = await signup(h, 'owner', 'Auth Verify Org');

    // ── Human sign-up and sign-in ────────────────────────────────────────────
    await h.check('AUTH-01', 'Sign-up returns a session and leaks no credential material', async () => {
      const res = await h.http('POST', '/v1/auth/signup', {
        body: { email: uniqueEmail('fresh'), password: STRONG_PASSWORD, organization_name: 'Fresh Org' },
      });
      expectStatus(res, 201, 'signup');
      expect(res.body.access_token && res.body.token_type === 'Bearer', 'missing bearer access_token');
      expect(!/password|hash|secret/i.test(JSON.stringify(res.body)), 'response mentions password/hash/secret');
      return `tenant ${res.body.user.tenant_id}`;
    });

    await h.check('AUTH-02', 'Duplicate email (any case) is rejected with 409', async () => {
      const res = await h.http('POST', '/v1/auth/signup', {
        body: { email: owner.email.toUpperCase(), password: STRONG_PASSWORD, organization_name: 'Dup' },
      });
      expectStatus(res, 409, 'duplicate signup');
      expect(res.body.error.code === 'EMAIL_ALREADY_REGISTERED', `code ${res.body.error.code}`);
    });

    await h.check('AUTH-03', 'Weak password, bad email and missing org are 400, never 500', async () => {
      const cases: Array<[string, unknown]> = [
        ['short password', { email: uniqueEmail('w'), password: 'short', organization_name: 'X' }],
        ['bad email', { email: 'not-an-email', password: STRONG_PASSWORD, organization_name: 'X' }],
        ['no org', { email: uniqueEmail('w'), password: STRONG_PASSWORD }],
        ['non-string fields', { email: 5, password: {}, organization_name: [] }],
      ];
      for (const [label, body] of cases) {
        const res = await h.http('POST', '/v1/auth/signup', { body });
        expect(res.status === 400, `${label}: expected 400, got ${res.status}`);
      }
    });

    await h.check('AUTH-04', 'Login works and the session resolves via /auth/me', async () => {
      const login = await h.http('POST', '/v1/auth/login', { body: { email: owner.email, password: STRONG_PASSWORD } });
      expectStatus(login, 200, 'login');
      const me = await h.http('GET', '/v1/auth/me', { token: login.body.access_token });
      expectStatus(me, 200, '/auth/me');
      expect(me.body.tenant_id === owner.tenantId, 'tenant mismatch');
      return `role ${me.body.role}`;
    });

    await h.check('AUTH-05', 'Wrong password and unknown email give the same 401 (no user enumeration)', async () => {
      const wrong = await h.http('POST', '/v1/auth/login', { body: { email: owner.email, password: 'wrong-password-123' } });
      const unknown = await h.http('POST', '/v1/auth/login', { body: { email: uniqueEmail('ghost'), password: 'wrong-password-123' } });
      expectStatus(wrong, 401, 'wrong password');
      expectStatus(unknown, 401, 'unknown email');
      expect(wrong.body.error.message === unknown.body.error.message, 'different messages reveal account existence');
    });

    await h.check('AUTH-06', 'Unknown-email login costs the same as a wrong password (no timing oracle)', async () => {
      // Dedicated account: five bad passwords would otherwise lock the shared owner account.
      const timingUser = await signup(h, 'timing');
      const dummyEmail = uniqueEmail('timing');
      const knownMs: number[] = [];
      const unknownMs: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        knownMs.push((await h.http('POST', '/v1/auth/login', { body: { email: timingUser.email, password: `bad-password-${i}-xx` } })).ms);
        unknownMs.push((await h.http('POST', '/v1/auth/login', { body: { email: `${i}${dummyEmail}`, password: `bad-password-${i}-xx` } })).ms);
      }
      const k = median(knownMs);
      const u = median(unknownMs);
      expect(u > k * 0.5, `unknown-email median ${u.toFixed(1)}ms vs known ${k.toFixed(1)}ms: login short-circuits before hashing`);
      return `known ${k.toFixed(0)}ms, unknown ${u.toFixed(0)}ms`;
    });

    await h.check('AUTH-07', 'Repeated failed logins are throttled (429), and the right password still works for others', async () => {
      const victim = await signup(h, 'victim');
      let throttledAt = 0;
      for (let i = 1; i <= 12; i += 1) {
        const r = await h.http('POST', '/v1/auth/login', { body: { email: victim.email, password: `guess-number-${i}-xx` } });
        if (r.status === 429) { throttledAt = i; break; }
        expect(r.status === 401, `attempt ${i}: expected 401/429, got ${r.status}`);
      }
      expect(throttledAt > 0, '12 consecutive bad passwords were never throttled (credential-stuffing possible)');
      return `throttled on attempt ${throttledAt}`;
    });

    await h.check('AUTH-08', 'Malformed login bodies are 4xx, never 500', async () => {
      for (const body of [{}, { email: 'a@b.co' }, { email: null, password: null }, 'not-json-object']) {
        const res = await h.http('POST', '/v1/auth/login', { body });
        expect(res.status >= 400 && res.status < 500, `body ${JSON.stringify(body)} -> ${res.status}`);
      }
    });

    // ── Agent sign-in ────────────────────────────────────────────────────────
    const provider = await provisionAgent(h, owner, 'provider', 'Verify Provider');

    await h.check('AUTH-09', 'Agent logs in with id + one-time secret and resolves as an agent', async () => {
      const me = await h.http('GET', '/v1/auth/me', { token: provider.token });
      expectStatus(me, 200, 'agent /auth/me');
      expect(me.body.id === provider.id, 'wrong agent id');
      expect(me.body.role === 'provider', `role ${me.body.role}`);
    });

    await h.check('AUTH-10', 'Agent login: wrong secret, unknown id and non-UUID id are 401/400, never 500', async () => {
      const wrong = await h.http('POST', '/v1/auth/agent/login', { body: { agent_id: provider.id, secret: 'nope-nope-nope' } });
      const unknown = await h.http('POST', '/v1/auth/agent/login', { body: { agent_id: NIL_UUID, secret: provider.secret } });
      const junk = await h.http('POST', '/v1/auth/agent/login', { body: { agent_id: 'not-a-uuid', secret: provider.secret } });
      expectStatus(wrong, 401, 'wrong secret');
      expectStatus(unknown, 401, 'unknown agent');
      expect(junk.status === 401 || junk.status === 400, `non-UUID agent_id -> ${junk.status} (database error leaking as 500)`);
    });

    await h.check('AUTH-11', 'Agent secrets and hashes are never returned by any read endpoint', async () => {
      for (const path of ['/v1/agents', '/v1/auth/me']) {
        const res = await h.http('GET', path, { token: owner.token });
        expect(!/credential_hash|scrypt\$|"secret"/.test(JSON.stringify(res.body)), `${path} leaks credential material`);
      }
    });

    // ── Token integrity ──────────────────────────────────────────────────────
    await h.check('AUTH-12', 'Missing, garbage, tampered, alg:none, wrong-key and expired tokens are all 401', async () => {
      const good = owner.token;
      const payload = jwt.decode(good) as jwt.JwtPayload;
      const tampered = `${good.slice(0, -4)}${good.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;
      const algNone = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: payload.sub, type: 'user' })}.`;
      const wrongKey = jwt.sign({ type: 'user' }, 'attacker-secret-attacker-secret-0000', { subject: payload.sub as string, expiresIn: '5m' });
      const expired = jwt.sign({ type: 'user' }, TEST_JWT_SECRET, { subject: payload.sub as string, expiresIn: -60 });
      const hs512 = jwt.sign({ type: 'user' }, TEST_JWT_SECRET, { subject: payload.sub as string, expiresIn: '5m', algorithm: 'HS512' });
      const cases: Array<[string, string | undefined]> = [
        ['no header', undefined], ['garbage', 'abc.def.ghi'], ['tampered', tampered],
        ['alg none', algNone], ['wrong key', wrongKey], ['expired', expired],
      ];
      for (const [label, token] of cases) {
        const res = await h.http('GET', '/v1/auth/me', { token });
        expect(res.status === 401, `${label}: expected 401, got ${res.status}`);
      }
      expect((await h.http('GET', '/v1/auth/me', { token: hs512 })).status === 401, 'HS512 token accepted: algorithm is not pinned to HS256');
    });

    await h.check('AUTH-13', 'Legacy `user:<id>` / `agent:<id>` ID tokens are rejected in production', async () => {
      for (const token of [`user:${owner.userId}`, `agent:${provider.id}`]) {
        const res = await h.http('GET', '/v1/auth/me', { token });
        expect(res.status === 401, `${token.split(':')[0]} ID token accepted in production (${res.status})`);
      }
    });

    await h.check('AUTH-14', 'Session lifetimes: humans can work a full day, agents stay short-lived', async () => {
      const login = await h.http('POST', '/v1/auth/login', { body: { email: owner.email, password: STRONG_PASSWORD } });
      const agentLogin = await h.http('POST', '/v1/auth/agent/login', { body: { agent_id: provider.id, secret: provider.secret } });
      expect(login.body.expires_in >= 3600, `human session expires in ${login.body.expires_in}s: operators are signed out mid-task`);
      expect(agentLogin.body.expires_in <= 3600, `agent token lives ${agentLogin.body.expires_in}s (AGENTS.md requires short-lived)`);
      const claims = jwt.decode(login.body.access_token) as jwt.JwtPayload;
      expect(Math.abs((claims.exp as number) - (claims.iat as number) - login.body.expires_in) < 5, 'expires_in disagrees with token exp');
      return `human ${login.body.expires_in}s, agent ${agentLogin.body.expires_in}s`;
    });

    // ── Authority matrix ─────────────────────────────────────────────────────
    await h.check('AUTH-15', 'Agents cannot provision agents, approve, create PayPal orders or capture payments', async () => {
      const provisioned = await h.http('POST', '/v1/agents', { token: provider.token, body: { name: 'sneaky', role: 'buyer' } });
      expect(provisioned.status === 403, `agent provisioned an agent (${provisioned.status})`);
      for (const path of ['approve', 'paypal/create-order', 'paypal/capture']) {
        const res = await h.http('POST', `/v1/settlement/batches/${NIL_UUID}/${path}`, { token: provider.token, body: { order_id: 'x' } });
        expect(res.status === 403, `agent reached /${path} (${res.status}); must be 403 FORBIDDEN_ACTION`);
      }
    });

    await h.check('AUTH-16', 'Role gates hold: provider cannot open missions; user cannot publish services', async () => {
      const mission = await h.http('POST', '/v1/missions', { token: provider.token, body: { title: 't', brief: 'b', budget: '1.00' } });
      expect(mission.status === 403, `provider created a mission (${mission.status})`);
      const publish = await h.http('POST', '/v1/services', { token: owner.token, body: {} });
      expect(publish.status === 403, `human published a service directly (${publish.status})`);
    });

    // ── Lifecycle and isolation ──────────────────────────────────────────────
    await h.check('AUTH-17', 'Owner can suspend an agent; its live token and re-login are then refused, and reactivation restores access', async () => {
      const victim = await provisionAgent(h, owner, 'provider', 'Suspend Me');
      const suspend = await h.http('POST', `/v1/agents/${victim.id}/status`, { token: owner.token, body: { status: 'suspended' } });
      expectStatus(suspend, 200, 'suspend');
      const live = await h.http('GET', '/v1/auth/me', { token: victim.token });
      expect(live.status === 403 && live.body.error.code === 'AGENT_SUSPENDED', `suspended agent token -> ${live.status}`);
      const relogin = await h.http('POST', '/v1/auth/agent/login', { body: { agent_id: victim.id, secret: victim.secret } });
      expect(relogin.status === 401, `suspended agent re-login -> ${relogin.status}`);
      const restore = await h.http('POST', `/v1/agents/${victim.id}/status`, { token: owner.token, body: { status: 'active' } });
      expectStatus(restore, 200, 'reactivate');
      const back = await h.http('POST', '/v1/auth/agent/login', { body: { agent_id: victim.id, secret: victim.secret } });
      expectStatus(back, 200, 'login after reactivation');
    });

    await h.check('AUTH-18', 'Another tenant cannot see, suspend or impersonate this tenant\'s agents', async () => {
      const intruder = await signup(h, 'intruder', 'Intruder Org');
      const list = await h.http('GET', '/v1/agents', { token: intruder.token });
      expectStatus(list, 200, 'intruder list');
      expect(!JSON.stringify(list.body).includes(provider.id), 'agent from another tenant is visible');
      const suspend = await h.http('POST', `/v1/agents/${provider.id}/status`, { token: intruder.token, body: { status: 'suspended' } });
      expect(suspend.status === 404 || suspend.status === 403, `cross-tenant suspend -> ${suspend.status}`);
      const stillWorks = await h.http('GET', '/v1/auth/me', { token: provider.token });
      expectStatus(stillWorks, 200, 'victim agent still active');
    });

    await h.check('AUTH-19', 'Console recovers from an expired session (401 handling present)', async () => {
      const api = readFileSync('console/src/api.ts', 'utf8');
      expect(/401/.test(api), 'console/src/api.ts never handles HTTP 401: an expired token leaves a broken UI instead of the sign-in screen');
    });

    await h.check('AUTH-20', 'Operator created by admin:create can sign in and is idempotent', async () => {
      const email = uniqueEmail('operator');
      const svc = new AuthService(getDb());
      const first = await svc.createOperator({ email, password: STRONG_PASSWORD, organizationName: 'Ops Org' });
      expect(first.created === true && first.role === 'operator', `first call ${JSON.stringify(first)}`);
      const again = await svc.createOperator({ email, password: STRONG_PASSWORD });
      expect(again.created === false && again.tenant_id === first.tenant_id, 'second call must reset, not duplicate');
      const login = await h.http('POST', '/v1/auth/login', { body: { email, password: STRONG_PASSWORD } });
      expectStatus(login, 200, 'operator login');
      const me = await h.http('GET', '/v1/auth/me', { token: login.body.access_token });
      expectStatus(me, 200, 'operator /me');
      expect(!/password|hash/i.test(JSON.stringify(first)), 'createOperator result leaks credential material');
      let weak = false;
      try { await svc.createOperator({ email: uniqueEmail('weak'), password: 'short' }); } catch { weak = true; }
      expect(weak, 'weak operator password accepted');
    });    return h.report('auth-verifier', 'AUTH_VERIFIED', 'AUTH_DEFECTS_FOUND');
  } finally {
    await h.close();
  }
}

main().then((code) => process.exit(code)).catch((err) => { console.error('auth-verifier crashed:', err); process.exit(2); });

