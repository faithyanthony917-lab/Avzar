'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';

export type MessagingPreference = {
  Id: string; Channel: 'SMS' | 'WhatsApp'; Address: string; ConsentStatus: 'Unknown' | 'OptedIn' | 'OptedOut';
  ConsentSource: string | null; ConsentNote: string | null; ConsentedAtUtc: string | null; OptedOutAtUtc: string | null;
  UpdatedAtUtc: string; CustomerOptedOut: boolean;
};

const PHONE = /^\+?[1-9]\d{7,14}$/;
const STATUS_LABEL: Record<MessagingPreference['ConsentStatus'], string> = { Unknown: 'Not recorded', OptedIn: 'Opted in', OptedOut: 'Opted out' };
const when = (value: string | null) => (value ? new Date(value).toLocaleDateString() : '');

export function CustomerMessagingConsent({ customerId, canManage }: { customerId: string; canManage: boolean }) {
  const [prefs, setPrefs] = useState<MessagingPreference[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [channel, setChannel] = useState<'SMS' | 'WhatsApp'>('SMS');
  const [address, setAddress] = useState('');
  const [consent, setConsent] = useState<'OptedIn' | 'OptedOut'>('OptedIn');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    try { setPrefs(await api<MessagingPreference[]>(`/api/customers/${customerId}/messaging-preferences`)); }
    catch (err) { setLoadError(messageFor(err)); }
  }, [customerId]);

  useEffect(() => { void load(); }, [load]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setError('');
    const trimmed = address.replace(/[\s()-]/g, '');
    if (!PHONE.test(trimmed)) { setError('Use an international phone number, for example +2348012345678.'); return; }
    if (consent === 'OptedIn' && note.trim().length < 5) { setError('Write a note of at least 5 characters saying how and when the customer agreed.'); return; }
    setSaving(true);
    try {
      await api(`/api/customers/${customerId}/messaging-preferences/${channel}`, { method: 'PUT', json: { address: trimmed, consent, ...(note.trim() ? { note: note.trim() } : {}) } });
      toast.success(consent === 'OptedIn' ? 'Opt-in recorded.' : 'Opt-out recorded.');
      setNote(''); await load();
    } catch (err) { toast.error(messageFor(err)); }
    finally { setSaving(false); }
  }

  function fillForm(pref: MessagingPreference) {
    setChannel(pref.Channel); setAddress(pref.Address); setConsent(pref.ConsentStatus === 'OptedIn' ? 'OptedOut' : 'OptedIn'); setNote(''); setError('');
  }

  return <section className="ap-panel ap-stack" aria-labelledby="consent-h">
    <h2 id="consent-h" className="ap-h2">Message consent</h2>
    <p className="ap-foot">Avzar sends appointment reminders, order updates and payment receipts by SMS or WhatsApp only to numbers with a recorded opt-in. Record an opt-in only when the customer has agreed, and say how.</p>
    {loadError && <div role="alert" className="ap-alert"><p>{loadError}</p><button type="button" className="ap-btn ap-btn-quiet" onClick={() => void load()}>Retry loading consent</button></div>}
    {prefs === null && !loadError && <p className="ap-foot" aria-live="polite">Loading message consent…</p>}
    {prefs?.length === 0 && <p className="ap-hint">No message consent recorded for this customer.</p>}
    {prefs?.map((pref) => <article key={pref.Id} className="ap-panel ap-stack">
      <div className="ap-row"><strong>{pref.Channel} {pref.Address}</strong><span className="ap-badge">{STATUS_LABEL[pref.ConsentStatus]}</span></div>
      <p className="ap-foot">{pref.ConsentStatus === 'OptedIn' ? `Opted in ${when(pref.ConsentedAtUtc)}` : pref.ConsentStatus === 'OptedOut' ? `Opted out ${when(pref.OptedOutAtUtc)}` : `Updated ${when(pref.UpdatedAtUtc)}`}</p>
      {pref.ConsentNote && <p className="ap-pre">Note: {pref.ConsentNote}</p>}
      {pref.CustomerOptedOut && <p className="ap-hint">The customer opted out themselves. Only the customer can opt back in.</p>}
      {canManage && !pref.CustomerOptedOut && <div className="ap-actions"><button type="button" className="ap-btn ap-btn-quiet" onClick={() => fillForm(pref)}>{pref.ConsentStatus === 'OptedIn' ? 'Record opt-out' : 'Record opt-in'}</button></div>}
    </article>)}
    {canManage && <form className="ap-stack" onSubmit={(event) => void save(event)} noValidate>
      <h3 className="ap-h3">Record consent</h3>
      <div className="ap-field"><label htmlFor="consent-channel">Channel</label>
        <select id="consent-channel" value={channel} onChange={(event) => setChannel(event.target.value as 'SMS' | 'WhatsApp')} disabled={saving}><option value="SMS">SMS</option><option value="WhatsApp">WhatsApp</option></select></div>
      <div className="ap-field"><label htmlFor="consent-address">Phone number</label>
        <input id="consent-address" type="tel" inputMode="tel" autoComplete="off" placeholder="+2348012345678" value={address} onChange={(event) => setAddress(event.target.value)} disabled={saving} /></div>
      <div className="ap-field"><label htmlFor="consent-status">Consent</label>
        <select id="consent-status" value={consent} onChange={(event) => setConsent(event.target.value as 'OptedIn' | 'OptedOut')} disabled={saving}><option value="OptedIn">Opted in</option><option value="OptedOut">Opted out</option></select></div>
      <label className="ap-stack" htmlFor="consent-note"><span>{consent === 'OptedIn' ? 'Note (required): how and when the customer agreed' : 'Note (optional)'}</span>
        <textarea id="consent-note" className="ap-input" rows={2} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} disabled={saving} /></label>
      {error && <p role="alert" className="ap-alert">{error}</p>}
      <button type="submit" className="ap-btn" disabled={saving}>{saving ? 'Saving…' : 'Save consent'}</button>
    </form>}
  </section>;
}
