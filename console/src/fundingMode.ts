/**
 * Tenant funding mode for the console's accept buttons.
 *
 * In wallet mode an accepted quote is funded by a Reservation from the buyer's wallet (approved
 * budgets); no PayPal checkout happens per agreement. In direct mode each agreement is paid with
 * PayPal. The label only describes what the server will do; the server decides.
 */
import { useEffect, useState } from "react";
import { walletApi } from "./api.js";

export type FundingMode = "wallet" | "direct" | null;

let cached: Promise<FundingMode> | null = null;
function loadFundingMode(): Promise<FundingMode> {
  cached ??= walletApi
    .overview()
    .then((o) => (o.funding_mode === "wallet" ? "wallet" : o.funding_mode === "direct" ? "direct" : null))
    .catch(() => {
      cached = null; // retry on the next mount
      return null;
    });
  return cached;
}

export function useFundingMode(): FundingMode {
  const [mode, setMode] = useState<FundingMode>(null);
  useEffect(() => {
    let live = true;
    void loadFundingMode().then((m) => { if (live) setMode(m); });
    return () => { live = false; };
  }, []);
  return mode;
}

/** Button text for accepting a quote. */
export function acceptLabel(mode: FundingMode): string {
  return mode === "wallet" ? "Accept & reserve from wallet" : mode === "direct" ? "Accept & Pay with PayPal" : "Accept quote";
}

/** Notice after a successful acceptance that did not redirect to PayPal. */
export function acceptedNotice(
  mode: FundingMode,
  accepted: { price?: unknown; currency?: unknown; payment_error?: { message?: string } | null },
): string {
  if (accepted.payment_error?.message)
    return `Quote accepted and recorded, but payment could not be requested: ${accepted.payment_error.message}`;
  if (mode === "wallet") {
    const amount = accepted.price != null ? `${Number(accepted.price).toFixed(2)} ${String(accepted.currency ?? "")}`.trim() : "The agreed price";
    return `Quote accepted. ${amount} is reserved from your wallet; it is charged only when the work is verified. The provider can start now.`;
  }
  return "Quote accepted under deterministic spending policy. Agreement recorded.";
}

/** Error text for a refused acceptance, with the next step for funding problems. */
export function acceptErrorText(err: unknown): { text: string; topUp: boolean } {
  const e = err as { message?: string; code?: string };
  const msg = e?.message ?? "Quote could not be accepted.";
  switch (e?.code) {
    case "WALLET_INSUFFICIENT_FUNDS":
      return { text: `Not enough available in your wallet to reserve this price. Top up your wallet or approve another budget, then accept again. (${msg})`, topUp: true };
    case "MISSION_DEPLETED":
      return { text: `This mission is out of funds. Top up your wallet, then accept again. (${msg})`, topUp: true };
    case "BUDGET_EXCEEDED":
      return { text: `This price is above the mission's budget cap. Raise the mission budget or pick a cheaper offer. (${msg})`, topUp: false };
    case "WALLET_BLOCKED":
      return { text: `Your wallet is temporarily blocked while an Admin checks its balance. (${msg})`, topUp: false };
    default:
      return { text: msg, topUp: false };
  }
}
