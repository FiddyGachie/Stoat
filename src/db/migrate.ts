import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, transaction, DbClient } from './connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    return [];
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const appliedRows = await db.query<{ migration_name: string }>(
    'SELECT migration_name FROM schema_migrations'
  );
  const appliedSet = new Set(appliedRows.rows.map((r) => r.migration_name));

  const newlyApplied: string[] = [];

  for (const file of files) {
    if (!appliedSet.has(file)) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      await transaction(async (tx) => {
        // Execute the migration SQL via exec
        await tx.exec(sql);
        await tx.query(
          'INSERT INTO schema_migrations (migration_name) VALUES ($1)',
          [file]
        );
      });

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
      console.error('[Migrations] Migration failed:', err);
      process.exit(1);
    });
}
