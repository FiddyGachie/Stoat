# PayPal Orders v2 Sandbox Integration

## 1. MVP settlement model

The buyer approves and pays a PayPal order to the Stoat merchant account. This demonstrates a real external payment capture. It does not implement provider payouts. The internal ledger records provider payable obligations; the demo must state that those payables are not disbursed by this flow.

## 2. Day-one integration spike

Before building the rest of payment UI:
1. Configure Sandbox REST app and webhook endpoint.
2. Obtain OAuth token server-side.
3. Create a minimal `CAPTURE` order.
4. Return approval URL to browser.
5. Approve as Sandbox buyer.
6. Capture server-side.
7. Query order/capture status.
8. Verify webhook signature using PayPal verification API or documented verification method.
9. Persist IDs and reconcile amount/currency.
10. Record screenshots/log evidence with secrets redacted.

If the spike fails, keep P0 payment integration explicitly blocked and use a clearly labelled mock only for local development; do not claim the hackathon demo has live capture.

## 3. Create order

- Only create an order for an approved batch.
- Backend computes exact total from batch items.
- Use `intent: CAPTURE`.
- Include deterministic `custom_id` / invoice reference mapped to Stoat batch.
- Use PayPal request ID for idempotency on create.
- Store order ID, batch ID, amount, currency, status and request correlation.
- Do not expose OAuth client secret to browser.

## 4. Approval and capture

The browser redirect is not proof of payment. On return, backend validates batch/order linkage and queries/captures through PayPal. Capture is submitted once under idempotency. If request times out after submission, mark `unknown`, query PayPal, and reconcile before retry. Never blindly create another order or capture.

## 5. Webhooks

- Verify signature and webhook ID.
- Persist raw event metadata with sensitive fields redacted.
- Deduplicate on provider event ID.
- Handle duplicate delivery idempotently.
- Do not trust event body until signature verification succeeds.
- Webhook may arrive before or after synchronous capture response; state transitions must tolerate ordering.
- Store processing outcome and reconciliation reference.

## 6. Reconciliation

Compare:
- Stoat batch ID mapped by `custom_id`;
- PayPal order and capture IDs;
- expected batch total;
- actual captured amount;
- expected and actual currency;
- capture status;
- merchant account / payee reference where available.

Mismatch → `reconciliation_required`, hold relevant batch and alert operator. Matching capture → `reconciled`. Never label a provider as paid unless a separate payout integration proves that.

## 7. User-facing statuses

`Draft`, `Proposed`, `Awaiting human approval`, `Approved`, `PayPal order created`, `Awaiting buyer approval`, `Capture pending`, `Captured`, `Reconciled`, `Failed`, `Unknown — checking PayPal`, `Reconciliation required`.

Avoid ambiguous label `Settled` unless the product explicitly defines it as buyer-to-merchant settlement and displays that meaning. Prefer `Buyer payment reconciled`.
