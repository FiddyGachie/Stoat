import React, { useState } from 'react';
import { Handshake } from 'lucide-react';
import { api, NegotiationResult } from '../api.js';
import { Icon } from './ui.js';
import { StatusBadge } from './StatusBadge.js';
import { useFundingMode } from '../fundingMode.js';

const REASONS: Record<string, string> = {
  OFFER_BELOW_PROVIDER_FLOOR: 'below what this provider will accept',
  OFFER_ABOVE_LISTED_PRICE: 'above the listed price',
  PRICE_NOT_NEGOTIABLE: 'this provider does not negotiate',
  EXCEEDS_MISSION_BUDGET: 'more than the mission budget left',
  CURRENCY_MISMATCH: 'wrong currency',
  QUOTE_MISMATCH: 'not the recommended offer',
  AMOUNT_INVALID: 'not a valid amount',
  SCHEMA_INVALID: 'malformed answer',
};

/**
 * The buyer agent compares the open offers with a real model, may counteroffer, and recommends.
 * The model only proposes. The server checks every number, and the spending policy still decides
 * when you accept. Nothing here can change who is paid.
 */
export const NegotiationPanel: React.FC<{
  missionId: string;
  openQuotes: number;
  busy: boolean;
  onAccept: (quoteId: string, proposalId: string) => void;
}> = ({ missionId, openQuotes, busy, onAccept }) => {
  const [result, setResult] = useState<NegotiationResult | null>(null);
  const [working, setWorking] = useState(false);
  const fundingMode = useFundingMode();
  const [error, setError] = useState('');
  if (openQuotes === 0) return null;

  async function negotiate() {
    setWorking(true); setError(''); setResult(null);
    try { setResult(await api.negotiate(missionId)); }
    catch (e) { setError(e instanceof Error ? e.message : 'The buyer agent could not negotiate.'); }
    finally { setWorking(false); }
  }

  return (
    <div className="negotiation-panel">
      <div className="help-links">
        <button type="button" className="btn btn-secondary" disabled={working || busy} onClick={() => void negotiate()}>
          <Icon icon={Handshake} /> {working ? 'Your buyer agent is negotiating…' : 'Let my buyer agent negotiate'}
        </button>
        <span className="card-sub">It compares the offers and may counteroffer. {fundingMode === 'wallet' ? 'You still approve the deal; the price is reserved from your wallet.' : 'You still approve the deal and the payment.'}</span>
      </div>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {result && (
        <div className="notice notice-success" role="status">
          <p>
            <StatusBadge label={result.replayed ? 'replayed recording' : `live · ${result.mode}`} variant={result.replayed ? 'replayed' : 'live'} />{' '}
            <span className="card-sub">model {result.model}</span>
          </p>
          <p><strong>Recommendation:</strong> {result.comparison.rationale_summary}</p>
          {result.counteroffers.length > 0 && (
            <ul>
              {result.counteroffers.map((c, i) => (
                <li key={c.proposal_id}>
                  Counteroffer {i + 1}: {c.payload ? `${c.payload.proposed_amount} ${c.payload.currency}` : 'unreadable'}{' '}
                  {c.validation === 'passed'
                    ? <StatusBadge label="accepted by the checks" variant="ok" />
                    : <StatusBadge label={`rejected: ${c.reason_codes.map((r) => REASONS[r] ?? r).join(', ')}`} variant="warning" />}
                  {c.payload?.rationale_summary ? <span className="card-sub"> {c.payload.rationale_summary}</span> : null}
                </li>
              ))}
            </ul>
          )}
          <p>
            <strong>Proposed deal:</strong> {result.selection.service} by {result.selection.provider} at{' '}
            <strong>{result.selection.agreed_amount} {result.selection.currency}</strong>
            {result.selection.agreed_amount !== result.selection.listed_price ? ` (listed ${result.selection.listed_price})` : ' (listed price)'}
          </p>
          <div className="help-links">
            <button type="button" className="btn btn-primary" disabled={busy}
              onClick={() => onAccept(result.selection.quote_id, result.selection.proposal_id)}>
              {fundingMode === 'wallet' ? 'Accept this deal (reserve from wallet)' : 'Accept this deal and pay'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
