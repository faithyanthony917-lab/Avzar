'use client';

import type { AmendmentImpact } from '@/lib/order-types';
import { amendmentSummary } from '@/lib/orders';

/** Shown after a preview and before an amendment is saved. The server worked out every line from the real rules. */
export function AmendmentImpactPanel({ orderNumber, currency, impact, busy, error, canReplan, onConfirm, onBack }: {
  orderNumber: string;
  currency: string;
  impact: AmendmentImpact;
  busy: boolean;
  error: string | null;
  canReplan: boolean;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const lines = amendmentSummary(impact, currency);
  return (
    <section className="ap-panel ap-stack" aria-labelledby="amend-impact-title" aria-busy={busy}>
      <h2 id="amend-impact-title" className="ap-h2">Review the changes to {orderNumber}</h2>
      <p className="ap-hint">Nothing is saved yet.</p>
      {error && <p role="alert" className="ap-alert">{error}</p>}
      <ul aria-label="What will change">
        {lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
      {impact.scheduleReplanRequired && (
        <p className="ap-hint">
          {canReplan
            ? 'After you confirm, you will go to the planner to preview and publish a new schedule.'
            : 'After you confirm, someone who can manage tasks must preview and publish a new schedule.'}
        </p>
      )}
      <div className="ap-row" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="ap-btn" onClick={onConfirm} disabled={busy}>{busy ? 'Saving…' : 'Confirm amendment'}</button>
        <button type="button" className="ap-btn ap-btn-quiet" onClick={onBack} disabled={busy}>Keep editing</button>
      </div>
    </section>
  );
}
