'use client';

import { useEffect, useState } from 'react';
import { CONSENT_CHANGED_EVENT, consentRequest, storedChoiceFrom, type ConsentReply } from '@/lib/storefront-analytics';
import {
  createStorefrontConsent,
  isStorefrontConsentExpired,
  parseStorefrontConsent,
  storefrontConsentKey,
} from '@/lib/storefront-consent';

async function sendDecision(siteSlug: string, analytics: boolean): Promise<ConsentReply> {
  // Include the existing grant only when withdrawing/rejecting, so the API can revoke it server-side.
  let priorToken: string | undefined;
  if (!analytics) {
    try {
      const raw = window.localStorage.getItem(storefrontConsentKey(siteSlug));
      priorToken = parseStorefrontConsent(raw)?.token;
    } catch { /* local refusal still works when browser storage is unavailable */ }
  }
  const request = consentRequest(siteSlug, analytics, priorToken);
  const response = await fetch(request.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request.body),
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`consent ${response.status}`);
  return (await response.json()) as ConsentReply;
}

export default function StorefrontPrivacyChoices({ siteSlug, analyticsEnabled = false }: { siteSlug: string; analyticsEnabled?: boolean }) {
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(false);
  const [customising, setCustomising] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    let saved = null;
    try {
      saved = parseStorefrontConsent(window.localStorage.getItem(storefrontConsentKey(siteSlug)));
    } catch {
      // Storage can be unavailable in restricted browser contexts. Keep the privacy prompt available.
    }
    const current = saved && !isStorefrontConsentExpired(saved) ? saved : null;
    if (current) setAnalytics(current.analytics);
    // Nothing optional is collected unless the business turned analytics on, so there is nothing to ask until then.
    else if (analyticsEnabled) setVisible(true);
    setReady(true);
  }, [siteSlug, analyticsEnabled]);

  function openChoices() {
    setError('');
    setStatus('');
    setCustomising(true);
    setVisible(true);
  }

  async function saveChoice(allowAnalytics: boolean) {
    if (busy) return;
    setBusy(true);
    setError('');
    let reply: ConsentReply | null = null;
    let serverDecisionSaved = true;
    try {
      reply = await sendDecision(siteSlug, allowAnalytics);
    } catch {
      // Do not enable tracking without server confirmation. A refusal is applied locally even offline, but server-side revocation needs connectivity.
      serverDecisionSaved = false;
      if (allowAnalytics) {
        setBusy(false);
        setError('We could not save your choice. Check your connection and try again.');
        return;
      }
    }
    const stored = storedChoiceFrom(allowAnalytics, reply);
    try {
      window.localStorage.setItem(storefrontConsentKey(siteSlug), JSON.stringify(createStorefrontConsent(stored.analytics, new Date(), stored.token)));
    } catch {
      // Do not block the visitor from continuing if browser storage is unavailable.
    }
    window.dispatchEvent(new Event(CONSENT_CHANGED_EVENT));
    setAnalytics(stored.analytics);
    setStatus(stored.analytics ? 'Analytics are on for this storefront.' : serverDecisionSaved ? 'Optional analytics are off.' : 'Analytics are off in this browser, but we could not notify the server. Reconnect and save your choice to complete withdrawal.');
    setBusy(false);
    setVisible(false);
    setCustomising(false);
  }

  if (!ready) return null;

  return (
    <>
      <button type="button" className="spc-manage" onClick={openChoices} aria-haspopup="dialog">
        Privacy choices
      </button>
      <p className="spc-status" role="status" aria-live="polite">{status}</p>
      {visible ? (
        <section className="spc-panel" role="dialog" aria-modal="true" aria-labelledby="spc-title" aria-describedby="spc-description">
          <div className="spc-copy">
            <h2 id="spc-title">Your privacy choices</h2>
            <p id="spc-description">
              {analyticsEnabled
                ? 'This storefront only counts page views if you allow it. It stores no cookie and no personal data: just how many times each page was opened. Your choice is saved in this browser and you can change it at any time.'
                : 'This storefront does not collect analytics, so there is nothing optional to switch on. Nothing about your visit is tracked here.'}
            </p>
          </div>
          {error ? <p className="spc-error" role="alert">{error}</p> : null}
          {!analyticsEnabled ? (
            <div className="spc-actions">
              <button type="button" className="spc-button" onClick={() => { setVisible(false); setCustomising(false); }}>Close</button>
            </div>
          ) : customising ? (
            <div className="spc-customise">
              <p><strong>Essential storage</strong> — used to remember this privacy choice; it cannot be switched off here.</p>
              <label className="spc-check">
                <input type="checkbox" checked={analytics} disabled={busy} onChange={(event) => setAnalytics(event.currentTarget.checked)} />
                <span><strong>Page-view analytics</strong><br />Count which pages are opened on this storefront. No cookie, no identifier.</span>
              </label>
              <div className="spc-actions">
                <button type="button" className="spc-button spc-secondary" disabled={busy} onClick={() => void saveChoice(false)}>Reject optional</button>
                <button type="button" className="spc-button" disabled={busy} onClick={() => void saveChoice(analytics)}>{busy ? 'Saving…' : 'Save choices'}</button>
              </div>
            </div>
          ) : (
            <div className="spc-actions">
              <button type="button" className="spc-button spc-secondary" disabled={busy} onClick={() => void saveChoice(false)}>Reject optional</button>
              <button type="button" className="spc-button spc-secondary" disabled={busy} onClick={() => setCustomising(true)}>Customise</button>
              <button type="button" className="spc-button" disabled={busy} onClick={() => void saveChoice(true)}>{busy ? 'Saving…' : 'Accept all'}</button>
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}
