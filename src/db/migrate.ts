import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, transaction, DbClient } from "./connection.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Split SQL into statements, honouring single quotes, double quotes, dollar
 * quotes, and line/block comments. Returns [start, end) offsets.
 */
export function splitStatements(
  sql: string,
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
    } else if (c === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
    } else if (c === "'" || c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
    } else if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        i = close === -1 ? n : close + m[0].length;
      } else {
        i++;
      }
    } else if (c === ";") {
      out.push({ start, end: i + 1 });
      start = i + 1;
      i++;
    } else {
      i++;
    }
  }
  if (sql.slice(start).trim()) out.push({ start, end: n });
  return out;
}

/** Statement text containing a 1-based Postgres error position, or null. */
export function statementAtPosition(
  sql: string,
  position: number,
): string | null {
  if (!Number.isFinite(position) || position < 1) return null;
  const offset = position - 1;
  for (const s of splitStatements(sql)) {
    if (offset >= s.start && offset < s.end)
      return sql.slice(s.start, s.end).trim();
  }
  return null;
}

export class MigrationError extends Error {
  readonly file: string;
  readonly statement: string | null;
  constructor(
    file: string,
    sql: string,
    readonly cause: unknown,
  ) {
    const e = cause as
      | { message?: string; position?: string | number }
      | undefined;
    const pos = e?.position !== undefined ? Number(e.position) : NaN;
    const statement = statementAtPosition(sql, pos);
    const detail = statement ?? "(no statement position reported by Postgres)";
    super(
      `Migration ${file} failed and was rolled back: ${e?.message ?? String(cause)}\n` +
        `Failing statement:\n${detail}`,
    );
    this.name = "MigrationError";
    this.file = file;
    this.statement = statement;
  }
}

export async function runMigrations(customDb?: DbClient): Promise<string[]> {
  const db = customDb || getDb();

  // Ensure schema_migrations exists
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      migration_name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const migrationsDir = path.join(__dirname, "migrations");
  if (!fs.existsSync(migrationsDir)) {
    return [];
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const appliedRows = await db.query<{ migration_name: string }>(
    "SELECT migration_name FROM schema_migrations",
  );
  const appliedSet = new Set(appliedRows.rows.map((r) => r.migration_name));

  const newlyApplied: string[] = [];

  for (const file of files) {
    if (!appliedSet.has(file)) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, "utf-8");

      try {
        await transaction(async (tx) => {
          // Execute the migration SQL via exec
          await tx.exec(sql);
          await tx.query(
            "INSERT INTO schema_migrations (migration_name) VALUES ($1)",
            [file],
          );
        });
      } catch (err) {
        // transaction() has already rolled back, so nothing from this file persists.
        throw new MigrationError(file, sql, err);
      }

      newlyApplied.push(file);
      console.log(`[Migrations] Successfully applied: ${file}`);
    }
  }

  return newlyApplied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then((applied) => {
      console.log(`[Migrations] Done. Applied ${applied.length} migrations.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[Migrations] Migration failed:", err);
      process.exit(1);
    });
}
