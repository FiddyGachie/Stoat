/**
 * Registers Stoat's webhook endpoint with PayPal and prints the webhook ID to put in PAYPAL_WEBHOOK_ID.
 *
 *   PUBLIC_API_URL=https://your-api.onrender.com npm run paypal:webhook
 *
 * PayPal only delivers webhooks to a public HTTPS URL, so this cannot register localhost.
 * It is idempotent: if the URL is already registered it updates its event list and reuses it.
 * Uses PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_BASE_URL. Secrets are never printed.
 */
import 'dotenv/config';
import { readPayPalConfig, fetchPayPalToken } from '../src/modules/paypal/paypal.gateway.js';

const EVENTS = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.PAYOUTSBATCH.SUCCESS',
  'PAYMENT.PAYOUTSBATCH.DENIED',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.FAILED',
  'PAYMENT.PAYOUTS-ITEM.BLOCKED',
  'PAYMENT.PAYOUTS-ITEM.CANCELED',
  'PAYMENT.PAYOUTS-ITEM.DENIED',
  'PAYMENT.PAYOUTS-ITEM.HELD',
  'PAYMENT.PAYOUTS-ITEM.RETURNED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
];

async function main() {
  const cfg = readPayPalConfig();
  if (!cfg) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set.');
  const base = (process.env.PUBLIC_API_URL ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+/.test(base) || /localhost|127\.0\.0\.1/.test(base)) {
    throw new Error('Set PUBLIC_API_URL to the public HTTPS address of your API (PayPal cannot call localhost).');
  }
  const url = `${base}/v1/webhooks/paypal`;

  const { accessToken: access_token } = await fetchPayPalToken(cfg);
  const auth = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };

  const list = (await (await fetch(`${cfg.baseUrl}/v1/notifications/webhooks`, { headers: auth })).json()) as { webhooks?: { id: string; url: string }[] };
  const existing = list.webhooks?.find((w) => w.url === url);
  if (existing) {
    const res = await fetch(`${cfg.baseUrl}/v1/notifications/webhooks/${existing.id}`, {
      method: 'PATCH', headers: auth,
      body: JSON.stringify([{ op: 'replace', path: '/event_types', value: EVENTS.map((name) => ({ name })) }]),
    });
    if (!res.ok) throw new Error(`Could not update webhook ${existing.id}: HTTP ${res.status} ${await res.text()}`);
    console.log(`Webhook already registered for ${url} (event list refreshed).`);
    console.log(`PAYPAL_WEBHOOK_ID=${existing.id}`);
    return;
  }
  const res = await fetch(`${cfg.baseUrl}/v1/notifications/webhooks`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ url, event_types: EVENTS.map((name) => ({ name })) }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; details?: unknown };
  if (!res.ok || !body.id) throw new Error(`PayPal refused the webhook: HTTP ${res.status} ${body.message ?? ''} ${JSON.stringify(body.details ?? '')}`);
  console.log(`Registered ${url}`);
  console.log(`PAYPAL_WEBHOOK_ID=${body.id}`);
}

main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
