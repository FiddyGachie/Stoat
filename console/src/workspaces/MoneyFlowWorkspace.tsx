import React, { useState } from 'react';
import { ArrowRight, FileCheck2, Handshake, Landmark, PackageCheck, Receipt, WalletCards } from 'lucide-react';
import type { ColDef } from 'ag-grid-community';
import { GridPanel } from '../components/GridPanel.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { Card, EmptyState, Icon } from '../components/ui.js';
import { useFetch } from '../hooks.js';
import { api } from '../api.js';

type Row = Record<string, any>;
type Variant = 'live' | 'replayed' | 'seeded' | 'mocked' | 'ok' | 'error' | 'warning' | 'info';

/** One plain-language state per agreement, in the order money actually moves. Never green unless PayPal said so. */
function stage(r: Row, payoutsEnabled: boolean): { label: string; variant: Variant } {
  if (r.provider_paid) return { label: 'provider paid (PayPal confirmed)', variant: 'ok' };
  const d = r.disbursement;
  if (d?.status === 'failed' || d?.status === 'returned') return { label: `payout ${d.status}: provider unpaid`, variant: 'error' };
  if (d?.status === 'processing' || d?.status === 'requested') return { label: `payout submitted (${String(d.item_status ?? 'pending').toLowerCase()})`, variant: 'info' };
  if (r.collection?.status === 'mismatch') return { label: 'buyer paid a different amount: reconciliation required', variant: 'error' };
  if (r.collection?.status === 'captured') return { label: payoutsEnabled ? 'buyer captured: provider unpaid' : 'buyer captured: provider payout unavailable', variant: 'warning' };
  if (r.collection?.status === 'awaiting_payment') return { label: 'waiting for buyer approval at PayPal', variant: 'info' };
  if (r.obligation?.status === 'payable') return { label: 'verified: payable, buyer not yet captured', variant: 'info' };
  if (r.delivery?.verdict === 'rejected') return { label: 'delivery rejected: nothing owed', variant: 'warning' };
  return { label: 'agreed', variant: 'info' };
}

const short = (v?: string | null) => (v ? `${v.slice(0, 8)}…` : '');

export const MoneyFlowWorkspace: React.FC = () => {
  const flow = useFetch(() => api.moneyFlow());
  const [selected, setSelected] = useState<string | null>(null);
  const payoutsEnabled = flow.status === 'ok' && flow.data.payouts_capability.enabled;
  const rows: Row[] = flow.status === 'ok' ? flow.data.flows : [];
  const sel = rows.find((r) => r.agreement_id === selected) ?? null;

  const cols: ColDef[] = [
    { field: 'agreement_id', headerName: 'Agreement', width: 120, valueFormatter: ({ value }) => short(value) },
    { field: 'provider_name', headerName: 'Provider', flex: 1, minWidth: 140 },
    { field: 'amount', headerName: 'Agreed', width: 110, valueFormatter: ({ value, data }) => `${value} ${data?.currency ?? ''}` },
    { headerName: 'Buyer collection (PayPal Orders)', flex: 1, minWidth: 190, valueGetter: ({ data }) => data?.collection?.status ?? 'not started',
      cellRenderer: ({ value }: { value: string }) => <StatusBadge label={value.replace(/_/g, ' ')} variant={value === 'captured' ? 'ok' : value === 'mismatch' || value === 'failed' ? 'error' : value === 'not started' ? 'mocked' : 'info'} /> },
    { headerName: 'Provider payout (PayPal Payouts)', flex: 1, minWidth: 200, valueGetter: ({ data }) => data?.disbursement?.status ?? 'not sent',
      cellRenderer: ({ value }: { value: string }) => <StatusBadge label={value.replace(/_/g, ' ')} variant={value === 'paid' ? 'ok' : value === 'failed' || value === 'returned' ? 'error' : value === 'not sent' ? 'mocked' : 'info'} /> },
    { headerName: 'State', flex: 2, minWidth: 260, valueGetter: ({ data }) => stage(data as Row, payoutsEnabled).label,
      cellRenderer: ({ data }: { data: Row }) => { const s = stage(data, payoutsEnabled); return <StatusBadge label={s.label} variant={s.variant} />; } },
  ];

  return (
    <>
      <p className="card-sub">
        Two separate PayPal transactions per deal: the buyer pays Stoat, then Stoat pays the provider. Each can succeed or fail on its own, and
        neither implies the other. The ledger is a record, not money.
      </p>
      {flow.status === 'ok' && !payoutsEnabled && (
        <p className="notice notice-error" role="status">
          Provider payout unavailable: no provider payment was sent.{flow.data.payouts_capability.reason ? ` ${flow.data.payouts_capability.reason}` : ''}
        </p>
      )}
      <GridPanel
        title="Agreements and their two PayPal legs"
        rows={rows}
        cols={cols}
        loading={flow.status === 'loading'}
        error={flow.status === 'error' ? flow.error : undefined}
        onRowClick={(row) => setSelected((row as Row).agreement_id)}
        getRowId={(p) => (p.data as Row).agreement_id}
      />
      {!sel ? (
        <Card title="Select an agreement" icon={WalletCards}>
          <EmptyState title="Pick a row">Choose an agreement to see the evidence chain from deal to payout.</EmptyState>
        </Card>
      ) : (
        <div className="card-grid card-grid--wide">
          <Card title="Evidence chain" icon={FileCheck2}>
            <ol className="getting-started">
              <li><span><Icon icon={Handshake} /> <strong>Agreement</strong> {short(sel.agreement_id)} · {sel.amount} {sel.currency} · {sel.negotiated ? 'negotiated by the buyer agent' : 'listed price'} · {sel.agreement_status}</span></li>
              <li><span><Icon icon={PackageCheck} /> <strong>Delivery</strong> {sel.delivery ? <>{sel.delivery.status}, verifier says <strong>{sel.delivery.verdict ?? 'n/a'}</strong>{sel.delivery.artifact_hash ? <>, artifact <code>{String(sel.delivery.artifact_hash).slice(0, 12)}…</code></> : null}</> : 'not delivered yet'}</span></li>
              <li><span><Icon icon={Receipt} /> <strong>Obligation</strong> {sel.obligation ? `${sel.obligation.amount} ${sel.currency}, ${String(sel.obligation.status).replace(/_/g, ' ')}` : 'none yet (needs verified work)'}</span></li>
              <li><span><Icon icon={Landmark} /> <strong>Ledger</strong> posted only from PayPal-confirmed events (see Integrity)</span></li>
            </ol>
          </Card>
          <Card title="Leg 1: buyer pays Stoat" icon={ArrowRight} description="PayPal Orders v2">
            {sel.collection ? (
              <dl className="kv">
                <dt>Status</dt><dd><StatusBadge label={String(sel.collection.status).replace(/_/g, ' ')} variant={sel.collection.status === 'captured' ? 'ok' : sel.collection.status === 'mismatch' ? 'error' : 'info'} /></dd>
                <dt>PayPal order</dt><dd><code>{sel.collection.paypal_order_id}</code></dd>
                <dt>PayPal capture</dt><dd>{sel.collection.paypal_capture_id ? <code>{sel.collection.paypal_capture_id}</code> : 'not captured'}</dd>
                <dt>Amount</dt><dd>{sel.collection.amount} {sel.collection.currency}{sel.collection.captured_amount ? ` (PayPal captured ${sel.collection.captured_amount})` : ''}</dd>
                <dt>Reconciliation</dt><dd>{sel.collection.reconciliation}</dd>
                <dt>Environment</dt><dd>{sel.collection.environment ?? 'n/a'}</dd>
              </dl>
            ) : <p className="card-sub">No PayPal order yet. Money has not moved.</p>}
          </Card>
          <Card title="Leg 2: Stoat pays the provider" icon={ArrowRight} description="PayPal Payouts API">
            {sel.disbursement ? (
              <dl className="kv">
                <dt>Status</dt><dd><StatusBadge label={String(sel.disbursement.status)} variant={sel.disbursement.status === 'paid' ? 'ok' : sel.disbursement.status === 'failed' || sel.disbursement.status === 'returned' ? 'error' : 'info'} /></dd>
                <dt>PayPal payout batch</dt><dd><code>{sel.disbursement.paypal_payout_batch_id ?? 'not confirmed yet'}</code></dd>
                <dt>PayPal payout item</dt><dd><code>{sel.disbursement.paypal_payout_item_id ?? 'n/a'}</code> {sel.disbursement.item_status ? `(${String(sel.disbursement.item_status).toLowerCase()})` : ''}</dd>
                <dt>Recipient</dt><dd><code>{sel.disbursement.recipient_masked ?? 'n/a'}</code></dd>
                <dt>Amount</dt><dd>{sel.disbursement.amount} {sel.disbursement.currency}</dd>
                <dt>Sender IDs</dt><dd><code>{short(sel.disbursement.sender_batch_id)}</code> / <code>{short(sel.disbursement.sender_item_id)}</code></dd>
                {sel.disbursement.failure_reason && (<><dt>Exception</dt><dd>{sel.disbursement.failure_reason}</dd></>)}
              </dl>
            ) : (
              <p className="card-sub">
                {payoutsEnabled
                  ? 'No payout sent yet. The provider is unpaid until a person approves and sends it from Settlement.'
                  : 'Provider payout unavailable: no provider payment was sent.'}
              </p>
            )}
          </Card>
        </div>
      )}
    </>
  );
};
