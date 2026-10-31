'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { formatDateTime } from '@/lib/dates';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import { quotationHeadline, sendLabel, type QuotationStatus } from '@/lib/quotation';

/** Staff view of the quotation on an order: where it stands, and sending it to the customer. Conversion to an order is the existing "Confirm order" action. */
export function QuotationPanel({ orderId, orderStatus, canManage, timeZoneId }: { orderId: string; orderStatus: string; canManage: boolean; timeZoneId: string }) {
  const [status, setStatus] = useState<QuotationStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try { setStatus(await api<QuotationStatus>(`/api/orders/${orderId}/quotation`)); }
    catch (e) { setLoadError(messageFor(e)); }
  }, [orderId]);

  // Reload when the order's own status changes (for example after "Confirm order"), so the panel never shows a stale state.
  useEffect(() => { void load(); }, [load, orderStatus]);

  async function send() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api<{ maskedEmail: string }>(`/api/orders/${orderId}/quotation/send`, { method: 'POST', json: {} });
      toast.success(`Quotation sent to ${result.maskedEmail}. The customer can review and answer it from a secure link.`);
      await load();
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }

  return (
    <section className="ap-panel ap-stack" aria-labelledby="quotation-heading">
      <h2 id="quotation-heading" className="ap-h2">Customer quotation</h2>
      {loadError && (
        <div className="ap-row" style={{ justifyContent: 'flex-start' }}>
          <p role="alert" className="ap-alert">Could not load the quotation status. {loadError}</p>
          <button type="button" className="ap-btn ap-btn-quiet" onClick={() => void load()}>Try again</button>
        </div>
      )}
      {!loadError && !status && <p className="ap-foot" aria-live="polite">Loading quotation status…</p>}
      {status && (
        <>
          <p>{quotationHeadline(status)}</p>
          <dl className="ap-dl">
            {status.sentAtUtc && <><dt>Last sent</dt><dd>{formatDateTime(status.sentAtUtc, timeZoneId)}{status.sendCount > 1 ? ` (${status.sendCount} times)` : ''}</dd></>}
            {status.decidedAtUtc && <><dt>Answered</dt><dd>{formatDateTime(status.decidedAtUtc, timeZoneId)}</dd></>}
            {status.customerNote && <><dt>Customer message</dt><dd className="ap-pre">{status.customerNote}</dd></>}
          </dl>
          {status.readyToConfirm && <p className="ap-hint">Use “Confirm order” above to convert this approved quotation into an order and create its production tasks.</p>}
          {canManage && status.canSend && (
            <div>
              <button type="button" className="ap-btn" onClick={() => void send()} disabled={busy}>{busy ? 'Sending…' : sendLabel(status)}</button>
              <p className="ap-foot">Emails the customer a link that expires in 7 days. The email shows the order number and total only.</p>
            </div>
          )}
          {!canManage && status.canSend && <p className="ap-foot">You can view this quotation but not send it.</p>}
        </>
      )}
    </section>
  );
}
