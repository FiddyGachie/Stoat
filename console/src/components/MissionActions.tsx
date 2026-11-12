/**
 * Manage one mission: edit or delete it while it is open, or replay it once completed.
 *
 * Replay copies the mission with half the last final spend as its budget, requests a quote from
 * the same service and lets the buyer agent negotiate toward that price. The provider's floor is
 * respected and nothing is accepted for you: "Accept the negotiated deal" is your decision.
 * The server checks ownership and every rule; these buttons only describe what it will do.
 */
import { FormEvent, useEffect, useState } from "react";
import { Pencil, RotateCcw, Trash2 } from "lucide-react";
import { api, Mission, MissionReplayResult } from "../api.js";
import { Icon } from "./ui.js";

const money = (v: unknown, c?: string) => `${Number(v ?? 0).toFixed(2)}${c ? ` ${c}` : ""}`;

export function MissionActions({
  mission,
  onChanged,
  onAccept,
}: {
  mission: Mission;
  onChanged: () => void;
  /** Accept a quote (optionally a negotiated proposal) through the page's normal accept flow. */
  onAccept?: (quoteId: string, proposalId?: string) => void;
}) {
  const [mode, setMode] = useState<"idle" | "edit">("idle");
  const [title, setTitle] = useState(mission.title);
  const [brief, setBrief] = useState(mission.brief);
  const [budget, setBudget] = useState(Number(mission.budget).toFixed(2));
  const [busy, setBusy] = useState<null | "save" | "delete" | "replay">(null);
  const [error, setError] = useState("");
  const [replay, setReplay] = useState<MissionReplayResult | null>(null);

  useEffect(() => {
    if (mode === "idle") {
      setTitle(mission.title);
      setBrief(mission.brief);
      setBudget(Number(mission.budget).toFixed(2));
    }
  }, [mission.id, mission.title, mission.brief, mission.budget, mode]);

  if (mission.status !== "created" && mission.status !== "completed") return null;

  async function save(e: FormEvent) {
    e.preventDefault();
    const b = budget.trim();
    if (!title.trim() || !brief.trim()) { setError("Title and brief are required."); return; }
    if (!/^\d+(\.\d{1,2})?$/.test(b) || Number(b) <= 0) { setError("Budget must be greater than 0 with at most 2 decimals."); return; }
    setBusy("save"); setError("");
    try {
      await api.updateMission(mission.id, { title: title.trim(), brief: brief.trim(), budget: b });
      setMode("idle");
      onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not update the mission."); }
    finally { setBusy(null); }
  }

  async function remove() {
    if (!window.confirm(`Delete "${mission.title}"? Open quotes are withdrawn. The mission and its history are kept for reference but it stops appearing in your list.`)) return;
    setBusy("delete"); setError("");
    try { await api.deleteMission(mission.id); onChanged(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not delete the mission."); }
    finally { setBusy(null); }
  }

  async function doReplay() {
    if (!window.confirm(`Replay "${mission.title}" at half the last price? A new mission is created with half the last spend as its budget, a quote is requested from the same service, and your buyer agent negotiates. You still decide whether to accept.`)) return;
    setBusy("replay"); setError(""); setReplay(null);
    try { setReplay(await api.replayMission(mission.id)); onChanged(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not replay the mission."); }
    finally { setBusy(null); }
  }

  const sel = replay?.negotiation?.selection;
  const withinTarget = sel && replay && Number(sel.agreed_amount) <= Number(replay.target_budget);

  return (
    <div className="mission-actions" style={{ marginTop: 8 }}>
      {mission.status === "created" && mode === "idle" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="secondary-button small-button" disabled={busy !== null} onClick={() => { setMode("edit"); setError(""); }}>
            <Icon icon={Pencil} /> Edit
          </button>
          <button type="button" className="secondary-button small-button" style={{ color: "var(--color-danger)" }}
            disabled={busy !== null} aria-busy={busy === "delete"} onClick={() => void remove()}>
            <Icon icon={Trash2} /> {busy === "delete" ? "Deleting…" : "Delete"}
          </button>
        </div>
      )}

      {mission.status === "created" && mode === "edit" && (
        <form onSubmit={(e) => void save(e)} noValidate style={{ display: "grid", gap: 8, maxWidth: 640 }}>
          <label className="card-sub" style={{ display: "grid", gap: 4 }}>
            Title
            <input className="grid-search-input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} disabled={busy !== null} />
          </label>
          <label className="card-sub" style={{ display: "grid", gap: 4 }}>
            Brief
            <textarea className="grid-search-input" rows={3} value={brief} maxLength={5000} onChange={(e) => setBrief(e.target.value)} disabled={busy !== null} />
          </label>
          <label className="card-sub" style={{ display: "grid", gap: 4, maxWidth: 200 }}>
            Budget ({mission.currency})
            <input className="grid-search-input" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} disabled={busy !== null} />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" className="primary-button small-button" disabled={busy !== null} aria-busy={busy === "save"}>
              {busy === "save" ? "Saving…" : "Save changes"}
            </button>
            <button type="button" className="secondary-button small-button" disabled={busy !== null} onClick={() => { setMode("idle"); setError(""); }}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {mission.status === "completed" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button type="button" className="secondary-button small-button" disabled={busy !== null} aria-busy={busy === "replay"} onClick={() => void doReplay()}>
            <Icon icon={RotateCcw} /> {busy === "replay" ? "Replaying…" : "Replay at half price"}
          </button>
          <span className="card-sub">Results are archived below for future reference.</span>
        </div>
      )}

      {replay && (
        <div className="notice notice-success" role="status" style={{ marginTop: 8 }}>
          <p style={{ margin: 0 }}>
            Replay created: <strong>{replay.mission.title}</strong> with a budget of {money(replay.target_budget, replay.mission.currency)} (half
            of the last spend, {money(replay.last_spend, replay.mission.currency)}).
          </p>
          {sel ? (
            <p style={{ margin: "6px 0 0" }}>
              Your buyer agent negotiated {sel.provider}: listed {money(sel.listed_price, sel.currency)}, agreed {money(sel.agreed_amount, sel.currency)}.{" "}
              {withinTarget
                ? "That fits the replay budget."
                : "That is above the replay budget, so accepting would be refused. Raise the mission budget (Edit) or ask again."}
            </p>
          ) : (
            <p style={{ margin: "6px 0 0" }}>
              Negotiation did not run{replay.negotiation_error ? ` (${replay.negotiation_error.code})` : ""}. The quote is open on the new mission;
              you can negotiate there or raise the budget.
            </p>
          )}
          {sel && withinTarget && onAccept && (
            <button type="button" className="primary-button small-button" style={{ marginTop: 8 }}
              onClick={() => onAccept(sel.quote_id, sel.proposal_id)}>
              Accept the negotiated deal
            </button>
          )}
        </div>
      )}

      {error && <p className="notice notice-error" role="alert" style={{ marginTop: 8 }}>{error}</p>}
    </div>
  );
}
