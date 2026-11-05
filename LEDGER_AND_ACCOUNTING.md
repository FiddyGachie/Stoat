# Ledger, Obligations and Reconciliation

## 1. Scope and terminology

Stoat's ledger is an internal accounting record of buyer expense and provider payable obligations. It is not a bank account, wallet, escrow, custody account or provider payout rail.

## 2. Recognition rule

An obligation may be accrued only after:
1. accepted immutable agreement exists;
2. delivery is submitted against that agreement;
3. deterministic verification verdict is `verified`;
4. no active hold or dispute blocks accrual;
5. no obligation already exists for that agreement.

Accrual and journal posting occur in one DB transaction.

## 3. Double-entry example

For a verified service of USD 0.12:

| Account | Debit | Credit |
|---|---:|---:|
| Buyer service expense | 0.12 | 0.00 |
| Provider payable | 0.00 | 0.12 |

Total debit equals total credit per currency. If tax, fees or FX are not implemented, do not fabricate extra lines. The demo can use a single currency and no FX.

## 4. Account model

Minimum accounts:
- buyer expense (debit normal);
- provider payable (credit normal);
- settlement clearing / payment clearing (only if the actual flow requires it);
- adjustment / reversal accounts as explicitly modelled.

Each account has tenant, currency, code, name, normal balance and active status. Account mapping is deterministic and versioned.

## 5. Reversals

Journal rows are append-only. To reverse, post a new transaction with opposite debit/credit lines and a reference to the original. Corrections include reason, actor and source event. Never update amount or delete original lines.

## 6. Settlement batching

- One tenant and one currency per batch.
- Include only payable, unheld, undisputed, unreserved obligations.
- Sum is computed server-side using exact decimal arithmetic.
- Reservation of obligations and batch creation are atomic.
- Unique active reservation prevents concurrent double batching.
- Batch proposal is not approval.
- Approval is human-only in P0.
- Batch approval is not capture.
- Capture is not reconciliation.
- Reconciliation is not provider payout.

## 7. PayPal semantics

For the hackathon path, the buyer pays the merchant account using PayPal Orders v2. A successful capture confirms the buyer payment to that merchant account. It does **not** automatically pay each listed provider. Provider payables remain internal ledger obligations unless a separate, implemented payout integration exists.

## 8. Integrity calculations

`GET /v1/integrity` returns:
- debit-credit delta by currency;
- hash-chain gaps / mismatches;
- agreements with >1 obligation;
- obligations with >1 active batch reservation;
- orphan active reservations;
- batch total vs item sum mismatch;
- captured payments missing reconciliation;
- agreements missing allow policy decision;
- duplicate webhook count / handling anomalies.

Each metric includes count, status, computed timestamp and optional offending record IDs for authorized operators.
