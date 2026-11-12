import React, { useEffect, useState } from 'react';
import { CircleCheck, CircleX, CreditCard, ExternalLink, Landmark } from 'lucide-react';
import { GridPanel } from '../components/GridPanel.js';
import { ChartPanel } from '../components/ChartPanel.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { ProviderPayouts } from '../components/ProviderPayouts.js';
import { TreasuryPlanner } from '../components/TreasuryPlanner.js';
import { Card, EmptyState, Icon, Loading } from '../components/ui.js';
import type { ColDef } from 'ag-grid-community';
import { useFetch } from '../hooks.js';
import { api } from '../api.js';

const BATCH_COLS: ColDef[] = [
  { field: 'id', headerName: 'Batch ID', width: 90, valueFormatter: ({ value }) => value?.substring(0, 8) + '…' },
  { field: 'total_amount', headerName: 'Total', width: 130,
    valueFormatter: ({ value, data }) =>
      value ? `${Number(value).toFixed(6)} ${(data as Record<string, string>)['currency'] ?? 'USD'}` : '',
    cellStyle: { color: 'var(--color-success)' }},
  { field: 'currency', headerName: 'Currency', width: 80 },
  { field: 'status', headerName: 'Status', flex: 1,
    cellRenderer: ({ value }: { value: string }) => {
      const variant = value === 'confirmed' ? 'ok' : value === 'rejected' || value === 'failed' ? 'error'
        : value === 'reconciliation_required' ? 'warning'
        : value === 'approved' ? 'live' : 'info';
      // Show honest payment status — never say "reconciled" unless it is
      const display = value === 'submitted' ? 'capture_pending' : value;
      return <StatusBadge label={display} variant={variant} />;
    }},
  { field: 'approved_by', headerName: 'Approved By', flex: 1,
    valueFormatter: ({ value }) => (value ? `…` : 'n/a') },
  { field: 'created_at', headerName: 'Created', flex: 1,
    valueFormatter: ({ value }) => value ? new Date(value).toLocaleDateString() : '' },
];

const AWAITING_APPROVAL = ['proposed', 'approval_required'];

export const SettlementWorkspace: React.FC = () => {
  const batches = useFetch(() => api.settlementBatches());
  const reconciliation = useFetch(() => api.reconciliation());
  const captureChart = useFetch(() => api.aggregates.captureReconciliation());
  const [selected, setSelected] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const batchDetail = useFetch(
    () => (selected ? api.settlementBatch(selected) : Promise.resolve(null)),
    [selected],
  );

  const payment = useFetch(
    () => (selected ? api.batchPayment(selected) : Promise.resolve(null)),
    [selected],
  );
  const pay = payment.status === 'ok' && payment.data ? payment.data.payment : null;
  const rows = batches.status === 'ok' ? batches.data.batches : [];

  // PayPal sends the buyer back here (?paypal=return&paypal_order=...). Say so, and if exactly one
  // batch is waiting for payment, open it so the next step is one click away.
  const [returned, setReturned] = useState<'return' | 'cancel' | 'captured' | null>(null);
  const [captureError, setCaptureError] = useState('');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const outcome = q.get('paypal');
    if (outcome !== 'return' && outcome !== 'cancel' && outcome !== 'captured') return;
    setReturned(outcome);
    setCaptureError(q.get('paypal_error') ?? '');
    setTimeout(() => { batches.reload(); }, 0);
    const clean = window.location.pathname + window.location.hash;
    window.history.replaceState(null, '', clean);
  }, []);
  useEffect(() => {
    if (!returned || selected || batches.status !== 'ok') return;
    const waiting = batches.data.batches.filter((b: Record<string, unknown>) => b['status'] === 'payment_pending');
    if (waiting.length === 1) setSelected(String(waiting[0]['id']));
  }, [returned, selected, batches]);

  async function startPayment() {
    if (!selected) return;
    setActing(true); setActionError(''); setActionNotice('');
    try {
      const order = await api.createPayPalOrder(selected);
      setActionNotice('PayPal order created. Open PayPal, approve the payment as the buyer, then come back and capture it.');
      window.open(order.approve_url, '_blank', 'noopener,noreferrer');
      batches.reload(); batchDetail.reload(); payment.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not create the PayPal order.');
    } finally { setActing(false); }
  }

  async function releaseFunded() {
    if (!selected) return;
    if (!window.confirm('Release the money the buyer already paid for this work? No second charge is made. Paying the provider is a separate step after this.')) return;
    setActing(true); setActionError(''); setActionNotice('');
    try {
      const res = await api.releaseFundedBatch(selected);
      setActionNotice(`Released ${res.released} ${res.currency}. ${res.note}`);
      batches.reload(); batchDetail.reload(); payment.reload(); reconciliation.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not release the funds.');
    } finally { setActing(false); }
  }

  async function capturePayment() {
    if (!selected || !pay) return;
    if (!window.confirm('Capture this PayPal payment now? Funds move from the buyer to the merchant account and cannot be undone here.')) return;
    setActing(true); setActionError(''); setActionNotice('');
    try {
      const res = await api.capturePayPalOrder(selected, String(pay['order_id']));
      setActionNotice(`Payment captured (${res.amount} ${res.currency}). Status: ${res.status.replace(/_/g, ' ')}.`);
      batches.reload(); batchDetail.reload(); payment.reload(); reconciliation.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not capture the payment.');
    } finally { setActing(false); }
  }

  async function decide(kind: 'approve' | 'reject') {
    if (!selected || batchDetail.status !== 'ok' || !batchDetail.data) return;
    const total = `${Number(batchDetail.data.total_amount).toFixed(6)} ${batchDetail.data.currency}`;
    const question = kind === 'approve'
      ? `Approve this batch for ${total}? This authorises creating a payment order. An approval cannot be undone.`
      : `Reject this batch of ${total}? Its obligations return to payable and can be batched again.`;
    if (!window.confirm(question)) return;
    setActing(true);
    setActionError('');
    setActionNotice('');
    try {
      if (kind === 'approve') await api.approveBatch(selected, 'Approved in the operator console');
      else await api.rejectBatch(selected, 'Rejected in the operator console');
      setActionNotice(kind === 'approve' ? 'Batch approved. A payment order can now be created.' : 'Batch rejected. Its obligations are payable again.');
      batches.reload();
      batchDetail.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The action could not be completed.');
    } finally {
      setActing(false);
    }
  }

  const detail = batchDetail.status === 'ok' ? batchDetail.data : null;
  const record = selected && reconciliation.status === 'ok'
    ? reconciliation.data.records.find((r: Record<string, unknown>) => r['batch_id'] === selected)
    : undefined;

  return (
    <>
      <div className="card-grid card-grid--wide">
        <ChartPanel
          title="Capture and reconciliation outcomes"
          data={captureChart.status === 'ok' ? captureChart.data.data : []}
          loading={captureChart.status === 'loading'}
          error={captureChart.status === 'error' ? captureChart.error : undefined}
          series={[{ type: 'pie', angleKey: 'count', calloutLabelKey: 'verdict', legendItemKey: 'verdict' }]}
        />
        <Card title="How settlement works" icon={Landmark}>
          <ol className="getting-started">
            <li><span>The treasury agent (a real model) or an operator <strong>proposes a batch</strong> of payable obligations and the PayPal route for it.</span></li>
            <li><span>A signed-in human <strong>approves</strong> it. Agents can never approve.</span></li>
            <li><span>The payment is created and captured, then <strong>reconciled</strong> against the batch total.</span></li>
          </ol>
          <p className="card-sub">Capture moves the buyer's payment to the merchant account. It does not pay providers out.</p>
        </Card>
      </div>

      <TreasuryPlanner onPlanned={() => batches.reload()} />

      {returned === 'captured' && <p className="notice notice-success" role="status">Payment approved and captured. The batch status below is updated.</p>}
      {returned === 'return' && <p className="notice notice-success" role="status">Back from PayPal.{captureError ? ` Automatic capture did not finish (${captureError}). ` : ' '}Select the batch below and press "Capture payment" to finish.</p>}
      {returned === 'cancel' && <p className="notice notice-error" role="status">PayPal checkout was cancelled. No money moved. You can open the approval link again from the batch.</p>}
      <GridPanel
        title="Settlement batches"
        rows={rows}
        cols={BATCH_COLS}
        loading={batches.status === 'loading'}
        error={batches.status === 'error' ? batches.error : undefined}
        onRowClick={(row) => { setSelected((row as { id: string }).id); setActionError(''); setActionNotice(''); }}
        getRowId={(p) => (p.data as { id: string }).id}
      />

      {selected && (
        <Card
          title="Batch detail"
          description="Select another row to switch batches."
          actions={<button type="button" className="small-button" onClick={() => setSelected(null)} aria-label="Close batch detail">Close</button>}
        >
          {batchDetail.status === 'loading' && <Loading label="Loading batch…" />}
          {batchDetail.status === 'error' && <p className="notice notice-error" role="alert">{batchDetail.error}</p>}
          {actionError && <p className="notice notice-error" role="alert">{actionError}</p>}
          {actionNotice && <p className="notice notice-success" role="status">{actionNotice}</p>}
          {detail && (
            <>
              <p>
                <StatusBadge label={detail.status === 'submitted' ? 'capture pending' : detail.status} variant={detail.status === 'confirmed' ? 'ok' : detail.status === 'rejected' ? 'error' : 'info'} />{' '}
                <strong>{Number(detail.total_amount).toFixed(6)} {detail.currency}</strong>
              </p>
              {(detail.items ?? []).length === 0 ? (
                <EmptyState title="No items">This batch has no obligations.</EmptyState>
              ) : (
                <ul>
                  {(detail.items ?? []).map((item: Record<string, unknown>) => (
                    <li key={String(item['id'])}>
                      Obligation {String(item['obligation_id']).substring(0, 12)}…: <strong>{Number(item['amount']).toFixed(6)} {String(detail.currency)}</strong>
                    </li>
                  ))}
                </ul>
              )}
              {AWAITING_APPROVAL.includes(detail.status) && (
                <div className="help-links" style={{ marginTop: 'var(--space-4)' }}>
                  <button type="button" className="btn btn-primary" disabled={acting} onClick={() => void decide('approve')}>
                    <Icon icon={CircleCheck} /> Approve batch
                  </button>
                  <button type="button" className="btn btn-secondary" disabled={acting} onClick={() => void decide('reject')}>
                    <Icon icon={CircleX} /> Reject batch
                  </button>
                </div>
              )}
              {detail.status === 'approved' && (
                <div className="help-links" style={{ marginTop: 'var(--space-4)' }}>
                  <button type="button" className="btn btn-primary" disabled={acting} onClick={() => void releaseFunded()}>
                    <Icon icon={CircleCheck} /> Release funded payment
                  </button>
                  <button type="button" className="btn btn-secondary" disabled={acting} onClick={() => void startPayment()}>
                    <Icon icon={CreditCard} /> Pay with PayPal instead
                  </button>
                  <p className="card-sub">If the buyer already paid when accepting the quote, release it. Charging again is refused by the server.</p>
                </div>
              )}
              {detail.status === 'payment_pending' && pay && String(pay['status']) === 'order_created' && (
                <div style={{ marginTop: 'var(--space-4)' }}>
                  <p className="card-sub">PayPal order {String(pay['order_id'])} ({String(pay['environment'] ?? 'sandbox')}). The buyer must approve it at PayPal before it can be captured.</p>
                  <div className="help-links">
                    {typeof pay['approve_url'] === 'string' && (
                      <a className="btn btn-secondary" href={String(pay['approve_url'])} target="_blank" rel="noopener noreferrer">
                        <Icon icon={ExternalLink} /> Open PayPal to approve
                      </a>
                    )}
                    <button type="button" className="btn btn-primary" disabled={acting} onClick={() => void capturePayment()}>
                      <Icon icon={CreditCard} /> Capture payment
                    </button>
                  </div>
                </div>
              )}
              <ProviderPayouts batchId={detail.id} batchStatus={detail.status} onChanged={() => { batches.reload(); batchDetail.reload(); reconciliation.reload(); }} />
              {record ? (
                <p style={{ marginTop: 'var(--space-4)' }}>
                  <StatusBadge label={`reconciliation: ${String(record['verdict'])}`} variant={record['verdict'] === 'matched' ? 'ok' : record['verdict'] === 'mismatch' ? 'error' : 'warning'} />{' '}
                  expected {Number(record['expected_amount']).toFixed(6)} {String(record['expected_currency'])}, received {Number(record['actual_amount']).toFixed(6)} {String(record['actual_currency'])}
                </p>
              ) : (
                <p className="card-sub" style={{ marginTop: 'var(--space-4)' }}>No reconciliation record yet. Payment status is pending or unknown.</p>
              )}
            </>
          )}
        </Card>
      )}
    </>
  );
};
