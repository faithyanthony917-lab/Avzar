'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { ApiError, messageFor } from '@/lib/problem';
import { portalTokenFromHash } from '@/lib/customer-portal';

type Preview = { businessName: string; channel: 'SMS' | 'WhatsApp'; maskedAddress: string; alreadyOptedOut: boolean };
type State = 'loading' | 'invalid' | 'error' | 'ready' | 'done';

const channelName = (channel: Preview['channel']) => (channel === 'SMS' ? 'text messages' : 'WhatsApp messages');

/** Public page behind the "Unsubscribe" link in customer messages. The signed token sits in the URL fragment, so it is never sent to a server until the person acts. */
export function UnsubscribeClient() {
  const [state, setState] = useState<State>('loading');
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load(value: string) {
    setState('loading'); setError('');
    try { setPreview(await api<Preview>('/api/messaging/unsubscribe/preview', { method: 'POST', json: { token: value } })); setState('ready'); }
    catch (err) {
      if (err instanceof ApiError && err.status === 404) setState('invalid');
      else { setError(messageFor(err)); setState('error'); }
    }
  }

  useEffect(() => {
    const value = portalTokenFromHash(window.location.hash);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    if (!value) { setState('invalid'); return; }
    setToken(value);
    void load(value);
  }, []);

  async function confirm() {
    if (!token || busy) return;
    setBusy(true); setError('');
    try { await api('/api/messaging/unsubscribe/confirm', { method: 'POST', json: { token } }); setState('done'); }
    catch (err) {
      if (err instanceof ApiError && err.status === 404) setState('invalid');
      else setError(messageFor(err));
    } finally { setBusy(false); }
  }

  return <main className="ap-main ap-portal-main"><section className="ap-panel ap-stack" aria-live="polite">
    {state === 'loading' && <p>Checking your link…</p>}
    {state === 'invalid' && <><h1>This link is not valid</h1><p>The unsubscribe link is missing, incomplete or no longer recognised. Use the link in your most recent message, or reply STOP to a text message to stop texts from this number.</p></>}
    {state === 'error' && <><h1>Something went wrong</h1><p className="ap-alert" role="alert">{error}</p><div><button className="ap-btn" type="button" onClick={() => token && void load(token)}>Try again</button></div></>}
    {state === 'ready' && preview && (preview.alreadyOptedOut
      ? <><h1>You are already unsubscribed</h1><p>{preview.businessName} will not send {channelName(preview.channel)} to {preview.maskedAddress}.</p></>
      : <>
        <h1>Stop messages from {preview.businessName}?</h1>
        <p>{preview.businessName} will stop sending you {channelName(preview.channel)} at {preview.maskedAddress}, including appointment reminders.</p>
        {error && <p className="ap-alert" role="alert">{error}</p>}
        <div><button className="ap-btn" type="button" disabled={busy} onClick={() => void confirm()}>{busy ? 'Stopping…' : 'Yes, stop messages'}</button></div>
        <p className="ap-foot">This only affects {preview.businessName}. It cannot be undone from this page, and the business cannot switch messages back on for you.</p>
      </>)}
    {state === 'done' && preview && <><h1>You are unsubscribed</h1><p>{preview.businessName} will not send {channelName(preview.channel)} to {preview.maskedAddress}. You can close this page.</p></>}
  </section></main>;
}
