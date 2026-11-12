import React, { useState } from 'react';
import { Banknote, CircleCheck, ShieldCheck } from 'lucide-react';
import { api } from '../api.js';
import { useFetch } from '../hooks.js';
import { Icon } from './ui.js';
import { StatusBadge } from './StatusBadge.js';

type Row = Record<string, unknown>;
interface Approval { approval_id: string; expires_at: string; total: string; currency: string; providers: { name: string; amount: string; recipient_masked: string }[] }

/**
 * Paying providers (PayPal Payouts). Four deliberate steps, none of which an agent can take:
 * 1) a person adds the provider's PayPal address with consent, 2) a person confirms the masked
 * address, 3) a person approves exactly what will be sent, 4) a person sends it. The server
 * re-checks that nothing changed between steps 3 and 4.
 */
export const ProviderPayouts: React.FC<{ batchId: string; batchStatus: string; onChanged: () => void }> = ({ batchId, batchStatus, onChanged }) => {
  const paypal = useFetch(() => api.paypalStatus());
  const providers = useFetch(() => api.batchProviders(batchId), [batchId, batchStatus]);
  const [forms, setForms] = useState<Record<string, { email: string; consent: boolean }>>({});
  const [approval, setApproval] = useState<Approval | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  if (batchStatus !== 'confirmed') return null;
  const rows: Row[] = providers.status === 'ok' ? providers.data.providers : [];
  if (rows.length === 0) return null;

  const cap = paypal.status === 'ok' ? paypal.data.payouts : null;
  const blocked = cap !== null && !cap.enabled;
  const live = (r: Row) => {
    const po = r['payout'] as Row | null;
    return !!po && ['requested', 'processing', 'paid'].includes(String(po['status']));
  };
  const allVerified = rows.every((r) => live(r) || r['recipient_status'] === 'verified');
  const needsSending = rows.some((r) => !live(r));

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'That did not work.'); } finally { setBusy(false); }
  }

  return (
    <div style={{ marginTop: 'var(--space-4)' }}>
      <h3 className="card-sub"><Icon icon={Banknote} /> Pay providers</h3>
      {blocked && (
        <p className="notice notice-error" role="status">
          Provider payout unavailable: no provider payment was sent.{cap?.reason ? ` ${cap.reason}` : ''}
        </p>
      )}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {notice && <p className="notice notice-success" role="status">{notice}</p>}
      <ul className="payment-list">
        {rows.map((r) => {
          const id = String(r['agent_id']);
          const po = r['payout'] as Row | null;
          const status = String(r['recipient_status']);
          const form = forms[id] ?? { email: '', consent: false };
          return (
            <li key={id}>
              <span>
                <strong>{String(r['name'])}</strong>: {String(r['amount'])} {String(r['currency'])}
                {r['recipient_masked'] ? <> · PayPal <code>{String(r['recipient_masked'])}</code></> : null}{' '}
                {status === 'verified' && <StatusBadge label="recipient verified" variant="ok" />}
                {status === 'pending' && <StatusBadge label="confirm recipient" variant="warning" />}
                {po && (
                  <StatusBadge
                    label={`payout ${String(po['status'])}${po['provider_item_status'] ? ` (${String(po['provider_item_status']).toLowerCase()})` : ''}`}
                    variant={po['status'] === 'paid' ? 'ok' : po['status'] === 'failed' || po['status'] === 'returned' ? 'error' : 'info'}
                  />
                )}
                {po && po['failure_reason'] ? <span className="card-sub"> {String(po['failure_reason'])}</span> : null}
              </span>
              <span className="help-links">
                {!live(r) && status === 'missing' && (
                  <>
                    <input
                      type="email"
                      aria-label={`PayPal email for ${String(r['name'])}`}
                      placeholder="provider@paypal-email.com"
                      value={form.email}
                      onChange={(e) => setForms({ ...forms, [id]: { ...form, email: e.target.value } })}
                    />
                    <label className="card-sub">
                      <input type="checkbox" checked={form.consent} onChange={(e) => setForms({ ...forms, [id]: { ...form, consent: e.target.checked } })} />{' '}
                      The owner agrees to receive payouts here
                    </label>
                    <button type="button" className="btn btn-secondary" disabled={busy || !form.email || !form.consent}
                      onClick={() => void run(async () => { await api.setPayoutRecipient(id, form.email, form.consent); providers.reload(); setNotice('Recipient saved. Confirm it next.'); })}>
                      Save recipient
                    </button>
                  </>
                )}
                {!live(r) && status === 'pending' && (
                  <button type="button" className="btn btn-secondary" disabled={busy}
                    onClick={() => void run(async () => {
                      if (!window.confirm(`Confirm that ${String(r['recipient_masked'])} is the right PayPal account for ${String(r['name'])}?`)) return;
                      await api.verifyPayoutRecipient(id, String(r['recipient_masked']));
                      providers.reload(); setApproval(null);
                    })}>
                    <Icon icon={ShieldCheck} /> Confirm this recipient
                  </button>
                )}
                {po && !['paid', 'failed', 'returned'].includes(String(po['status'])) && (
                  <button type="button" className="btn btn-secondary" disabled={busy}
                    onClick={() => void run(async () => { await api.refreshPayout(String(po['payout_id'])); providers.reload(); onChanged(); })}>
                    Check payout
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      {!blocked && needsSending && allVerified && !approval && (
        <div className="help-links">
          <button type="button" className="btn btn-primary" disabled={busy}
            onClick={() => void run(async () => { setApproval(await api.approvePayout(batchId)); })}>
            <Icon icon={CircleCheck} /> Review and approve payout
          </button>
          <span className="card-sub">Approving binds the exact amounts and recipients. It expires in 15 minutes and works once.</span>
        </div>
      )}
      {!blocked && approval && (
        <div className="notice notice-success" role="status">
          <p><strong>Approved payout: {approval.total} {approval.currency}</strong> (expires {new Date(approval.expires_at).toLocaleTimeString()})</p>
          <ul>
            {approval.providers.map((p) => <li key={p.recipient_masked + p.name}>{p.name}: {p.amount} {approval.currency} to <code>{p.recipient_masked}</code></li>)}
          </ul>
          <div className="help-links">
            <button type="button" className="btn btn-primary" disabled={busy}
              onClick={() => void run(async () => {
                if (!window.confirm('Send these PayPal payouts now? Money leaves the merchant PayPal account.')) return;
                const res = await api.payProviders(batchId, approval.approval_id);
                if (res.errors.length > 0) setError(res.errors.map((e) => e.message).join(' '));
                else setNotice(res.replayed ? 'Already sent. Showing the existing payouts.' : 'Sent to PayPal. A payout shows as paid only after PayPal confirms it.');
                setApproval(null); providers.reload(); onChanged();
              })}>
              <Icon icon={Banknote} /> Send payout via PayPal
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setApproval(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
};
