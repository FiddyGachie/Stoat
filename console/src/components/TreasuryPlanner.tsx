import React, { useState } from 'react';
import { Bot } from 'lucide-react';
import { api, TreasuryPlan } from '../api.js';
import { Card, Icon } from './ui.js';
import { StatusBadge } from './StatusBadge.js';

const ROUTE_LABEL: Record<TreasuryPlan['batches'][number]['route'], string> = {
  release_collected_funds: 'release the buyer’s PayPal payment',
  collect_via_paypal_order: 'collect with a PayPal order',
};

/**
 * The treasury agent reads verified, unbatched work and proposes settlement batches, choosing the
 * PayPal route for each. The server checks every choice; batches still need a person's approval.
 */
export const TreasuryPlanner: React.FC<{ onPlanned: () => void }> = ({ onPlanned }) => {
  const [plan, setPlan] = useState<TreasuryPlan | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  async function run() {
    setWorking(true); setError(''); setPlan(null);
    try { const p = await api.treasuryPlan(); setPlan(p); if (p.batches.length) onPlanned(); }
    catch (e) { setError(e instanceof Error ? e.message : 'The treasury agent could not plan.'); }
    finally { setWorking(false); }
  }

  return (
    <Card title="Treasury agent" icon={Bot} description="Plans how verified work gets paid. It only proposes; you approve.">
      <div className="help-links">
        <button type="button" className="btn btn-secondary" disabled={working} onClick={() => void run()}>
          <Icon icon={Bot} /> {working ? 'The treasury agent is planning…' : 'Let the treasury agent plan payment'}
        </button>
      </div>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {plan && (
        <div className="notice notice-success" role="status">
          {plan.model && (
            <p>
              <StatusBadge label={plan.replayed ? 'replayed recording' : `live · ${plan.mode}`} variant={plan.replayed ? 'replayed' : 'live'} />{' '}
              <span className="card-sub">model {plan.model}</span>
            </p>
          )}
          <p>{plan.summary}</p>
          {plan.batches.length > 0 && (
            <ul>
              {plan.batches.map((b) => (
                <li key={b.batch_id}>
                  Batch {b.batch_id.slice(0, 8)}…: <strong>{b.total} {b.currency}</strong>, {b.obligation_count} obligation(s), route: {ROUTE_LABEL[b.route]}.{' '}
                  <span className="card-sub">{b.rationale}</span>
                  <p><strong>Next:</strong> {b.next_action}</p>
                </li>
              ))}
            </ul>
          )}
          {plan.excluded.length > 0 && (
            <ul>
              {plan.excluded.map((x) => <li key={x.obligation_id}>Left out {x.obligation_id.slice(0, 8)}…: {x.reason}</li>)}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
};
