import { afterEach, describe, expect, it } from "vitest";
import { createVercelApp } from "../../src/api/vercel.js";
import { getPgPoolConfig } from "../../src/db/connection.js";
import { dispatch } from "../test-utils.js";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalVercel = process.env.VERCEL;
const originalPoolMax = process.env.PGPOOL_MAX;

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = originalVercel;
  if (originalPoolMax === undefined) delete process.env.PGPOOL_MAX;
  else process.env.PGPOOL_MAX = originalPoolMax;
});

describe("Vercel API deployment", () => {
  it("forwards rewritten health routes to the Express API", async () => {
    delete process.env.DATABASE_URL;
    const response = await dispatch(createVercelApp(), {
      method: "GET",
      url: "/api/v1/health",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ok", version: "2.1.0" });
    expect(["live", "record", "replay"]).toContain(response.body.llm.mode);
    expect(JSON.stringify(response.body)).not.toMatch(/sk-|fw_|secret/i);
  });

  it("fails closed when a database-backed route has no DATABASE_URL", async () => {
    delete process.env.DATABASE_URL;
    const response = await dispatch(createVercelApp(), {
      method: "POST",
      url: "/api/v1/auth/login",
      body: { email: "buyer@example.test", password: "example-password" },
    });

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("DATABASE_URL_MISSING");
  });

  it("uses a small connection pool for Supabase on Vercel", () => {
    process.env.VERCEL = "1";
    delete process.env.PGPOOL_MAX;
    // Supabase pooler URL (port 6543)
    const poolerConfig = getPgPoolConfig(
      "postgresql://postgres.project:example-password@aws-1-us-east-1.pooler.supabase.com:6543/postgres",
    );
    expect(poolerConfig.max).toBe(2);
    // Pooler uses SNI; rejectUnauthorized is false
    expect((poolerConfig.ssl as any)?.rejectUnauthorized).toBe(false);

    // Supabase direct connection (port 5432) should verify the cert
    const directConfig = getPgPoolConfig(
      "postgresql://postgres.project:example-password@db.project-ref.supabase.co:5432/postgres",
    );
    expect((directConfig.ssl as any)?.rejectUnauthorized).toBe(true);
  });
});
