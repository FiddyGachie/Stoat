type Item = { id: string; kind: string; title: string; body: string; entity_type: null; entity_id: null; mission_id: null; link: null; created_at: string; read_at: string | null; updated_at: null; resolved_at: null };
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  formatUnreadCount,
  needsMarkRead,
  newestFirst,
  parseNotificationLink,
} from "../console/src/notifications.js";

const make = (id: string, created_at: string, read_at: string | null = null): Item => ({
  id, kind: "topped_up", title: "t", body: "b", entity_type: null, entity_id: null,
  mission_id: null, link: null, created_at, read_at, updated_at: null, resolved_at: null,
});

describe("notifications bell helpers", () => {
  it("caps the unread count display at 999+", () => {
    expect(formatUnreadCount(0)).toBe("0");
    expect(formatUnreadCount(999)).toBe("999");
    expect(formatUnreadCount(1000)).toBe("999+");
    fc.assert(fc.property(fc.integer({ min: 0, max: 999 }), (n) => formatUnreadCount(n) === String(n)));
    fc.assert(fc.property(fc.integer({ min: 1000, max: 1e9 }), (n) => formatUnreadCount(n) === "999+"));
  });

  it("orders newest first and returns at most 50", () => {
    const items = Array.from({ length: 70 }, (_, i) =>
      make(`n${i}`, new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString()));
    const out = newestFirst(items);
    expect(out).toHaveLength(50);
    expect(out[0].id).toBe("n69");
    expect(out[49].id).toBe("n20");
  });

  it("parses only wallet navigation links", () => {
    expect(parseNotificationLink("#/wallet?deposit=abc-1")).toMatchObject({ kind: "deposit", id: "abc-1" });
    expect(parseNotificationLink("#/wallet")).toEqual({ kind: "wallet", route: "#/wallet" });
    expect(parseNotificationLink("https://evil.example")).toBeNull();
    expect(parseNotificationLink("#/wallet?deposit=a&x=1")).toBeNull();
    expect(parseNotificationLink(null)).toBeNull();
  });

  it("marks read once per unread state", () => {
    const inFlight = new Set<string>();
    expect(needsMarkRead(make("a", "2025-01-01T00:00:00Z"), inFlight, "a")).toBe(true);
    inFlight.add("a");
    expect(needsMarkRead(make("a", "2025-01-01T00:00:00Z"), inFlight, "a")).toBe(false);
    expect(needsMarkRead(make("b", "2025-01-01T00:00:00Z", "2025-01-02T00:00:00Z"), new Set(), "b")).toBe(false);
  });
});
