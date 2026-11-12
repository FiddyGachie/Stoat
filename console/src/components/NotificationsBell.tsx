import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { walletApi, WalletNotification } from "../api.js";
import {
  UNAVAILABLE_MESSAGE,
  formatUnreadCount,
  needsMarkRead,
  newestFirst,
  parseNotificationLink,
} from "../notifications.js";
import { announceDataChanged } from "../live.js";

const POLL_MS = 20_000;

/** Confirm the entity a notification points at is still there and visible to this person (R13.9). */
async function entityAvailable(n: WalletNotification): Promise<boolean> {
  const target = parseNotificationLink(n.link);
  if (!target) return false;
  try {
    if (target.kind === "deposit") await walletApi.deposit(target.id);
    else if (target.kind === "mission") await walletApi.mission(target.id);
    else if (target.kind === "refund") await walletApi.refund(target.id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bell with an unread count and a newest-first list of at most 50 notifications (R13.7).
 * Opening one marks it read once, then navigates; if the item is gone the notification stays
 * readable and the list stays open with an "unavailable" message (R13.8, R13.9).
 * Navigation only: nothing here approves, sends, captures or refunds money.
 */
export function NotificationsBell({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<WalletNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState<{ id: string; message: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inFlight = useRef<Set<string>>(new Set());

  const lastCount = useRef<number | null>(null);
  const refreshCount = useCallback(() => {
    walletApi
      .unreadCount()
      .then((r) => {
        // A new notification (e.g. "Mission complete") means the pages behind it changed.
        if (lastCount.current !== null && r.unread_count > lastCount.current) announceDataChanged();
        lastCount.current = r.unread_count;
        setUnread(r.unread_count);
      })
      .catch(() => undefined);
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const page = await walletApi.notifications();
      setItems(newestFirst(page.notifications));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load notifications.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshCount();
    const timer = window.setInterval(() => {
      if (!document.hidden) refreshCount();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshCount]);

  useEffect(() => {
    if (!open) return;
    void loadList();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open, loadList]);

  async function openItem(n: WalletNotification) {
    setUnavailable(null);
    setError("");
    if (needsMarkRead(n, inFlight.current, n.id)) {
      inFlight.current.add(n.id);
      try {
        const res = await walletApi.markRead(n.id);
        setUnread(res.unread_count);
        setItems((cur) => cur.map((x) => (x.id === n.id ? { ...x, ...res.notification } : x)));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not mark the notification read.");
        return;
      } finally {
        inFlight.current.delete(n.id);
      }
    }
    const target = parseNotificationLink(n.link);
    if (!target || !(await entityAvailable(n))) {
      setUnavailable({ id: n.id, message: UNAVAILABLE_MESSAGE });
      return;
    }
    setOpen(false);
    window.location.hash = target.route.replace(/^#/, "");
  }

  const label = formatUnreadCount(unread);
  return (
    <div className={`notif-bell ${className}`.trim()} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="icon-button notif-bell-button"
        aria-label={`Notifications, ${label} unread`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="notif-panel"
        onClick={() => setOpen((v) => !v)}
      >
        <Bell className="icon" aria-hidden="true" />
        {unread > 0 && (
          <span className="notif-count" aria-hidden="true">
            {label}
          </span>
        )}
      </button>
      {open && (
        <div id="notif-panel" className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="notif-head">
            <strong>Notifications</strong>
            <a href="#/notifications" onClick={() => setOpen(false)}>
              View all
            </a>
          </div>
          <div aria-live="polite">
            {loading && <p className="notif-empty">Loading…</p>}
            {error && (
              <p className="notice notice-error" role="alert">
                {error}
              </p>
            )}
            {unavailable && (
              <p className="notice notice-error" role="alert">
                {unavailable.message}
              </p>
            )}
            {!loading && !error && items.length === 0 && (
              <p className="notif-empty">You have no notifications.</p>
            )}
          </div>
          <ul className="notif-list">
            {items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className="notif-item"
                  data-unread={n.read_at === null}
                  onClick={() => void openItem(n)}
                >
                  <span className="notif-title">
                    {n.read_at === null && <span className="sr-only">Unread: </span>}
                    {n.title}
                  </span>
                  <span className="notif-body">{n.body}</span>
                  <time className="notif-time" dateTime={n.created_at}>
                    {new Date(n.created_at).toLocaleString()}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
