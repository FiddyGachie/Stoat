/**
 * Helpers for the Wallet page: PayPal return handling and error text (R15.7 to R15.9, R15.14).
 * Pure functions, so they can be tested without a browser.
 */

export const POLL_INTERVAL_MS = 5_000;
export const POLL_LIMIT_MS = 5 * 60_000;
export const BALANCE_REFRESH_MS = 2_000;

export const HOLDING_ACCOUNT_NOTE =
  "Wallet balance, held in the platform's PayPal business account";

export type ReturnTone = "success" | "warning" | "danger" | "info";
export interface ReturnMessage {
  tone: ReturnTone;
  text: string;
}

/** Statuses that are still waiting on PayPal. */
export const isAwaitingCapture = (status: string | null | undefined): boolean =>
  status === "awaiting_approval" ||
  status === "awaiting_capture" ||
  status === "pending";

/** Statuses that will not change again. */
export const isTerminalStatus = (status: string | null | undefined): boolean =>
  ["captured", "cancelled", "expired", "mismatch", "failed", "error"].includes(
    status ?? "",
  );

/** Message for the `wallet_status` the server put in the return URL. */
export function returnMessage(status: string): ReturnMessage {
  switch (status) {
    case "captured":
      return {
        tone: "success",
        text: "Your deposit was captured and added to your wallet balance.",
      };
    case "cancelled":
      return {
        tone: "warning",
        text: "You cancelled the deposit at PayPal. Nothing was added to your wallet.",
      };
    case "expired":
      return {
        tone: "warning",
        text: "The deposit expired before it was approved. Nothing was added to your wallet.",
      };
    case "mismatch":
      return {
        tone: "danger",
        text: "PayPal captured a different amount or currency than requested. Nothing was added to your wallet. Please contact an Admin.",
      };
    case "failed":
      return {
        tone: "danger",
        text: "The deposit failed at PayPal. Nothing was added to your wallet.",
      };
    case "error":
      return {
        tone: "danger",
        text: "We could not match this return to a deposit. Nothing was added to your wallet.",
      };
    default:
      return {
        tone: "info",
        text: "Your deposit is pending. We are waiting for PayPal to confirm the capture.",
      };
  }
}

export interface ReturnParams {
  depositId: string | null;
  status: string | null;
}

/** Read `wallet_deposit` and `wallet_status` from the page query string (the server puts them before `#`). */
export function readReturnParams(search: string): ReturnParams {
  const q = new URLSearchParams(search);
  const depositId = q.get("wallet_deposit");
  const status = q.get("wallet_status");
  return {
    depositId: depositId && depositId.trim() ? depositId : null,
    status: status && status.trim() ? status : null,
  };
}

/** `search` with the return parameters removed, so a refresh does not replay the message. */
export function stripReturnParams(search: string): string {
  const q = new URLSearchParams(search);
  q.delete("wallet_deposit");
  q.delete("wallet_status");
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Plain-language error with the Stoat code, at most 200 characters, never a stack trace (R15.14). */
export function describeError(e: unknown): string {
  const code =
    e && typeof e === "object" && "code" in e && typeof e.code === "string"
      ? e.code
      : "";
  const raw = e instanceof Error ? e.message : "Something went wrong.";
  // Keep only the first line so a stack trace can never reach the screen.
  const message = raw.split("\n")[0]!.replace(/\s+at\s+\S+:\d+.*$/, "").trim();
  const text = code && !message.includes(code) ? `${code}: ${message}` : message;
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}
