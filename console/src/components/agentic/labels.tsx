import React from "react";

/** Marks a narrative, explanation or mapping that came from a recorded model response (R4.8). */
export const ReplayLabel: React.FC = () => (
  <span className="badge badge-neutral" title="Replayed from a recorded model response, not a live call">Replayed</span>
);

/** Marks an Agreement a buyer agent accepted under a Mandate: shows the Mandate ID, and the Replay_Label when replayed (R4.8). */
export const AutonomousLabel: React.FC<{ mandateId: string; replayed?: boolean }> = ({ mandateId, replayed }) => (
  <span className="autonomous-label">
    <span className="badge badge-info" title="Accepted by a buyer agent under a Mandate, not by a person">Autonomous</span>{" "}
    <span className="card-sub">Mandate <code>{mandateId}</code></span>
    {replayed ? <> <ReplayLabel /></> : null}
  </span>
);

/** Marks text written by a model, so nobody reads it as a deterministic figure (R7.8, R12.7). */
export const ModelWrittenLabel: React.FC = () => (
  <span className="badge badge-neutral" title="Written by an AI model. Figures come from the ledger.">Model-written</span>
);
