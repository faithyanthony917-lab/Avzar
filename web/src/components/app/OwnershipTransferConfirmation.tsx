'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';

export function OwnershipTransferConfirmation({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const validShape = /^[a-f0-9]{64}$/i.test(token);

  async function confirm() {
    if (!validShape || busy) return;
    setBusy(true); setError('');
    try {
      await api('/api/business/ownership-transfer/confirm', { method: 'POST', json: { token } });
      setConfirmed(true);
      router.refresh();
    } catch (err) { setError(messageFor(err)); }
    finally { setBusy(false); }
  }

  return <section className="ap-panel ap-stack" aria-labelledby="ownership-confirm-heading">
    <h1 id="ownership-confirm-heading">Confirm business ownership transfer</h1>
    {confirmed ? <><p role="status" className="ap-ok">Ownership transfer completed. Your previous owner access has changed.</p><Link href="/dashboard">Continue to dashboard</Link></>
      : !validShape ? <><p role="alert" className="ap-alert">This confirmation link is missing or malformed. Request a new transfer confirmation from Team settings.</p><Link href="/staff">Return to Team</Link></>
      : <><p>Only continue if you requested to transfer this business. Confirming will make the selected active staff member the owner and remove your owner privileges.</p>{error && <p role="alert" className="ap-alert">{error}</p>}<div className="ap-actions"><button type="button" className="ap-btn ap-btn-danger" disabled={busy} onClick={() => void confirm()}>{busy ? 'Confirming…' : 'Confirm transfer'}</button><Link className="ap-btn ap-btn-quiet" href="/staff">Cancel</Link></div></>}
  </section>;
}
