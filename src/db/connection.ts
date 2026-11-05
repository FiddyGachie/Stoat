import pg from "pg";
import { PGlite } from "@electric-sql/pglite";

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface DbClient {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
}

let pgPool: pg.Pool | null = null;
let pgliteInstance: PGlite | null = null;
let isPgliteMode = false;

export function isEmbeddedPostgres(): boolean {
  return isPgliteMode;
}

/**
 * Build pg.Pool config from a DATABASE_URL, adding SSL settings appropriate
 * for Render Postgres (internal URL uses self-signed cert; sslmode=require).
 */
function buildPgPoolConfig(url: string): pg.PoolConfig {
  const isRender = process.env.RENDER === "true";
  const isRenderInternal = url.includes(".render.com") || url.includes("dpg-");

  const base: pg.PoolConfig = {
    connectionString: url,
    // Free-tier Render Postgres allows up to 25 connections; cap below that.
    // Starter/Standard plans have higher limits — tune via PGPOOL_MAX env var.
    max: parseInt(process.env.PGPOOL_MAX ?? "10", 10),
    // Idle connections are released quickly to avoid hitting the free-tier limit.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };

  if (isRender || isRenderInternal) {
    // Render Postgres internal URL uses a self-signed cert.
    // sslmode=require ensures the connection is encrypted without verifying the cert.
    base.ssl = { rejectUnauthorized: false };
  }

  return base;
}

export function initDb(options?: {
  databaseUrl?: string;
  forceEmbedded?: boolean;
}): DbClient {
  const url = options?.databaseUrl ?? process.env.DATABASE_URL;

  if (!options?.forceEmbedded && url && !url.startsWith("memory:")) {
    isPgliteMode = false;
    if (!pgPool) {
      pgPool = new pg.Pool(buildPgPoolConfig(url));

      // Log pool errors so they surface in Render's log stream
      pgPool.on("error", (err) => {
        console.error("[DB] Unexpected pool client error:", err.message);
      });
    }
    return makePoolClient();
  } else {
    isPgliteMode = true;
    if (!pgliteInstance) {
      pgliteInstance = new PGlite();
    }
    return makePgliteClient();
  }
}

function makePoolClient(): DbClient {
  return {
    async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
      const res = await pgPool!.query(sql, params);
      return {
        rows: res.rows as T[],
        rowCount: res.rowCount ?? res.rows.length,
      };
    },
    async exec(sql: string): Promise<void> {
      await pgPool!.query(sql);
    },
  };
}

function makePgliteClient(): DbClient {
  return {
    async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
      const res = await pgliteInstance!.query(sql, params);
      return { rows: res.rows as T[], rowCount: res.rows.length };
    },
    async exec(sql: string): Promise<void> {
      await pgliteInstance!.exec(sql);
    },
  };
}

export function getDb(): DbClient {
  if (pgPool) return makePoolClient();
  if (pgliteInstance) return makePgliteClient();
  return initDb();
}

export async function transaction<T>(
  fn: (client: DbClient) => Promise<T>,
): Promise<T> {
  const db = getDb();
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const wrappedClient: DbClient = {
        async query<R = any>(
          sql: string,
          params?: any[],
        ): Promise<QueryResult<R>> {
          const res = await client.query(sql, params);
          return {
            rows: res.rows as R[],
            rowCount: res.rowCount ?? res.rows.length,
          };
        },
        async exec(sql: string): Promise<void> {
          await client.query(sql);
        },
      };
      const result = await fn(wrappedClient);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } else {
    // PGlite — single-connection, serialised
    await db.exec("BEGIN");
    try {
      const result = await fn(db);
      await db.exec("COMMIT");
      return result;
    } catch (err) {
      await db.exec("ROLLBACK");
      throw err;
    }
  }
}

export async function closeDb(): Promise<void> {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
  if (pgliteInstance) {
    await pgliteInstance.close();
    pgliteInstance = null;
  }
}

export async function resetDb(): Promise<void> {
  await closeDb();
  initDb({ forceEmbedded: true });
}
