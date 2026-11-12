/**
 * Mission results archive: every verified result, kept permanently for future reference.
 * The server stores each one append-only when its mission completes (and backfills older ones),
 * so the record survives later edits, replays, deletions or provider changes.
 */
import { useState } from "react";
import { Archive } from "lucide-react";
import { api, MissionResultRecord } from "../api.js";
import { useFetch } from "../hooks.js";
import { useLiveRefresh } from "../live.js";
import { Icon } from "./ui.js";
import { StatusBadge } from "./StatusBadge.js";

const SEVERITY_VARIANT: Record<string, "error" | "warning" | "info"> = { critical: "error", high: "error", medium: "warning", low: "info" };
const ORDER = ["critical", "high", "medium", "low"];

function exportJson(rows: MissionResultRecord[]) {
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `stoat-mission-results-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ResultsArchive({ collapsible = false }: { collapsible?: boolean }) {
  const results = useFetch(() => api.missionResults(), []);
  useLiveRefresh(() => results.reload(), 30_000);
  const [query, setQuery] = useState("");
  const rows = results.status === "ok" ? results.data.results : [];
  const q = query.trim().toLowerCase();
  const shown = q
    ? rows.filter((r) => [r.mission_title, r.provider_name, r.summary, ...r.findings.map((f) => `${f.title ?? ""} ${f.rule_id} ${f.file}`)]
        .some((t) => (t ?? "").toLowerCase().includes(q)))
    : rows;

  const body = (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <input className="grid-search-input" placeholder="Search missions, providers, findings…" aria-label="Search archived results"
          value={query} onChange={(e) => setQuery(e.target.value)} style={{ minWidth: 260 }} />
        <button type="button" className="secondary-button small-button" disabled={rows.length === 0} onClick={() => exportJson(shown)}>
          Export JSON
        </button>
        <span className="card-sub">{shown.length} of {rows.length} archived</span>
      </div>
      {results.status === "loading" || results.status === "idle" ? (
        <p className="card-sub">Loading archived results…</p>
      ) : results.status === "error" ? (
        <p className="notice notice-error" role="alert">{results.error} <button type="button" className="secondary-button small-button" onClick={results.reload}>Retry</button></p>
      ) : shown.length === 0 ? (
        <p className="card-sub">{rows.length === 0 ? "No results yet. Verified work is archived here when a mission completes." : "No archived result matches your search."}</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
          {shown.map((r) => (
            <li key={r.id} style={{ border: "1px solid var(--border-subtle)", borderRadius: 8, padding: "8px 12px" }}>
              <details>
                <summary style={{ cursor: "pointer" }}>
                  <strong>{r.mission_title}</strong>{r.replay_of ? <span className="card-sub"> · replay</span> : null}
                  <span className="card-sub"> · {r.provider_name ?? "provider"} · {new Date(r.archived_at).toLocaleString()}
                    {r.charged ? ` · ${Number(r.charged).toFixed(2)} ${r.currency ?? ""}` : ""}</span>{" "}
                  {r.findings_count === 0
                    ? <StatusBadge label="no defects" variant="ok" />
                    : ORDER.filter((s) => r.severity_counts?.[s]).map((s) => (
                        <StatusBadge key={s} label={`${r.severity_counts[s]} ${s}`} variant={SEVERITY_VARIANT[s] ?? "info"} />
                      ))}
                </summary>
                <div style={{ marginTop: 8 }}>
                  {r.summary && <p>{r.summary}</p>}
                  {r.files_reviewed && <p className="card-sub">Files reviewed: {r.files_reviewed.join(", ")}</p>}
                  {r.findings.length > 0 && (
                    <ol>
                      {r.findings.map((f, i) => (
                        <li key={`${f.file}:${f.line_start}:${i}`}>
                          <StatusBadge label={f.severity} variant={SEVERITY_VARIANT[f.severity] ?? "info"} />{" "}
                          <strong>{f.title ?? f.rule_id}</strong>{" "}
                          <code>{f.file}:{f.line_start}{f.line_end !== f.line_start ? `-${f.line_end}` : ""}</code>
                          {f.description ? <div className="card-sub">{f.description}</div> : null}
                          {f.recommendation ? <div className="card-sub">Fix: {f.recommendation}</div> : null}
                        </li>
                      ))}
                    </ol>
                  )}
                  <p className="card-sub">
                    Verified by {r.verified_by ?? "verifier"}{r.model ? ` · model ${r.model}` : ""}{r.artifact_hash ? ` · artifact ${r.artifact_hash.slice(0, 12)}…` : ""}
                  </p>
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  return collapsible ? (
    <details className="portal-card" style={{ padding: 12 }}>
      <summary style={{ cursor: "pointer", fontWeight: 700 }}><Icon icon={Archive} /> Results archive ({rows.length})</summary>
      <div style={{ marginTop: 10 }}>{body}</div>
    </details>
  ) : (
    <section className="portal-card">
      <div className="section-heading">
        <div>
          <h2><Icon icon={Archive} /> Results archive</h2>
          <p className="card-sub">Every verified result, kept permanently for future reference.</p>
        </div>
      </div>
      {body}
    </section>
  );
}
