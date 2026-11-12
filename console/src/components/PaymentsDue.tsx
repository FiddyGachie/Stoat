import React, { useEffect, useState } from 'react';
import { CreditCard, RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { useFetch } from '../hooks.js';
import { Card, Icon } from './ui.js';

const OUTCOMES: Record<string, { tone: 'success' | 'error'; text: string }> = {
  captured: { tone: 'success', text: 'Payment received. The agreement is funded and the provider can start work.' },
  pending: { tone: 'success', text: 'Thanks. PayPal is still confirming your payment. This page updates on its own.' },
  not_approved: { tone: 'error', text: 'PayPal did not receive your approval yet. Use "Pay with PayPal" below to finish.' },
  cancelled: { tone: 'error', text: 'Payment was cancelled. Nothing was charged. You can pay any time from the list below.' },
  mismatch: { tone: 'error', text: 'PayPal captured a different amount than the agreement price. Nothing was released. Ask an operator to refund and try again.' },
};

/**
 * Payments waiting for the signed-in person. Appears right after a quote is accepted and stays
 * until PayPal confirms the money. It re-checks every 10 seconds, so a payment finished in the
 * PayPal app shows up here without any button press.
 */
export const PaymentsDue: React.FC = () => {
  const due = useFetch(() => api.paymentsDue());
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<string | null>(null);

  // PayPal sends the buyer back with ?funding=captured|pending|not_approved|cancelled|mismatch.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const f = q.get('funding');
    if (!f) return;
    setOutcome(f);
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  }, []);

  const hasDue = due.status === 'ok' && due.data.payments.length > 0;
  useEffect(() => {
    if (!hasDue && !outcome) return;
    const t = window.setInterval(() => due.reload(), 10_000);
    return () => window.clearInterval(t);
  }, [hasDue, outcome, due]);

  async function check(paymentId: string) {
    setBusy(paymentId); setError('');
    try {
      await api.refreshPayment(paymentId);
      due.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check the payment.');
    } finally { setBusy(''); }
  }

  const note = outcome ? OUTCOMES[outcome] : null;
  const payments = due.status === 'ok' ? due.data.payments : [];
  if (!note && payments.length === 0 && !error) return null;

  return (
    <section aria-label="Payments waiting for you" className="payments-due">
      {note && <p className={`notice notice-${note.tone}`} role="status">{note.text}</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {payments.length > 0 && (
        <Card title="Payment needed" icon={CreditCard} description="Approve each payment in PayPal. On a phone with the PayPal app, it opens there.">
          <ul className="payment-list">
            {payments.map((p) => (
              <li key={String(p['payment_id'])}>
                <span>
                  <strong>{String(p['amount'])} {String(p['currency'])}</strong>
                  {' '}for agreement {String(p['agreement_id']).substring(0, 8)}…
                  {p['environment'] === 'sandbox' ? ' (PayPal Sandbox: test money)' : ''}
                </span>
                <span className="help-links">
                  {typeof p['approve_url'] === 'string' && (
                    <a className="btn btn-primary" href={String(p['approve_url'])}>
                      <Icon icon={CreditCard} /> Pay with PayPal
                    </a>
                  )}
                  <button type="button" className="btn btn-secondary" disabled={busy === String(p['payment_id'])} onClick={() => void check(String(p['payment_id']))}>
                    <Icon icon={RefreshCw} /> I have paid, check now
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
};
