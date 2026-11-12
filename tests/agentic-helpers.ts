// Shared builders and fast-check arbitraries for the agentic-commerce tests
// (spec agentic-commerce, task 2.7). Builders write through SQL or the real HTTP routes so tests
// exercise the same constraints production does. Tests inject model doubles from llm-double.ts.
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { Decimal } from "decimal.js";
import type { DbClient } from "../src/db/connection.js";
import { sha256 } from "../src/common/crypto.js";
import { SEED_IDS } from "../src/db/seed.js";
import { getOrCreateWallet } from "../src/modules/wallet/wallet.service.js";
import { postJournal } from "../src/modules/wallet/wallet-ledger.js";
import { dispatch } from "./test-utils.js";
import { BUYER } from "./funding-helpers.js";

export { BUYER, PROVIDER, USER, TRUNCATE_ALL } from "./funding-helpers.js";
export * from "./llm-double.js";

export const CATEGORIES = [
  "code-review",
  "security-audit",
  "data-labeling",
  "translation",
  "summarization",
] as const;

// ── Arbitraries ──────────────────────────────────────────────────────────────

/** Whole cents between `min` and `max` (defaults 0.01 to 999,999,999.99) as a two-decimal string. */
export const moneyArb = (min = 1, max = 99_999_999_999): fc.Arbitrary<string> =>
  fc
    .integer({ min, max: Math.min(max, Number.MAX_SAFE_INTEGER) })
    .map((c) => new Decimal(c).div(100).toFixed(2));

/** A smaller range that keeps database-backed runs fast: 0.01 to 1,000.00. */
export const smallMoneyArb: fc.Arbitrary<string> = moneyArb(1, 100_000);

/** Valid cap triple with per_agreement_max <= daily_cap <= total_cap. */
export const capsArb: fc.Arbitrary<{
  per_agreement_max: string;
  daily_cap: string;
  total_cap: string;
}> = fc
  .tuple(
    fc.integer({ min: 1, max: 100_000 }),
    fc.integer({ min: 0, max: 100_000 }),
    fc.integer({ min: 0, max: 100_000 }),
  )
  .map(([a, b, c]) => ({
    per_agreement_max: new Decimal(a).div(100).toFixed(2),
    daily_cap: new Decimal(a + b).div(100).toFixed(2),
    total_cap: new Decimal(a + b + c).div(100).toFixed(2),
  }));

export const currencyArb: fc.Arbitrary<string> = fc.constantFrom(
  "USD",
  "EUR",
  "GBP",
  "JPY",
);

/** 1 to `max` distinct catalog categories. */
export const categoriesArb = (max = 5): fc.Arbitrary<string[]> =>
  fc.uniqueArray(fc.constantFrom(...CATEGORIES), {
    minLength: 1,
    maxLength: Math.min(max, CATEGORIES.length),
  });

/** A date between 2025-01-01 and 2035-01-01 UTC. */
export const dateArb: fc.Arbitrary<Date> = fc.date({
  min: new Date("2025-01-01T00:00:00Z"),
  max: new Date("2035-01-01T00:00:00Z"),
  noInvalidDate: true,
});

/** Whole-hour offset from `base` between `minH` and `maxH` hours. */
export const futureDateArb = (
  base: Date,
  minH = 1,
  maxH = 24 * 30,
): fc.Arbitrary<Date> =>
  fc
    .integer({ min: minH, max: maxH })
    .map((h) => new Date(base.getTime() + h * 3_600_000));

// ── Builders ─────────────────────────────────────────────────────────────────

export interface TestOwner {
  id: string;
  tenantId: string;
  email: string;
  headers: { Authorization: string };
}

/** A fresh tenant with the default (empty) settings. */
export async function createTenant(
  db: DbClient,
  settings: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO tenants (id, name, settings) VALUES ($1, $2, $3::jsonb)`,
    [id, `Tenant ${id.slice(0, 8)}`, JSON.stringify(settings)],
  );
  return id;
}

/** A human user (default role buyer) in a tenant. */
export async function createOwner(
  db: DbClient,
  tenantId: string = SEED_IDS.tenantId,
  role = "buyer",
): Promise<TestOwner> {
  const id = randomUUID();
  const email = `owner-${id}@example.test`;
  await db.query(
    `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, $3, $4)`,
    [id, tenantId, email, role],
  );
  return {
    id,
    tenantId,
    email,
    headers: { Authorization: `Bearer user:${id}` },
  };
}

export const createAdmin = (
  db: DbClient,
  tenantId: string = SEED_IDS.tenantId,
) => createOwner(db, tenantId, "admin");

/** An agent owned by `ownerUserId`; returns its id and bearer header (the agent principal). */
export async function createAgentPrincipal(
  db: DbClient,
  p: { tenantId?: string; ownerUserId: string; role?: string; name?: string },
): Promise<{
  id: string;
  tenantId: string;
  headers: { Authorization: string };
}> {
  const id = randomUUID();
  const tenantId = p.tenantId ?? SEED_IDS.tenantId;
  await db.query(
    `INSERT INTO agents (id, tenant_id, role, name, status, scopes, credential_hash, owner_user_id)
     VALUES ($1, $2, $3, $4, 'active', '[]'::jsonb, $5, $6)`,
    [
      id,
      tenantId,
      p.role ?? "buyer",
      p.name ?? `Test agent ${id.slice(0, 8)}`,
      sha256(id),
      p.ownerUserId,
    ],
  );
  return { id, tenantId, headers: { Authorization: `Bearer agent:${id}` } };
}

/** The owner's wallet, optionally funded by a balanced journal entry (1101 cash, 2103 wallet liability). */
export async function createWallet(
  db: DbClient,
  p: {
    tenantId?: string;
    ownerUserId: string;
    currency?: string;
    funded?: string;
  },
) {
  const tenantId = p.tenantId ?? SEED_IDS.tenantId;
  const currency = p.currency ?? "USD";
  const wallet = await getOrCreateWallet(db, {
    tenantId,
    ownerUserId: p.ownerUserId,
    currency,
  });
  if (p.funded && new Decimal(p.funded).gt(0)) {
    const eventId = randomUUID();
    await db.query(
      `INSERT INTO economic_events (id, tenant_id, aggregate_type, aggregate_id, sequence, event_type, actor_type, actor_id, correlation_id, payload_hash)
       VALUES ($1, $2, 'wallet', $3, 1, 'test', 'system', $4, $5, 'h')`,
      [eventId, tenantId, wallet.id, randomUUID(), randomUUID()],
    );
    await postJournal(db, {
      tenantId,
      eventId,
      reference: `wallet:test:${eventId}`,
      currency,
      lines: [
        { accountCode: "1101", side: "debit", amount: p.funded },
        {
          accountCode: "2103",
          side: "credit",
          amount: p.funded,
          walletId: wallet.id,
        },
      ],
    });
  }
  return wallet;
}

/** Puts the tenant in wallet funding mode (acceptance reserves from the wallet). */
export const setFundingMode = (
  db: DbClient,
  tenantId: string,
  mode: "direct" | "wallet",
) =>
  db.query(
    `UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object('funding_mode', $2::text) WHERE id = $1`,
    [tenantId, mode],
  );

/** Turns agentic flags on (or off) for a tenant by writing settings directly; tests of setFlag itself use the service. */
export const setFlags = (
  db: DbClient,
  tenantId: string,
  flags: Record<string, boolean>,
) =>
  db.query(
    `UPDATE tenants SET settings = jsonb_set(COALESCE(settings,'{}'::jsonb), '{feature_flags}',
       COALESCE(settings->'feature_flags','{}'::jsonb) || $2::jsonb, true) WHERE id = $1`,
    [tenantId, JSON.stringify(flags)],
  );

/** Mission through the real route, owned by the given buyer agent (default: the seeded buyer). */
export async function createMission(
  app: any,
  o: {
    budget?: string;
    currency?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<string> {
  const r = await dispatch(app, {
    method: "POST",
    url: "/missions",
    headers: o.headers ?? BUYER,
    body: {
      title: `Agentic Mission ${randomUUID()}`,
      brief: "Review the fixture",
      budget: o.budget ?? "50.000000",
      currency: o.currency ?? "USD",
    },
  });
  return r.body.id as string;
}

/** Open quote on a mission through the real route. Does not accept it. */
export async function createQuote(
  app: any,
  missionId: string,
  o: { serviceId?: string; headers?: Record<string, string> } = {},
): Promise<string> {
  const r = await dispatch(app, {
    method: "POST",
    url: "/quotes",
    headers: o.headers ?? BUYER,
    body: {
      mission_id: missionId,
      service_id: o.serviceId ?? SEED_IDS.aiServiceId,
      requested_scope: { files: ["src/auth.ts"] },
    },
  });
  return r.body.id as string;
}

export interface MandateTerms {
  per_agreement_max: string;
  daily_cap: string;
  total_cap: string;
  allowed_categories: string[];
  mission_scope: string[] | null;
  expires_at: Date;
  currency: string;
}

export const defaultMandateTerms = (now: Date = new Date()): MandateTerms => ({
  per_agreement_max: "10.00",
  daily_cap: "50.00",
  total_cap: "200.00",
  allowed_categories: [...CATEGORIES.slice(0, 2)],
  mission_scope: null,
  expires_at: new Date(now.getTime() + 7 * 24 * 3_600_000),
  currency: "USD",
});

/**
 * Inserts a Mandate directly (the same columns MandateService.create writes) so tests of the
 * evaluator, guards and sweeps do not depend on the service. `terms_hash` is the SHA-256 of the
 * canonical terms.
 */
export async function createMandate(
  db: DbClient,
  p: {
    tenantId?: string;
    ownerUserId: string;
    walletId: string;
  } & Partial<MandateTerms> & { status?: string; idempotencyKey?: string },
): Promise<{ id: string; terms: MandateTerms }> {
  const tenantId = p.tenantId ?? SEED_IDS.tenantId;
  const terms: MandateTerms = {
    ...defaultMandateTerms(),
    ...stripUndefined({
      per_agreement_max: p.per_agreement_max,
      daily_cap: p.daily_cap,
      total_cap: p.total_cap,
      allowed_categories: p.allowed_categories,
      mission_scope: p.mission_scope,
      expires_at: p.expires_at,
      currency: p.currency,
    }),
  };
  const id = randomUUID();
  const key = p.idempotencyKey ?? randomUUID();
  const termsHash = sha256({
    ...terms,
    expires_at: terms.expires_at.toISOString(),
    wallet_id: p.walletId,
  });
  await db.query(
    `INSERT INTO mandates (id, tenant_id, owner_user_id, wallet_id, currency, per_agreement_max, daily_cap, total_cap,
       allowed_categories, mission_scope, expires_at, status, terms_hash, signed_by, idempotency_key, request_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$3,$14,$15)`,
    [
      id,
      tenantId,
      p.ownerUserId,
      p.walletId,
      terms.currency,
      terms.per_agreement_max,
      terms.daily_cap,
      terms.total_cap,
      terms.allowed_categories,
      terms.mission_scope,
      terms.expires_at.toISOString(),
      p.status ?? "active",
      termsHash,
      key,
      sha256(key),
    ],
  );
  return { id, terms };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
