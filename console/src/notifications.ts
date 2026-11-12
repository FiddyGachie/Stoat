/**
 * Pure helpers for the notifications bell (R13.7 to R13.9). No React, no network, so they can be
 * tested directly.
 */
/** The fields these helpers read; the full WalletNotification in api.ts satisfies it. */
export interface NotificationLike {
  id: string;
  created_at: string;
  read_at: string | null;
}

/** Largest page the bell renders (R13.7). */
export const NOTIFICATION_PAGE_SIZE = 50;

/** Unread count shown on the bell: 0 to 999, then "999+" (R13.7). Invalid input shows 0. */
export function formatUnreadCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  const whole = Math.floor(count);
  return whole > 999 ? "999+" : String(whole);
}

/** Newest first, at most 50 (R13.7). Ties keep a stable order by id. Does not mutate the input. */
export function newestFirst<T extends NotificationLike>(
  items: readonly T[],
  limit: number = NOTIFICATION_PAGE_SIZE,
): T[] {
  return [...items]
    .sort((a, b) => {
      const diff = Date.parse(b.created_at) - Date.parse(a.created_at);
      if (diff !== 0 && !Number.isNaN(diff)) return diff;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, limit);
}

/** Entities a notification can point at, and the wallet route it opens. */
export type NotificationTarget =
  | { kind: "deposit" | "mission" | "refund"; id: string; route: string }
  | { kind: "wallet"; route: string };

/** Parse the server's navigation-only link (`#/wallet?deposit=ID`). Anything else returns null. */
export function parseNotificationLink(
  link: string | null | undefined,
): NotificationTarget | null {
  if (!link) return null;
  const match = /^#\/wallet(?:\?(deposit|mission|refund)=([A-Za-z0-9_-]{1,64}))?$/.exec(link);
  if (!match) return null;
  if (!match[1]) return { kind: "wallet", route: link };
  return { kind: match[1] as "deposit" | "mission" | "refund", id: match[2], route: link };
}

/** Whether opening this notification must send a mark-read request (once per unread state, R13.8). */
export function needsMarkRead(
  n: Pick<NotificationLike, "read_at">,
  inFlight: ReadonlySet<string>,
  id: string,
): boolean {
  return n.read_at === null && !inFlight.has(id);
}

export const UNAVAILABLE_MESSAGE =
  "This item is unavailable. It may have been removed or you may no longer have access to it.";
