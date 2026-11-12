import React, { useState } from 'react';
import { FileCheck2 } from 'lucide-react';
import { api, AgreementResult } from '../api.js';
import { Icon } from './ui.js';
import { StatusBadge } from './StatusBadge.js';
import { AutonomousLabel } from './agentic/labels.js';

const SEVERITY_VARIANT: Record<string, 'error' | 'warning' | 'info'> = { critical: 'error', high: 'error', medium: 'warning', low: 'info' };

/**
 * The work the provider agent actually delivered for an agreement. Only a delivery the deterministic
 * verifier accepted is shown as the result; rejected attempts are listed with the verifier's reasons.
 */
export const MissionResult: React.FC<{ agreementId: string }> = ({ agreementId }) => {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AgreementResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true); setLoading(true); setError('');
    try { setData(await api.agreementResult(agreementId)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load the result.'); }
    finally { setLoading(false); }
  }

  const r = data?.result;
  return (
    <div className="mission-result">
      <button type="button" className="text-button" aria-expanded={open} onClick={() => void toggle()}>
        <Icon icon={FileCheck2} /> {open ? 'Hide result' : 'View result'}
      </button>
      {open && loading && <p className="muted-copy">Loading the delivered work…</p>}
      {open && error && <p className="notice notice-error" role="alert">{error}</p>}
      {open && data && (
        <div className="notice" role="region" aria-label="Delivered result">
          {data.agreement.mandate_id && (
            <p><AutonomousLabel mandateId={data.agreement.mandate_id} replayed={data.agreement.replayed} /></p>
          )}
          {r ? (
            <>
              <p>
                <StatusBadge label="verified" variant="ok" />{' '}
                <span className="card-sub">by {data.provider.name}{r.model ? ` · model ${r.model}` : ''} · verifier {r.verified_by}</span>
              </p>
              {r.summary && <p>{r.summary}</p>}
              {r.files_reviewed && <p className="card-sub">Files reviewed: {r.files_reviewed.join(', ')}</p>}
              {r.findings.length === 0 ? (
                <p>No defects were found.</p>
              ) : (
                <ol>
                  {r.findings.map((f, i) => (
                    <li key={`${f.file}:${f.line_start}:${i}`}>
                      <StatusBadge label={f.severity} variant={SEVERITY_VARIANT[f.severity] ?? 'info'} />{' '}
                      <strong>{f.title ?? f.rule_id}</strong>{' '}
                      <code>{f.file}:{f.line_start}{f.line_end !== f.line_start ? `-${f.line_end}` : ''}</code>{' '}
                      <span className="card-sub">{f.rule_id}</span>
                      {f.description && <p className="card-sub">{f.description}</p>}
                      {f.recommendation && <p><strong>Fix:</strong> {f.recommendation}</p>}
                    </li>
                  ))}
                </ol>
              )}
            </>
          ) : (
            <p>No verified delivery yet.</p>
          )}
          {data.attempts.length > 1 || (data.attempts[0] && data.attempts[0].verdict !== 'verified') ? (
            <details>
              <summary>Attempts ({data.attempts.length})</summary>
              <ul>
                {data.attempts.map((a) => (
                  <li key={a.delivery_id}>
                    Revision {a.revision}: {a.verdict} ({a.checks_passed} checks passed, {a.checks_failed} failed)
                    {a.reasons.length > 0 && <span className="card-sub"> {a.reasons.slice(0, 3).join('; ')}</span>}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      )}
    </div>
  );
};
