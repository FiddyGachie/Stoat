/**
 * Keep a page current without a manual reload. The callback runs every `ms` while the tab is
 * visible, when the tab regains focus, and whenever something announces fresh data (for example
 * a new notification such as "Mission complete"). Reads only; it never triggers an action.
 */
import { useEffect, useRef } from "react";

const EVENT = "stoat:data-changed";

/** Tell every open page that server data changed (new notification, completed mission, …). */
export function announceDataChanged(): void {
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function useLiveRefresh(callback: () => void, ms = 15_000): void {
  const cb = useRef(callback);
  cb.current = callback;
  useEffect(() => {
    const run = () => { if (!document.hidden) cb.current(); };
    const timer = window.setInterval(run, ms);
    const onVisible = () => { if (!document.hidden) cb.current(); };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(EVENT, run);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(EVENT, run);
    };
  }, [ms]);
}
