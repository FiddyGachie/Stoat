// Console wallet analytics helpers and read-only guarantees (task 22.5; R14.1 to R14.12).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CHARTS,
  DATASETS,
  PAGE_SIZE,
  appendPage,
  cellText,
  eventEntity,
  moneyComparator,
  paypalIds,
  pivotByCurrency,
  relatedLedger,
  statusCounts,
} from "../console/src/walletAnalytics.js";

describe("wallet analytics helpers", () => {
  it("covers the nine datasets and six charts, with pages of at most 500", () => {
    expect(DATASETS).toHaveLength(9);
    expect(CHARTS).toHaveLength(6);
    expect(PAGE_SIZE).toBeLessThanOrEqual(500);
    for (const d of DATASETS) expect(d.empty.action).not.toBe("");
  });

  it("lists PayPal IDs and nothing for a row without them", () => {
    expect(
      paypalIds({ id: "1", paypal_order_id: "O-1", paypal_capture_id: null, paypal_environment: "sandbox" }),
    ).toEqual([{ label: "Paypal order id", value: "O-1" }]);
    expect(paypalIds({ id: "2", paypal_refund_ids: "R-1;R-2" }).map((i) => i.value)).toEqual(["R-1", "R-2"]);
    expect(paypalIds({ id: "3", status: "x" })).toEqual([]);
  });

  it("finds the event entity and related ledger lines", () => {
    expect(eventEntity("deposits", { id: "d1", wallet_id: "w1" })).toEqual({ entity_type: "deposit", entity_id: "d1" });
    expect(eventEntity("charges", { id: "c1", mission_id: "m1", wallet_id: "w1" })).toEqual({
      entity_type: "mission",
      entity_id: "m1",
    });
    expect(eventEntity("reconciliation-exceptions", { id: "e1" })).toBeNull();
    const lines = [
      { id: "l1", reference: "wallet:deposit:d1", transaction_id: "t1" },
      { id: "l2", reference: "wallet:deposit:d1", transaction_id: "t1" },
      { id: "l3", reference: "wallet:deposit:d2", transaction_id: "t2" },
    ];
    expect(relatedLedger("deposits", { id: "d1" }, lines)).toHaveLength(2);
    expect(relatedLedger("ledger-lines", { id: "l3", transaction_id: "t2" }, lines)).toHaveLength(1);
    expect(relatedLedger("deposits", { id: "none" }, lines)).toEqual([]);
  });

  it("appends pages without repeating a row", () => {
    expect(appendPage([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }]).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("formats and sorts money as decimals", () => {
    expect(cellText({ name: "amount", type: "money" }, "0.1")).toBe("0.10");
    expect(cellText({ name: "amount", type: "money" }, null)).toBe("–");
    expect(moneyComparator("10.00", "9.99")).toBe(1);
    expect(moneyComparator("0.10", "0.1")).toBe(0);
  });

  it("keeps currencies on separate series", () => {
    const r = pivotByCurrency(
      [
        { date: "2025-01-01", currency: "USD", balance: "5.00" },
        { date: "2025-01-01", currency: "EUR", balance: "7.00" },
      ],
      "date",
      [{ key: "balance", label: "Balance" }],
    );
    expect(r.series.map((s) => s.yName).sort()).toEqual(["Balance (EUR)", "Balance (USD)"]);
    expect(r.data).toHaveLength(1);
    expect(statusCounts([{ status: "captured", count: "2" }, { status: "captured", count: "1" }])).toEqual([
      { status: "captured", count: 3 },
    ]);
  });
});

describe("analytics views are read-only (R14.12)", () => {
  const src = ["console/src/workspaces/WalletActivity.tsx", "console/src/walletAnalytics.ts"]
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  it("has no money-moving call and no recipient access", () => {
    for (const bad of [
      "createDeposit",
      "createRefund",
      "retryRefund",
      "decideRemainder",
      "topUp",
      "approve",
      "capture",
      "recipient",
      "payee",
      "paypal_email",
      'method: "POST"',
    ])
      expect(src).not.toContain(bad);
  });
});
