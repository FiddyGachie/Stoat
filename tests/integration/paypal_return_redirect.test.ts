import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/api/app.js';
import { getDb, resetDb, closeDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedDatabase, SEED_IDS } from '../../src/db/seed.js';
import { FundingService } from '../../src/modules/payments/funding.service.js';
import { acceptedAgreement, stubPayPal } from '../funding-helpers.js';

// After PayPal, the buyer must land back on the console they paid from, whatever port or host it
// runs on, and never on an untrusted origin. PayPal's replies come from a test double.
describe('PayPal return lands on the console the buyer used', () => {
  let app: any;
  let server: Server;
  let base = '';
  const saved = { console: process.env.CONSOLE_URL, env: process.env.NODE_ENV };

  beforeAll(async () => {
    await resetDb();
    const db = getDb();
    await runMigrations(db);
    await seedDatabase(db);
    app = createApp();
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    if (saved.console === undefined) delete process.env.CONSOLE_URL; else process.env.CONSOLE_URL = saved.console;
    if (saved.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.env;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); await closeDb(); });

  /** An awaiting PayPal order for a fresh agreement, requested from the given console origin. */
  async function orderFrom(returnOrigin: string | undefined) {
    const ag = await acceptedAgreement(app);
    const svc = new FundingService(getDb(), stubPayPal({ capturedAmount: '0.12' }));
    const pay = await svc.requestFunding({ tenantId: SEED_IDS.tenantId, agreementId: ag.body.id, actorId: SEED_IDS.userId, returnOrigin });
    return (await getDb().query('SELECT provider_order_id AS o FROM agreement_payments WHERE id = $1', [pay!.payment_id])).rows[0].o as string;
  }
  const returnTo = async (token: string) => {
    const res = await fetch(`${base}/v1/paypal/return?token=${token}`, { redirect: 'manual' });
    return { status: res.status, location: res.headers.get('location') ?? '' };
  };

  it('goes back to the remembered console origin, not a fixed CONSOLE_URL', async () => {
    process.env.CONSOLE_URL = 'http://localhost:5173';
    const token = await orderFrom('http://localhost:5174');
    const r = await returnTo(token);
    expect(r.status).toBe(302);
    // The capture itself is done by a test double here; the redirect target is what is under test.
    expect(r.location.startsWith('http://localhost:5174/?funding=')).toBe(true);
    expect(r.location.endsWith('#/quotes')).toBe(true);
  });

  it('falls back to CONSOLE_URL when no origin was remembered', async () => {
    process.env.CONSOLE_URL = 'https://console.example.test';
    const token = await orderFrom(undefined);
    expect((await returnTo(token)).location.startsWith('https://console.example.test/?funding=')).toBe(true);
  });

  it('in production an untrusted remembered origin is ignored (no open redirect)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CONSOLE_URL = 'https://console.example.test';
    await getDb().query(`UPDATE agreement_payments SET metadata = metadata || '{"return_origin":"https://evil.example"}'`);
    const token = (await getDb().query('SELECT provider_order_id AS o FROM agreement_payments ORDER BY created_at DESC LIMIT 1')).rows[0].o;
    const r = await returnTo(token);
    expect(r.location.startsWith('https://console.example.test/')).toBe(true);
    expect(r.location).not.toContain('evil');
  });

  it('acceptance from a browser records where the buyer came from', async () => {
    // Payment requests are real HTTP calls from the console; the Origin header is what is stored.
    const { trustedConsoleOrigin } = await import('../../src/api/console-origin.js');
    process.env.CONSOLE_URL = 'http://localhost:5173';
    expect(trustedConsoleOrigin({ headers: { origin: 'http://localhost:5174' } } as any)).toBe('http://localhost:5174');
    expect(trustedConsoleOrigin({ headers: { origin: 'https://evil.example', host: 'api.local' } } as any)).toBeUndefined();
    process.env.NODE_ENV = 'production';
    expect(trustedConsoleOrigin({ headers: { origin: 'http://localhost:5174' } } as any)).toBeUndefined();
    expect(trustedConsoleOrigin({ headers: { origin: 'http://localhost:5173' } } as any)).toBe('http://localhost:5173');
    expect(trustedConsoleOrigin({ headers: { origin: 'https://stoat.vercel.app', host: 'stoat.vercel.app' } } as any)).toBe('https://stoat.vercel.app');
  });
});
