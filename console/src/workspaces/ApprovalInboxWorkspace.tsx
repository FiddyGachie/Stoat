import React, { useMemo, useState } from "react";
import type { ColDef } from "ag-grid-community";
import { X } from "lucide-react";
import { agenticApi } from "../api.js";
import { useLatestFetch } from "../hooks.js";
import { Card, EmptyState, Icon, Loading } from "../components/ui.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { VirtualGridPanel } from "../components/agentic/VirtualGridPanel.js";
import { ModelWrittenLabel, ReplayLabel } from "../components/agentic/labels.js";
import {
  canSubmitDecision,
  commentRequired,
  decisionErrorText,
  toGridRow,
  topupHref,
} from "../components/agentic/approvalHelpers.js";

type Row = Record<string, unknown>;

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const asRow = (v: unknown): Row => (v && typeof v === "object" ? (v as Row) : {});
const when = (v: unknown): string => (v ? new Date(str(v)).toLocaleString() : "");

const STATUS_VARIANT: Record<string, "ok" | "warning" | "error" | "info"> = {
  pending: "warning",
  approved: "info",
  executed: "ok",
  rejected: "error",
  expired: "error",
  invalid: "error",
  execution_failed: "error",
};

const COLS: ColDef[] = [
  { field: "type", headerName: "Type", width: 160 },
  { field: "subject", headerName: "Subject", width: 190 },
  { field: "agent", headerName: "Proposed by", width: 130 },
  { field: "rationale", headerName: "Rationale", flex: 1, minWidth: 220 },
  { field: "validation", headerName: "Validation", width: 150 },
  { field: "created_at", headerName: "Created", width: 170, valueFormatter: ({ value }) => when(value) },
  { field: "expires_at", headerName: "Expires", width: 170, valueFormatter: ({ value }) => when(value) },
];

interface DrawerProps {
  proposalId: string;
  onClose: () => void;
  /** Called after the server confirms a decision. */
  onDecided: (proposal: Row) => void;
}

function ProposalDrawer({ proposalId, onClose, onDecided }: DrawerProps) {
  const detail = useLatestFetch((signal) => agenticApi.proposals.get(proposalId, { signal }), [proposalId]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Only ever set from a server response, so a failed decision leaves the last confirmed status.
  const [confirmed, setConfirmed] = useState<Row | undefined>(undefined);

  const d = detail.status === "ok" ? asRow(detail.data) : undefined;
  const proposal = { ...asRow(d?.proposal), ...(confirmed ?? {}) };
  const type = str(proposal.proposal_type);
  const status = str(proposal.status);
  const preview = asRow(d?.preview);
  const prov = asRow(d?.provenance);
  const decided = confirmed !== undefined || (status !== "" && status !== "pending");
  const needsComment = commentRequired(type);

  async function decide(kind: "approve" | "reject") {
    setBusy(true);
    setError("");
    try {
      const res = asRow(
        kind === "approve"
          ? await agenticApi.proposals.approve(proposalId, text.trim() || undefined)
          : await agenticApi.proposals.reject(proposalId, text.trim()),
      );
      const fresh = asRow(res.proposal);
      setConfirmed({ ...fresh, status: str(res.status ?? fresh.status) });
      onDecided(fresh);
      if (kind === "approve" && type === "topup_suggestion") {
        const payload = asRow(proposal.payload);
        window.location.hash = topupHref(payload.mission_id, proposal.display_amount_hint ?? payload.display_amount_hint).replace(/^#/, "");
      }
    } catch (err) {
      // The server did not confirm: keep the last confirmed status and show the code.
      setError(decisionErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="card" role="complementary" aria-label="Proposal detail">
      <div className="card-header">
        <h2 className="card-title">Proposal {proposalId.slice(0, 8)}…</h2>
        <button type="button" className="icon-button" aria-label="Close detail" onClick={onClose}>
          <Icon icon={X} />
        </button>
      </div>
      {detail.status === "loading" && !d && <Loading label="Loading Proposal…" />}
      {detail.status === "error" && !d && (
        <p className="notice notice-error" role="alert">Could not load this Proposal: {detail.error}</p>
      )}
      {d && (
        <>
          <p>
            <StatusBadge label={status || "pending"} variant={STATUS_VARIANT[status] ?? "info"} />{" "}
            <span className="card-sub">{type} · expires {when(proposal.expires_at)}</span>
          </p>
          <p>
            {str(proposal.rationale)} <ModelWrittenLabel />
          </p>

          <h3>What approving does</h3>
          <p className="card-sub">Recomputed by the server from stored records. Amounts are hints only.</p>
          <pre aria-label="Server-recomputed preview">{JSON.stringify(preview, null, 2)}</pre>

          <h3>Payload</h3>
          <pre aria-label="Proposal payload">{JSON.stringify(proposal.payload ?? {}, null, 2)}</pre>

          <h3>Validation decision</h3>
          <pre aria-label="Validation decision">{JSON.stringify(d.validation_decision ?? null, null, 2)}</pre>

          <h3>Provenance</h3>
          <dl>
            <dt>Prompt hash</dt><dd><code>{str(prov.prompt_hash) || "none"}</code></dd>
            <dt>Model ID</dt><dd><code>{str(prov.model_id) || "none"}</code></dd>
            <dt>Run ID</dt><dd><code>{str(prov.agent_run_id) || "none"}</code></dd>
          </dl>
          {prov.replayed === true && <p><ReplayLabel /></p>}

          {error && <p className="notice notice-error" role="alert">{error}</p>}
          {decided ? (
            <p className="card-sub" role="status">This Proposal is {status}.</p>
          ) : (
            <form className="portal-form" aria-label="Decide Proposal" onSubmit={(e) => e.preventDefault()}>
              <label>
                {needsComment ? "Comment (required to approve)" : "Comment (optional) or reason (required to reject)"}
                <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={500} rows={3} />
              </label>
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy || !canSubmitDecision("approve", type, text)}
                  onClick={() => void decide("approve")}
                >
                  {busy ? "Working…" : "Approve"}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || !canSubmitDecision("reject", type, text)}
                  onClick={() => void decide("reject")}
                >
                  Reject
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </aside>
  );
}

export const ApprovalInboxWorkspace: React.FC = () => {
  const list = useLatestFetch(
    (signal) => agenticApi.proposals.list({ status: "pending", limit: 100 }, { signal }),
    [],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const rows = useMemo(
    () => (list.status === "ok" ? list.data.proposals.map(toGridRow) : []),
    [list],
  );

  if (list.status === "loading" && selected === null && rows.length === 0) return <Loading label="Loading Proposals…" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      <Card title="Waiting for you" description="Agents propose; only you approve. Approving never moves money by itself.">
        {list.status === "ok" && rows.length === 0 ? (
          <EmptyState title="Nothing is waiting">There are no pending Proposals.</EmptyState>
        ) : (
          <VirtualGridPanel
            title="Pending Proposals"
            rows={rows}
            cols={COLS}
            loading={list.status === "loading"}
            error={list.status === "error" ? list.error : undefined}
            getRowId={(p) => str((p.data as Row).id)}
            onRowClick={(row) => setSelected(str((row as Row).id))}
          />
        )}
      </Card>
      {selected && (
        <ProposalDrawer
          key={selected}
          proposalId={selected}
          onClose={() => setSelected(null)}
          onDecided={() => list.reload()}
        />
      )}
    </div>
  );
};
