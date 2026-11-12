import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { validateDepositAmount } from "../console/src/money.js";
import {
  HOLDING_ACCOUNT_NOTE,
  describeError,
  isAwaitingCapture,
  readReturnParams,
  returnMessage,
  stripReturnParams,
} from "../console/src/walletReturn.js";

describe("validateDepositAmount (R15.5)", () => {
  it.each(["", "  ", "0", "0.00", "-5", "abc", "1.234", "10000.01", "1e3"])(
    "rejects %j",
    (v) => expect(validateDepositAmount(v)).not.toBeNull(),
  );
  it.each(["1", "25.5", "10000", "10000.00", "0.01"])("accepts %j", (v) =>
    expect(validateDepositAmount(v)).toBeNull(),
  );
});

describe("wallet return handling (R15.7)", () => {
  it("reads and strips the return parameters", () => {
    const s = "?a=1&wallet_deposit=d1&wallet_status=captured";
    expect(readReturnParams(s)).toEqual({ depositId: "d1", status: "captured" });
    expect(stripReturnParams(s)).toBe("?a=1");
    expect(readReturnParams("")).toEqual({ depositId: null, status: null });
  });
  it("maps each status to a message; mismatch directs to an Admin", () => {
    expect(returnMessage("mismatch").text).toContain("contact an Admin");
    for (const s of ["captured", "cancelled", "expired", "failed"])
      expect(returnMessage(s).text.length).toBeGreaterThan(0);
    expect(isAwaitingCapture("awaiting_capture")).toBe(true);
    expect(isAwaitingCapture("captured")).toBe(false);
  });
  it("shows the code, caps length and drops stack traces (R15.14)", () => {
    const e = Object.assign(new Error("Nope\n    at foo (file.ts:1:2)"), { code: "X_CODE" });
    expect(describeError(e)).toBe("X_CODE: Nope");
    expect(describeError(new Error("a".repeat(500))).length).toBeLessThanOrEqual(200);
  });
});

describe("wallet copy", () => {
  it("states the holding account and never says escrow", () => {
    expect(HOLDING_ACCOUNT_NOTE).toBe(
      "Wallet balance, held in the platform's PayPal business account",
    );
    for (const f of ["WalletWorkspace.tsx"])
      expect(readFileSync(`console/src/workspaces/${f}`, "utf8").toLowerCase()).not.toContain("escrow");
    expect(readFileSync("console/src/walletReturn.ts", "utf8").toLowerCase()).not.toContain("escrow");
  });
});
