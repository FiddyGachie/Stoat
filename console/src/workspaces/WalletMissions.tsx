import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Briefcase } from "lucide-react";
import { MissionWallet, RemainderPrompt, walletApi } from "../api.js";
import { Card, EmptyState, Loading } from "../components/ui.js";
import type { FetchResult } from "../hooks.js";
import { formatAmount, formatMoney, shortfall, validateDepositAmount } from "../money.js";
import { describeError } from "../walletReturn.js";

/** The Wallet_Service must answer within this time or the Console shows an error (R15.3, R15.12). */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Rejects with a coded error when `p` does not settle in time. */
export function withTimeout<T>(p: Promise<T>, ms: number = REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(
      () => reject(Object.assign(new Error("The request timed out."), { code: "REQUEST_TIMEOUT" })),
      ms,
    );
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}

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

/** Text of the advice object, if the server sent the expected shape. */
function adviceText(advice: unknown): { subject: string; body: string } | null {
  if (!advice || typeof advice !== "object") return null;
  const a = advice as Record<string, unknown>;
  if (typeof a.body !== "string") return null;
  return { subject: typeof a.subject === "string" ? a.subject : "", body: a.body };
}

/** Same words as the server's fixed text, used when the prompt cannot be loaded at all. */
const LOCAL_REMAINDER_TEXT =
  "This mission is finished and some funding is left over. You can refund it to your PayPal account or keep it in your wallet. Nothing happens until you choose.";

/** Funding check shown before the buyer confirms a mission budget (R15.2, R15.3). */
function PreConfirmPanel({ mission }: { mission: MissionWallet }) {
  const [tick, setTick] = useState(0);
  const [view, setView] = useState<
    { status: "loading" } | { status: "ok"; data: MissionWallet } | { status: "error"; text: string }
  >({ status: "loading" });
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    let live = true;
    setView({ status: "loading" });
    setConfirmed(false);
    withTimeout(walletApi.mission(mission.mission_id)).then(
      (data) => live && setView({ status: "ok", data }),
      (e) => live && setView({ status: "error", text: describeError(e) }),
    );
    return () => {
      live = false;
    };
  }, [mission.mission_id, tick]);

  return (
    <div className="card" aria-label={`Funding check for ${mission.title}`}>
      <h3>Funding check: {mission.title}</h3>
      {view.status === "loading" && <Loading label="Loading balance…" />}
      {view.status === "error" && <ErrorLine text={view.text} onRetry={() => setTick((n) => n + 1)} />}
      {view.status === "ok" && (
        <dl className="wallet-figures">
          <div><dt>Available</dt><dd>{formatMoney(view.data.available, view.data.currency)}</dd></div>
          <div><dt>Mission budget</dt><dd>{formatMoney(view.data.budget, view.data.currency)}</dd></div>
          <div>
            <dt>Shortfall</dt>
            <dd>{formatMoney(shortfall(view.data.budget, view.data.available), view.data.currency)}</dd>
          </div>
        </dl>
      )}
      <button
        type="button"
        className="primary-button"
        disabled={view.status !== "ok" || confirmed}
        onClick={() => setConfirmed(true)}
      >
        {confirmed ? "Budget confirmed" : "Confirm budget"}
      </button>
    </div>
  );
}

/** Top-up: a Deposit for this mission, approved by the buyer at PayPal (R7.6). */
function TopUpForm({ mission, onChanged }: { mission: MissionWallet; onChanged: () => void }) {
  const [amount, setAmount] = useState(shortfall(mission.budget, mission.available) === "0.00" ? "" : shortfall(mission.budget, mission.available));
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busyRef.current) return;
    const problem = validateDepositAmount(amount);
    setFieldError(problem);
    setError("");
    if (problem) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const dep = await walletApi.topUp(mission.mission_id, {
        amount: formatAmount(amount.trim()),
        currency: mission.currency,
      });
      const url = dep.approve_url ? new URL(dep.approve_url) : null;
      if (!url || url.protocol !== "https:") {
        throw Object.assign(new Error("PayPal did not return an approval link."), {
          code: "PAYPAL_BAD_RESPONSE",
        });
      }
      onChanged();
      window.location.assign(url.toString());
    } catch (err) {
      setError(describeError(err));
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <form className="portal-form" onSubmit={submit} noValidate aria-label={`Top up ${mission.title}`}>
      <label>
        Top-up amount ({mission.currency})
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-invalid={fieldError ? true : undefined}
          disabled={busy}
        />
      </label>
      {fieldError && (
        <div role="alert" className="field-note" style={{ color: "var(--color-danger)" }}>
          {fieldError}
        </div>
      )}
      <button type="submit" className="primary-button" disabled={busy} aria-busy={busy}>
        {busy ? "Opening PayPal…" : "Top up"}
      </button>
      {error && <ErrorLine text={error} />}
    </form>
  );
}

/**
 * Remainder decision for a mission in `awaiting_decision` (R8, R15.10 to R15.12). Two actions,
 * neither selected. The advice is display only; the buyer's click is the only decision.
 */
function DecisionPrompt({
  mission,
  canMoveMoney,
  onChanged,
}: {
  mission: MissionWallet;
  canMoveMoney: boolean;
  onChanged: () => void;
}) {
  const [tick, setTick] = useState(0);
  const [prompt, setPrompt] = useState<RemainderPrompt | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  useEffect(() => {
    let live = true;
    setLoading(true);
    // On timeout or error the deterministic text stays and both actions stay enabled (R15.12).
    withTimeout(walletApi.remainderPrompt(mission.mission_id)).then(
      (p) => {
        if (!live) return;
        setPrompt(p);
        setLoading(false);
      },
      () => {
        if (!live) return;
        setPrompt(null);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [mission.mission_id, tick]);

  const decide = useCallback(
    async (decision: "refund" | "keep") => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError("");
      try {
        const r = await walletApi.decideRemainder(mission.mission_id, decision);
        setResult(
          r.decision === "refund"
            ? `Refund of ${formatMoney(r.refund_amount, mission.currency)} requested.`
            : `Kept ${formatMoney(r.remainder_amount, mission.currency)} in your wallet.`,
        );
        onChanged();
      } catch (e) {
        setError(describeError(e));
        busyRef.current = false;
        setBusy(false);
      }
    },
    [mission.mission_id, mission.currency, onChanged],
  );

  const remainder = prompt?.figures.available ?? mission.available;
  const currency = prompt?.figures.currency ?? mission.currency;
  const text = prompt ? adviceText(prompt.advice) : null;
  const aiGenerated = !!prompt && prompt.ai_generated;

  return (
    <div className="card" role="group" aria-label={`Remainder decision for ${mission.title}`}>
      <h3>Remainder: {mission.title}</h3>
      <p>
        <strong>{formatMoney(remainder, currency)}</strong> is left after this mission.
      </p>
      {loading ? (
        <Loading label="Loading advice…" />
      ) : (
        <>
          <p className="field-note">{text?.body ?? LOCAL_REMAINDER_TEXT}</p>
          <span className={`badge ${aiGenerated ? "badge-info" : "badge-neutral"}`}>
            {aiGenerated ? (prompt?.label ?? "AI-generated advice (display only)") : "Not AI-generated"}
          </span>
        </>
      )}
      {canMoveMoney ? (
        result ? (
          <p role="status" aria-live="polite">{result}</p>
        ) : (
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => decide("refund")}>
              Refund to PayPal
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => decide("keep")}>
              Keep in wallet
            </button>
          </div>
        )
      ) : (
        <p className="field-note">Only the mission owner can decide.</p>
      )}
      {error && <ErrorLine text={error} onRetry={() => setTick((n) => n + 1)} />}
    </div>
  );
}

/** Missions section of the Wallet page: grid, funding check, top-up and remainder prompt. */
export function MissionsSection({
  state,
  canMoveMoney,
  onChanged,
}: {
  state: FetchResult<{ missions: MissionWallet[] }>;
  canMoveMoney: boolean;
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const list = state.status === "ok" ? (state.data?.missions ?? []) : [];
  const current = list.find((m) => m.mission_id === selected) ?? null;

  return (
    <section id="wallet-missions" tabIndex={-1}>
      <Card title="Missions" icon={Briefcase}>
        {state.status === "loading" || state.status === "idle" ? (
          <Loading />
        ) : state.status === "error" ? (
          <ErrorLine text={describeError(new Error(state.error))} onRetry={state.reload} />
        ) : list.length === 0 ? (
          <EmptyState icon={Briefcase} title="No funded missions">
            Create a mission and set a budget to see its funding here.
          </EmptyState>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Mission</th>
                <th scope="col">Budget</th>
                <th scope="col">Available</th>
                <th scope="col">Shortfall</th>
                <th scope="col">State</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.mission_id}>
                  <td>{m.title}</td>
                  <td>{formatMoney(m.budget, m.currency)}</td>
                  <td>{formatMoney(m.available, m.currency)}</td>
                  <td>{formatMoney(shortfall(m.budget, m.available), m.currency)}</td>
                  <td>{m.state}</td>
                  <td>
                    <button
                      type="button"
                      className="secondary-button"
                      aria-pressed={selected === m.mission_id}
                      onClick={() => setSelected(selected === m.mission_id ? null : m.mission_id)}
                    >
                      {m.state === "awaiting_decision" ? "Decide" : "Details"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {current && (
          <div style={{ marginTop: "var(--space-3)" }}>
            {current.state === "awaiting_decision" ? (
              <DecisionPrompt key={current.mission_id} mission={current} canMoveMoney={canMoveMoney} onChanged={onChanged} />
            ) : (
              <>
                <PreConfirmPanel key={current.mission_id} mission={current} />
                {current.state === "depleted" && canMoveMoney && (
                  <TopUpForm key={`t-${current.mission_id}`} mission={current} onChanged={onChanged} />
                )}
              </>
            )}
          </div>
        )}
      </Card>
    </section>
  );
}
