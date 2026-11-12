import { describe, it, expect } from 'vitest';
import { statementAtPosition, MigrationError } from '../../src/db/migrate.js';
import { initDb, transaction, getDb, closeDb } from '../../src/db/connection.js';

describe('migration failure reporting', () => {
  it('finds the statement at a Postgres error position, ignoring semicolons in $$ bodies', () => {
    const sql = `CREATE TABLE a (id int);\nCREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;\nSELEKT 1;`;
    expect(statementAtPosition(sql, sql.indexOf('SELEKT') + 1)).toBe('SELEKT 1;');
    expect(statementAtPosition(sql, sql.indexOf('RETURN') + 1)).toContain('CREATE FUNCTION f()');
    expect(statementAtPosition(sql, 0)).toBeNull();
  });

  it('reports file and statement, and rolls the whole file back', async () => {
    await closeDb();
    initDb({ forceEmbedded: true });
    const sql = `CREATE TABLE mig_probe (id int);\nSELEKT 1;`;
    let caught: unknown;
    try {
      await transaction(async (tx) => { await tx.exec(sql); });
    } catch (e) {
      caught = new MigrationError('999_bad.sql', sql, e);
    }
    expect(caught).toBeInstanceOf(MigrationError);
    expect((caught as MigrationError).file).toBe('999_bad.sql');
    expect((caught as MigrationError).statement).toBe('SELEKT 1;');
    const r = await getDb().query(`SELECT to_regclass('mig_probe') AS t`);
    expect(r.rows[0].t).toBeNull();
    await closeDb();
  });
});

describe('PGlite transaction mutex', () => {
  it('serialises concurrent transactions', async () => {
    await closeDb();
    initDb({ forceEmbedded: true });
    await getDb().exec('CREATE TABLE mtx (n int)');
    const run = (n: number, fail = false) => transaction(async (tx) => {
      await tx.query('INSERT INTO mtx VALUES ($1)', [n]);
      await new Promise((r) => setTimeout(r, 5));
      if (fail) throw new Error('boom');
      await tx.query('INSERT INTO mtx VALUES ($1)', [n]);
    });
    const res = await Promise.allSettled([run(1), run(2, true), run(3)]);
    expect(res.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    const rows = await getDb().query('SELECT n FROM mtx ORDER BY n');
    expect(rows.rows.map((r: any) => r.n)).toEqual([1, 1, 3, 3]);
    await closeDb();
  });
});
