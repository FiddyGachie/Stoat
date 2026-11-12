import { describe, expect, it } from "vitest";
import {
  TOOL_DEFINITIONS,
  UNTRUSTED_NOTICE,
  toolsForRole,
} from "../../src/modules/agent-tools/tool-definitions.js";
import {
  TOOL_MAX_ARGUMENT_BYTES,
  TOOL_NAMES,
  parseToolArguments,
} from "../../src/modules/agent-tools/tool-schemas.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("agent tool definitions", () => {
  it("defines exactly the eight tools, each with the untrusted-data statement", () => {
    expect(TOOL_DEFINITIONS.map((d) => d.name).sort()).toEqual(
      [...TOOL_NAMES].sort(),
    );
    for (const d of TOOL_DEFINITIONS) {
      expect(d.description).toContain(UNTRUSTED_NOTICE);
      expect(d.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("exposes no money-bearing argument", () => {
    const banned = /amount|currency|payee|recipient|email|status|state|paypal/i;
    for (const d of TOOL_DEFINITIONS) {
      for (const key of Object.keys(d.inputSchema.properties))
        expect(key).not.toMatch(banned);
    }
  });

  it("limits each role to its own tool set", () => {
    expect(toolsForRole("watchdog").map((d) => d.name)).toContain(
      "propose_hold_release",
    );
    expect(toolsForRole("provider").map((d) => d.name)).toEqual([
      "payment_status",
    ]);
    expect(toolsForRole("nobody")).toEqual([]);
  });
});

describe("agent tool argument validation", () => {
  it("accepts valid read arguments", () => {
    expect(parseToolArguments("wallet_summary", { wallet_id: ID }).ok).toBe(
      true,
    );
  });

  it("rejects amount, currency, payee and recipient arguments by name", () => {
    for (const key of ["amount", "currency", "payee", "recipient"]) {
      const r = parseToolArguments("wallet_summary", {
        wallet_id: ID,
        [key]: "x",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.fields).toContain(key);
    }
  });

  it("requires exactly one of agreement_id or obligation_id", () => {
    expect(parseToolArguments("payment_status", {}).ok).toBe(false);
    expect(
      parseToolArguments("payment_status", {
        agreement_id: ID,
        obligation_id: ID,
      }).ok,
    ).toBe(false);
    expect(parseToolArguments("payment_status", { agreement_id: ID }).ok).toBe(
      true,
    );
  });

  it("rejects arguments over 16 KB", () => {
    const r = parseToolArguments("wallet_summary", {
      wallet_id: ID,
      pad: "a".repeat(TOOL_MAX_ARGUMENT_BYTES),
    });
    expect(r.ok).toBe(false);
  });
});
