import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Bell, Landmark, PlusCircle, RefreshCw, Wallet } from "lucide-react";
import { api, walletApi, WalletDeposit } from "../api.js";
import { MissionsSection } from "./WalletMissions.js";
import { useLiveRefresh } from "../live.js";
import { WalletActivity } from "./WalletActivity.js";
import { Card, EmptyState, Loading } from "../components/ui.js";
import { useFetch } from "../hooks.js";
import { formatAmount, formatMoney, validateDepositAmount } from "../money.js";
import {
  BALANCE_REFRESH_MS,
  HOLDING_ACCOUNT_NOTE,
  POLL_INTERVAL_MS,
  POLL_LIMIT_MS,
  ReturnMessage,
  describeError,
  isAwaitingCapture,
  isTerminalStatus,
  readReturnParams,
  returnMessage,
  stripReturnParams,
} from "../walletReturn.js";

const SECTIONS = [
  { id: "wallet-balance", label: "Balance" },
  { id: "wallet-add-funds", label: "Add funds" },
  { id: "wallet-missions", label: "Missions" },
  { id: "wallet-notifications", label: "Notifications" },
  { id: "wallet-activity", label: "Activity" },
] as const;

const TONE_CLASS: Record<ReturnMessage["tone"], string> = {
  success: "badge-success",
  warning: "badge-warning",
  danger: "badge-danger",
  info: "badge-info",
};

function ErrorLine({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="field-note" style={{ color: "var(--color-danger)" }}>
      {text}{" "}
      {onRetry && (
        <button type="button" className="secondary-button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/** Route target for `#/wallet`: Balance, Add funds, Missions, Notifications and Activity. */
export function WalletWorkspace() {
  const overview = useFetch(() => walletApi.overview(), []);
  const me = useFetch(() => api.auth.me(), []);
  const missions = useFetch(() => walletApi.missions(), []);
  const notes = useFetch(() => walletApi.notifications(), []);

  const reloadOverview = overview.reload;
  // Balance, missions and notifications follow reservations, charges and completions live.
  useLiveRefresh(() => {
    overview.reload();
    missions.reload();
    notes.reload();
  });

  /* ── Return from PayPal (R15.7 to R15.9) ── */
  const [banner, setBanner] = useState<ReturnMessage | null>(null);
  const [pollState, setPollState] = useState<"idle" | "polling" | "stopped">("idle");
  const [depositId, setDepositId] = useState<string | null>(null);
  const startedRef = useRef(false);

  const applyStatus = useCallback(
    (status: string) => {
      setBanner(returnMessage(status));
      if (isTerminalStatus(status)) {
        setPollState("idle");
        reloadOverview();
        missions.reload();
        notes.reload();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reloadOverview],
  );

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const { depositId: id, status } = readReturnParams(window.location.search);
    if (!id && !status) return;
    // Remove the parameters so a page refresh does not replay the message.
    const clean = `${window.location.pathname}${stripReturnParams(window.location.search)}${window.location.hash}`;
    window.history.replaceState(null, "", clean);
    setDepositId(id);
    setBanner(returnMessage(status ?? "pending"));
    // The balance is refreshed within 2 seconds of the page load.
    const t = window.setTimeout(reloadOverview, BALANCE_REFRESH_MS);
    reloadOverview();
    if (isAwaitingCapture(status ?? "pending") && id) setPollState("polling");
    return () => window.clearTimeout(t);
  }, [reloadOverview]);

  useEffect(() => {
    if (pollState !== "polling" || !depositId) return;
    const startedAt = Date.now();
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (Date.now() - startedAt >= POLL_LIMIT_MS) {
        setPollState("stopped");
        return;
      }
      try {
        const d = await walletApi.deposit(depositId);
        if (!stopped && !isAwaitingCapture(d.status)) applyStatus(d.status);
      } catch {
        // Keep polling; the limit below ends it.
      }
    };
    const timer = window.setInterval(tick, POLL_INTERVAL_MS);
    const limit = window.setTimeout(() => setPollState("stopped"), POLL_LIMIT_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearTimeout(limit);
    };
  }, [pollState, depositId, applyStatus]);

  const manualRefresh = async () => {
    reloadOverview();
    if (!depositId) return;
    try {
      const d = await walletApi.refreshDeposit(depositId);
      if (isAwaitingCapture(d.status)) {
        setBanner(returnMessage("pending"));
        setPollState("polling");
      } else {
        applyStatus(d.status);
      }
    } catch (e) {
      setBanner({ tone: "danger", text: describeError(e) });
    }
  };

  /* ── Add funds (R15.4 to R15.6, R15.14) ── */
  const wallets = overview.status === "ok" ? overview.data.wallets : [];
  const supported = overview.status === "ok" ? (overview.data.supported_currencies ?? []) : [];
  const [pickedCurrency, setPickedCurrency] = useState("");
  const currency = pickedCurrency || wallets[0]?.currency || supported[0] || "USD";
  const missingCurrencies = supported.filter((c) => !wallets.some((w) => w.currency === c));
  const [newCurrency, setNewCurrency] = useState("");
  const [walletError, setWalletError] = useState("");
  const [walletBusy, setWalletBusy] = useState(false);
  const addWallet = async (e: FormEvent) => {
    e.preventDefault();
    const c = newCurrency || missingCurrencies[0];
    if (!c || walletBusy) return;
    setWalletBusy(true);
    setWalletError("");
    try {
      await walletApi.createWallet(c);
      setNewCurrency("");
      setPickedCurrency(c);
      reloadOverview();
    } catch (err) {
      setWalletError(describeError(err));
    } finally {
      setWalletBusy(false);
    }
  };
  const [amount, setAmount] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busyRef.current) return;
    const problem = validateDepositAmount(amount);
    setFieldError(problem);
    setSubmitError("");
    if (problem) return; // No request is sent for an invalid amount.
    busyRef.current = true;
    setBusy(true);
    try {
      const dep: WalletDeposit = await walletApi.createDeposit({
        amount: formatAmount(amount.trim()),
        currency,
      });
      const url = dep.approve_url ? new URL(dep.approve_url) : null;
      if (!url || url.protocol !== "https:") {
        throw Object.assign(new Error("PayPal did not return an approval link."), {
          code: "PAYPAL_BAD_RESPONSE",
        });
      }
      window.location.assign(url.toString());
    } catch (err) {
      // The amount stays in the field so the person can fix it and try again.
      setSubmitError(describeError(err));
      busyRef.current = false;
      setBusy(false);
    }
  };

  const canAddFunds = me.status !== "ok" || me.data.type === "user";
  const envLabel = overview.status === "ok" ? overview.data.paypal_environment : null;

  const focusSection = (id: string) => {
    const el = document.getElementById(id);
    el?.scrollIntoView({ block: "start" });
    el?.focus();
  };

  const goTo = (target: string) => {
    if (target.startsWith("#")) window.location.hash = target;
    else focusSection(target);
  };

  return (
    <>

      <nav aria-label="Wallet sections" style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className="secondary-button" onClick={() => focusSection(s.id)}>
            {s.label}
          </button>
        ))}
      </nav>

      {banner && (
        <div role="status" aria-live="polite" className="card">
          <span className={`badge ${TONE_CLASS[banner.tone]}`}>{banner.text}</span>
          {pollState === "polling" && <p className="field-note">Waiting for PayPal to confirm. Checking every 5 seconds.</p>}
          {pollState === "stopped" && (
            <p className="field-note">
              The deposit is still pending. Refresh to check again.{" "}
              <button type="button" className="secondary-button" onClick={manualRefresh}>
                <RefreshCw size={14} aria-hidden="true" /> Refresh
              </button>
            </p>
          )}
        </div>
      )}

      <section id="wallet-balance" tabIndex={-1}>
        <Card
          title="Balance"
          icon={Landmark}
          description={HOLDING_ACCOUNT_NOTE}
          actions={
            <button type="button" className="secondary-button" onClick={manualRefresh}>
              <RefreshCw size={14} aria-hidden="true" /> Refresh
            </button>
          }
        >
          {overview.status === "loading" || overview.status === "idle" ? (
            <Loading label="Loading balance…" />
          ) : overview.status === "error" ? (
            <ErrorLine text={describeError(new Error(overview.error))} onRetry={overview.reload} />
          ) : wallets.length === 0 ? (
            <EmptyState icon={Wallet} title="No wallet yet">
              Add funds to create your wallet. Every amount shows as 0.00 until then.
            </EmptyState>
          ) : (
            wallets.map((w) => (
              <dl key={w.id} className="wallet-figures" aria-label={`${w.currency} wallet`}>
                <p>
                  <strong>{w.currency}</strong>{" "}
                  <span className="badge badge-neutral">{w.paypal_environment}</span>
                </p>
                <div><dt>Wallet balance</dt><dd>{formatMoney(w.balance, w.currency)}</dd></div>
                <div><dt>Available</dt><dd>{formatMoney(w.available, w.currency)}</dd></div>
                <div><dt>Reserved</dt><dd>{formatMoney(w.reserved, w.currency)}</dd></div>
                <div><dt>Total deposited</dt><dd>{formatMoney(w.deposited, w.currency)}</dd></div>
                <div><dt>Total charged</dt><dd>{formatMoney(w.charged, w.currency)}</dd></div>
                <div><dt>Total refunded</dt><dd>{formatMoney(w.refunded, w.currency)}</dd></div>
              </dl>
            ))
          )}
          {canAddFunds && missingCurrencies.length > 0 && (
            <form className="portal-form" onSubmit={addWallet} noValidate>
              <label>
                New wallet currency
                <select value={newCurrency || missingCurrencies[0]} onChange={(e) => setNewCurrency(e.target.value)} disabled={walletBusy}>
                  {missingCurrencies.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
              <button type="submit" className="secondary-button" disabled={walletBusy} aria-busy={walletBusy}>
                <PlusCircle size={14} aria-hidden="true" /> {walletBusy ? "Adding…" : "Add wallet"}
              </button>
              {walletError && <ErrorLine text={walletError} />}
            </form>
          )}
          {envLabel && <p className="field-note">PayPal environment: {envLabel}</p>}
        </Card>
      </section>

      <section id="wallet-add-funds" tabIndex={-1}>
        <Card title="Add funds" icon={PlusCircle} description="You approve the payment at PayPal, then return here.">
          {canAddFunds ? (
            <form className="portal-form" onSubmit={submit} noValidate>
              {(wallets.length > 1 || supported.length > 1) && (
                <label>
                  Currency
                  <select value={currency} onChange={(e) => setPickedCurrency(e.target.value)} disabled={busy}>
                    {Array.from(new Set([...wallets.map((w) => w.currency), ...supported])).map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Amount ({currency})
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-invalid={fieldError ? true : undefined}
                  aria-describedby={fieldError ? "wallet-amount-error" : undefined}
                  disabled={busy}
                />
              </label>
              {fieldError && (
                <div id="wallet-amount-error" role="alert" className="field-note" style={{ color: "var(--color-danger)" }}>
                  {fieldError}
                </div>
              )}
              <button type="submit" className="primary-button" disabled={busy} aria-busy={busy}>
                {busy ? "Opening PayPal…" : "Add funds"}
              </button>
              {submitError && <ErrorLine text={submitError} />}
            </form>
          ) : (
            <EmptyState icon={PlusCircle} title="Not available">
              Your role cannot add funds.
            </EmptyState>
          )}
        </Card>
      </section>

      <MissionsSection
        state={missions}
        canMoveMoney={canAddFunds}
        onChanged={() => {
          missions.reload();
          reloadOverview();
          notes.reload();
        }}
      />

      <section id="wallet-notifications" tabIndex={-1}>
        <Card title="Notifications" icon={Bell}>
          {notes.status === "loading" || notes.status === "idle" ? (
            <Loading />
          ) : notes.status === "error" ? (
            <ErrorLine text={describeError(new Error(notes.error))} onRetry={notes.reload} />
          ) : (notes.data?.notifications ?? []).length === 0 ? (
            <EmptyState icon={Bell} title="No notifications">
              Deposit, charge and refund updates appear here.
            </EmptyState>
          ) : (
            <ul>
              {(notes.data?.notifications ?? []).slice(0, 10).map((n) => (
                <li key={n.id}>
                  <strong>{n.title}</strong> {n.body}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section id="wallet-activity" tabIndex={-1}>
        <WalletActivity goTo={goTo} />
      </section>
    </>
  );
}
