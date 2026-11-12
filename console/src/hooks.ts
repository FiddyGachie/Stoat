import { useState, useEffect, useCallback, useRef } from "react";

export type FetchState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ok"; data: T };

/**
 * What useFetch returns. Every variant declares `data` and `error` (as optional
 * `undefined` where absent) so callers can destructure `{ status, data, error }` and still
 * have TypeScript narrow `data` once `status === 'ok'`.
 */
export type FetchResult<T> =
  | {
      status: "idle" | "loading";
      data?: undefined;
      error?: undefined;
      reload: () => void;
    }
  | { status: "error"; data?: undefined; error: string; reload: () => void }
  | { status: "ok"; data: T; error?: undefined; reload: () => void };

/**
 * Like useFetch, but only the latest request may update state. Each run bumps a counter and
 * aborts the previous request; a stale or aborted response is dropped. Same-query reloads keep
 * the current data on screen.
 */
export function useLatestFetch<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: unknown[] = [],
): FetchResult<T> {
  const [state, setState] = useState<FetchState<T>>({ status: "idle" });
  const counter = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const shown = useRef<{ load: unknown; ok: boolean }>({
    load: null,
    ok: false,
  });

  const load = useCallback(() => {
    const id = ++counter.current;
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    if (!(shown.current.load === load && shown.current.ok))
      setState({ status: "loading" });
    fetcher(ac.signal)
      .then((data) => {
        if (id !== counter.current) return;
        shown.current = { load, ok: true };
        setState({ status: "ok", data });
      })
      .catch((err: Error) => {
        if (id !== counter.current || ac.signal.aborted) return;
        shown.current = { load, ok: false };
        setState({ status: "error", error: err.message });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    load();
    return () => {
      // Invalidate in-flight work on unmount or dependency change.
      counter.current++;
      controller.current?.abort();
    };
  }, [load]);

  return { ...state, reload: load } as FetchResult<T>;
}

export function useFetch<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
): FetchResult<T> {
  const [state, setState] = useState<FetchState<T>>({ status: "idle" });
  const shown = useRef<{ load: unknown; ok: boolean }>({
    load: null,
    ok: false,
  });

  const load = useCallback(() => {
    // Same query reloaded (manual refresh or background refresh) while data is on screen:
    // keep it visible until the new data arrives. A changed query (new deps) shows loading.
    const sameQuery = shown.current.load === load && shown.current.ok;
    if (!sameQuery) setState({ status: "loading" });
    fetcher()
      .then((data) => {
        shown.current = { load, ok: true };
        setState({ status: "ok", data });
      })
      .catch((err: Error) => {
        shown.current = { load, ok: false };
        setState({ status: "error", error: err.message });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load } as FetchResult<T>;
}
