/**
 * Database connection — Drizzle ORM over `postgres` (Supabase-compatible).
 *
 * Connection is determined at startup from DATABASE_URL in .env:
 *
 *   Supabase (production / staging):
 *     DATABASE_URL=postgresql://postgres.[ref]:[pass]@aws-0-[region].pooler.supabase.com:6543/postgres
 *
 *   Local Postgres:
 *     DATABASE_URL=postgresql://user:password@localhost:5432/dbname
 *
 *   Embedded PGlite (no DATABASE_URL or memory:// — local dev / tests):
 *     DATABASE_URL=    (blank)
 *
 * The exported `DbClient` interface is intentionally identical to the previous
 * pg.Pool wrapper, so every service file continues to call `.query(sql, params)`
 * without any changes. Drizzle's SQL-tagged template and query builder are
 * available via `getDrizzle()` when new code wants typed queries.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import { AnalyticsTimeoutError } from "../modules/agentic/commerce-errors.js";

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface DbClient {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
}

// ── Module-level singletons ────────────────────────────────────────────────────
let pgClient: postgres.Sql | null = null;
let drizzleDb: PostgresJsDatabase<typeof schema> | null = null;
let pgliteInstance: PGlite | null = null;

// ── Supabase / Postgres connection options ─────────────────────────────────────

function buildPostgresOptions(url: string): postgres.Options<any> {
  const parsed = (() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  })();

  const isSupabase = parsed
    ? parsed.hostname.endsWith(".supabase.com") ||
      parsed.hostname.endsWith(".supabase.co") ||
      parsed.hostname.includes("pooler.supabase")
    : false;

  // Supabase's transaction pooler (Supavisor/PgBouncer, port 6543) hands each statement to any
  // free backend, so prepared statements break and long-lived connections can be dropped by the
  // pooler. postgres.js must run with prepare:false there (Supabase guidance), and connections are
  // recycled so a silently dropped one cannot leave requests waiting forever.
  const isTransactionPooler =
    (parsed?.port === "6543" || url.includes(":6543/")) &&
    (isSupabase || url.includes("pooler"));

  const isRender =
    url.includes(".render.com") ||
    url.includes("dpg-") ||
    process.env.RENDER === "true";
  const isVercel = process.env.VERCEL === "1";

  // Supabase pooler (port 6543) requires no SSL verify; direct (5432) uses verify-full.
  // Render internal connections need rejectUnauthorized:false for self-signed certs.
  const ssl: postgres.Options<any>["ssl"] = isSupabase
    ? {
        // Direct host (db.<ref>.supabase.co:5432) → verify. The pooler host (either port) → skip,
        // as before for 6543; session mode (pooler :5432) uses the same certificate.
        rejectUnauthorized: parsed?.port === "5432" && !url.includes("pooler"),
      }
    : isRender
      ? { rejectUnauthorized: false }
      : undefined;

  return {
    max: parseInt(process.env.PGPOOL_MAX ?? (isVercel ? "2" : "10"), 10),
    idle_timeout: isTransactionPooler ? 20 : 30,
    connect_timeout: 10,
    // Recycle pooled connections (seconds) so a connection the pooler dropped is replaced.
    max_lifetime: parseInt(
      process.env.PG_MAX_LIFETIME_S ?? (isTransactionPooler ? "300" : "1800"),
      10,
    ),
    // Transaction pooling cannot keep prepared statements; PG_PREPARE=true forces them back on.
    prepare: process.env.PG_PREPARE
      ? process.env.PG_PREPARE === "true"
      : !isTransactionPooler,
    ...(ssl !== undefined ? { ssl } : {}),
    // In ESM builds `postgres` uses native BigInt; coerce to string for compatibility
    // with existing code that treats NUMERIC columns as strings (Decimal.js).
    types: {
      bigint: postgres.BigInt,
    },
    // Forward Postgres notices to stderr so Render's log stream picks them up.
    onnotice: (notice: postgres.Notice) => {
      if (notice.severity !== "NOTICE") {
        process.stderr.write(`[DB notice] ${notice.message}\n`);
      }
    },
  };
}

// ── Initialise ────────────────────────────────────────────────────────────────

export function initDb(options?: {
  databaseUrl?: string;
  forceEmbedded?: boolean;
}): DbClient {
  const url = options?.databaseUrl ?? process.env.DATABASE_URL;

  if (!options?.forceEmbedded && url && !url.startsWith("memory:")) {
    if (!pgClient) {
      pgClient = postgres(url, buildPostgresOptions(url));
      drizzleDb = drizzle(pgClient, { schema });
      pgClient
        .listen?.("stoat_error", (msg) =>
          process.stderr.write(`[DB listen] ${msg}\n`),
        )
        .catch(() => undefined);
    }
    return makePostgresClient();
  }

  // Embedded PGlite — local dev, tests, no DATABASE_URL
  if (!pgliteInstance) {
    pgliteInstance = new PGlite();
  }
  return makePgliteClient();
}

// ── Typed Drizzle instance (available after initDb with a real URL) ────────────
/**
 * Returns the typed Drizzle query builder. Throws if called before `initDb()` or
 * when using the embedded PGlite (query builder is not available in that case).
 * Use this for new typed query code; existing services can keep using `DbClient.query()`.
 */
export function getDrizzle(): PostgresJsDatabase<typeof schema> {
  if (!drizzleDb) {
    throw new Error(
      "Drizzle instance is not initialised. Call initDb() with a DATABASE_URL first.",
    );
  }
  return drizzleDb;
}

// ── Singleton accessor ─────────────────────────────────────────────────────────

export function getDb(): DbClient {
  if (pgClient) return makePostgresClient();
  if (pgliteInstance) return makePgliteClient();
  return initDb();
}

// ── postgres.js DbClient wrapper ──────────────────────────────────────────────

function makePostgresClient(): DbClient {
  return {
    async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
      // postgres.js uses tagged templates; for parameterised queries we pass
      // the values array as the second argument to the unsafe() helper.
      const rows = params?.length
        ? await pgClient!.unsafe<T[]>(sql, params as any[])
        : await pgClient!.unsafe<T[]>(sql);
      return { rows: rows as T[], rowCount: rows.length };
    },
    async exec(sql: string): Promise<void> {
      await pgClient!.unsafe(sql);
    },
  };
}

// ── PGlite DbClient wrapper ────────────────────────────────────────────────────

function makePgliteClient(): DbClient {
  return {
    async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
      const res = await pgliteInstance!.query<T>(sql, params);
      return { rows: res.rows as T[], rowCount: res.rows.length };
    },
    async exec(sql: string): Promise<void> {
      await pgliteInstance!.exec(sql);
    },
  };
}

// ── Transactions ──────────────────────────────────────────────────────────────

export async function transaction<T>(
  fn: (client: DbClient) => Promise<T>,
): Promise<T> {
  if (pgClient) {
    // postgres.js transactions: the `sql` function passed inside is scoped to
    // the transaction connection; we wrap it in the DbClient interface.
    return pgClient.begin(async (tx) => {
      const txClient: DbClient = {
        async query<R = any>(
          sql: string,
          params?: any[],
        ): Promise<QueryResult<R>> {
          const rows = params?.length
            ? await tx.unsafe<R[]>(sql, params as any[])
            : await tx.unsafe<R[]>(sql);
          return { rows: rows as R[], rowCount: rows.length };
        },
        async exec(sql: string): Promise<void> {
          await tx.unsafe(sql);
        },
      };
      return fn(txClient);
    }) as Promise<T>;
  }

  // PGlite — one shared connection, so concurrent BEGIN/COMMIT pairs would
  // interleave. Chain each transaction behind the previous one (promise-chain mutex).
  const run = pgliteTail.then(async () => {
    const db = makePgliteClient();
    await db.exec("BEGIN");
    try {
      const result = await fn(db);
      await db.exec("COMMIT");
      return result;
    } catch (err) {
      await db.exec("ROLLBACK");
      throw err;
    }
  });
  // The tail never rejects, so one failed transaction does not block the next.
  pgliteTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Run `fn` in a READ ONLY transaction with a statement timeout. A query that exceeds
 * `timeoutMs` is cancelled (SQLSTATE 57014) and surfaces as `ANALYTICS_TIMEOUT`.
 * Works on Postgres and PGlite; existing callers of `transaction` are unaffected.
 */
export async function readOnlyTransaction<T>(
  fn: (client: DbClient) => Promise<T>,
  options: { timeoutMs: number },
): Promise<T> {
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AnalyticsTimeoutError()), timeoutMs);
  });
  const work = transaction(async (tx) => {
    await tx.exec("SET TRANSACTION READ ONLY");
    await tx.exec(`SET LOCAL statement_timeout = ${timeoutMs}`);
    return fn(tx);
  }).catch((err) => {
    if ((err as { code?: string } | null)?.code === "57014")
      throw new AnalyticsTimeoutError();
    throw err;
  });
  try {
    // The race backs up statement_timeout where the engine cannot cancel a running query.
    const started = Date.now();
    const result = await Promise.race([work, timedOut]);
    // PGlite runs queries synchronously on the event loop, so the timer cannot fire mid-query.
    if (Date.now() - started > timeoutMs) throw new AnalyticsTimeoutError();
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    work.catch(() => undefined);
  }
}

/** Tail of the PGlite transaction queue. */
let pgliteTail: Promise<void> = Promise.resolve();

// ── Lifecycle helpers ─────────────────────────────────────────────────────────

export async function closeDb(): Promise<void> {
  if (pgClient) {
    await pgClient.end();
    pgClient = null;
    drizzleDb = null;
  }
  if (pgliteInstance) {
    await pgliteInstance.close();
    pgliteInstance = null;
    pgliteTail = Promise.resolve();
  }
}

export async function resetDb(): Promise<void> {
  await closeDb();
  initDb({ forceEmbedded: true });
}

/** Exported for tests that need to assert the configured pool config. */
export function getPgPoolConfig(url: string) {
  return buildPostgresOptions(url);
}
