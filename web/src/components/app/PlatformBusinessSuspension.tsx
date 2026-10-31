'use client';

import { useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';

export const SUSPEND_REASON_MIN = 3;
export const SUSPEND_REASON_MAX = 200;

/** Step 17c: suspend or reactivate one business. The reason is required, is kept with the business and goes into the platform audit log. */
export function PlatformBusinessSuspension({ businessId, businessName, isActive, suspendedReason, isOwnBusiness, onChanged = () => window.location.reload() }: {
  businessId: string; businessName: string; isActive: boolean; suspendedReason: string | null; isOwnBusiness: boolean; onChanged?: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const trimmed = reason.trim();
  const valid = trimmed.length >= SUSPEND_REASON_MIN && trimmed.length <= SUSPEND_REASON_MAX;

  async function run(path: 'suspend' | 'reactivate', json: Record<string, string>, done: string) {
    setBusy(true); setError('');
    try {
      await api(`/api/platform-admin/businesses/${encodeURIComponent(businessId)}/${path}`, { method: 'POST', json });
      toast.success(done);
      onChanged();
    } catch (e) {
      setError(messageFor(e));
      setBusy(false);
    }
  }

  if (!isActive) {
    return (
      <section className="ap-panel ap-stack" aria-labelledby="suspension-heading">
        <h2 className="ap-h2" id="suspension-heading">Suspended</h2>
        <p style={{ margin: 0 }}>Staff cannot sign in and the public pages are off. Nothing has been deleted.</p>
        {suspendedReason && <p style={{ margin: 0 }}>Reason: {suspendedReason}</p>}
        {error && <p className="ap-alert" role="alert">{error}</p>}
        <div><button type="button" className="ap-btn" disabled={busy} onClick={() => { if (window.confirm(`Reactivate ${businessName}?`)) void run('reactivate', {}, 'The business was reactivated.'); }}>{busy ? 'Working…' : 'Reactivate this business'}</button></div>
      </section>
    );
  }

  return (
    <section className="ap-panel ap-stack" aria-labelledby="suspension-heading">
      <h2 className="ap-h2" id="suspension-heading">Suspend this business</h2>
      {isOwnBusiness ? (
        <p className="ap-foot" style={{ margin: 0 }}>This is the business you are signed in to, so it cannot be suspended from here.</p>
      ) : (
        <>
          <p className="ap-foot" style={{ margin: 0 }}>Its staff are signed out at once, nobody can sign in, and its storefront and customer links stop working. Nothing is deleted. Payments already made are still recorded.</p>
          <label className="ap-filter">Reason (kept with the business and in the audit log)
            <textarea className="ap-input" rows={2} maxLength={SUSPEND_REASON_MAX} value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          {error && <p className="ap-alert" role="alert">{error}</p>}
          <div><button type="button" className="ap-btn" disabled={busy || !valid} onClick={() => { if (window.confirm(`Suspend ${businessName}?`)) void run('suspend', { reason: trimmed }, 'The business was suspended.'); }}>{busy ? 'Working…' : 'Suspend this business'}</button></div>
        </>
      )}
    </section>
  );
}
