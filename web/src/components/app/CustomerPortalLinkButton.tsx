'use client';
import { useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';

export function CustomerPortalLinkButton({ customerId }: { customerId: string }) {
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    try {
      const result = await api<{ expiresAtUtc: string; maskedEmail: string }>(`/api/customer-portal/customers/${customerId}/link`, { method: 'POST', json: {} });
      toast.success(`Portal link queued for ${result.maskedEmail}. Expires ${new Date(result.expiresAtUtc).toLocaleDateString()}.`);
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }

  async function revoke() {
    if (!window.confirm('Revoke every active portal link for this customer? Links already emailed will stop working.')) return;
    setBusy(true);
    try {
      await api(`/api/customer-portal/customers/${customerId}/links`, { method: 'DELETE' });
      toast.success('All active portal links for this customer were revoked.');
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="ap-stack">
      <div className="ap-actions">
        <button type="button" className="ap-btn ap-btn-quiet" disabled={busy} onClick={() => void send()}>{busy ? 'Working…' : 'Send customer portal link'}</button>
        <button type="button" className="ap-btn ap-btn-quiet" disabled={busy} onClick={() => void revoke()}>Revoke portal links</button>
      </div>
    </div>
  );
}
