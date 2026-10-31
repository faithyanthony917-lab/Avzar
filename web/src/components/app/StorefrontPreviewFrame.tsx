'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { PREVIEW_DEVICES, planForTier, previewPath, upgradePath, type PreviewDevice } from '@/lib/storefront-guided';

/** The visible part: device buttons, the frame and the notes. No data fetching, so it renders the same on the server and in tests. */
export function PreviewFrameView({ path, device, loading, error, unsaved, expiresAtUtc, onDevice, onReload }: {
  path: string | null; device: PreviewDevice; loading: boolean; error: string; unsaved: boolean; expiresAtUtc: string | null;
  onDevice: (device: PreviewDevice) => void; onReload: () => void;
}) {
  return <div className="ap-stack">
    <div className="ap-actions" role="group" aria-label="Preview width">
      {PREVIEW_DEVICES.map((item) => <button key={item.key} type="button" className={`ap-btn ap-btn-sm${device === item.key ? '' : ' ap-btn-quiet'}`} aria-pressed={device === item.key} onClick={() => onDevice(item.key)}>{item.label}</button>)}
      <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={loading} onClick={onReload}>{loading ? 'Loading…' : 'Reload preview'}</button>
    </div>
    {unsaved && <p className="ap-foot" role="status" style={{ margin: 0 }}>You have changes that are not saved yet. The preview shows your last saved draft, so save the draft to see them.</p>}
    {error && <div className="ap-alert" role="alert">{error}</div>}
    {path
      ? <div className={`ap-preview-stage ap-preview-${device}`}>
        <div className="ap-preview-box"><iframe title={`Storefront preview, ${device} width`} className="ap-preview-frame" src={path} sandbox="allow-scripts allow-same-origin" loading="lazy" /></div>
      </div>
      : !error && <p className="ap-foot" style={{ margin: 0 }}>{loading ? 'Preparing the private preview…' : 'The preview has not been opened yet.'}</p>}
    <p className="ap-foot" style={{ margin: 0 }}>Only you can see this preview. Forms inside it are switched off, so nothing you try there reaches a customer. {expiresAtUtc ? 'The private link expires after a short time; use Reload preview to get a fresh one.' : ''}</p>
  </div>;
}

/** Opens a private preview of the saved draft inside the page and reloads it whenever the draft revision changes. */
export function StorefrontPreviewFrame({ storefrontId, revision, unsaved }: { storefrontId: string; revision: number; unsaved: boolean }) {
  const [open, setOpen] = useState(false);
  const [device, setDevice] = useState<PreviewDevice>('phone');
  const [path, setPath] = useState<string | null>(null);
  const [expiresAtUtc, setExpiresAtUtc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const result = await api<{ token: string; expiresAtUtc?: string }>(`/api/storefronts/${storefrontId}/preview-link`, { method: 'POST' });
      setPath(previewPath(result.token)); setExpiresAtUtc(result.expiresAtUtc ?? null);
    } catch (e) { setPath(null); setError(messageFor(e)); }
    finally { setLoading(false); }
  }, [storefrontId]);

  useEffect(() => { setPath(null); setOpen(false); setError(''); }, [storefrontId]);
  useEffect(() => { if (open) void load(); }, [open, revision, load]);

  return <fieldset className="ap-fieldset ap-stack"><legend>Live preview</legend>
    <p className="ap-foot" style={{ margin: 0 }}>See your saved draft the way visitors will, at phone or desktop width, before you publish.</p>
    {!open
      ? <div className="ap-actions"><button type="button" className="ap-btn ap-btn-quiet" onClick={() => setOpen(true)}>Show preview</button></div>
      : <>
        <PreviewFrameView path={path} device={device} loading={loading} error={error} unsaved={unsaved} expiresAtUtc={expiresAtUtc} onDevice={setDevice} onReload={() => void load()} />
        <div className="ap-actions"><button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" onClick={() => setOpen(false)}>Hide preview</button></div>
      </>}
  </fieldset>;
}

/** A view-only sample of a template the plan does not include yet, with the shop's own name. Saves nothing and never changes the draft. */
export function SamplePreviewNote({ templateName, tier, allowed = false }: { templateName: string; tier: string; allowed?: boolean }) {
  const href = allowed ? null : upgradePath(tier);
  return <div className="ap-stack">
    <p className="ap-foot" role="note" style={{ margin: 0 }}>This is a sample of {templateName} with your shop name and starter wording. It is not your saved content, and nothing here changes your draft. {allowed ? `Your plan includes ${templateName}: choose Use this template on its card to use it.` : `${templateName} is included from the ${planForTier(tier)} plan.`}</p>
    {href && <div className="ap-actions"><a className="ap-btn" href={href}>Upgrade to {planForTier(tier)}</a></div>}
  </div>;
}

export function TemplateSamplePreview({ storefrontId, templateKey, templateName, tier, allowed = false, onClose }: {
  storefrontId: string; templateKey: string; templateName: string; tier: string; allowed?: boolean; onClose: () => void;
}) {
  const [device, setDevice] = useState<PreviewDevice>('fit');
  const box = useRef<HTMLFieldSetElement>(null);
  useEffect(() => { box.current?.scrollIntoView?.({ block: 'start' }); }, [templateKey]);
  const [path, setPath] = useState<string | null>(null);
  const [expiresAtUtc, setExpiresAtUtc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const result = await api<{ token: string; expiresAtUtc?: string }>(`/api/storefronts/${storefrontId}/preview-link`, { method: 'POST', json: { templateKey } });
      setPath(previewPath(result.token)); setExpiresAtUtc(result.expiresAtUtc ?? null);
    } catch (e) { setPath(null); setError(messageFor(e)); }
    finally { setLoading(false); }
  }, [storefrontId, templateKey]);

  useEffect(() => { void load(); }, [load]);

  return <fieldset ref={box} className="ap-fieldset ap-stack"><legend>Sample: {templateName}</legend>
    <SamplePreviewNote templateName={templateName} tier={tier} allowed={allowed} />
    <PreviewFrameView path={path} device={device} loading={loading} error={error} unsaved={false} expiresAtUtc={expiresAtUtc} onDevice={setDevice} onReload={() => void load()} />
    <div className="ap-actions"><button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" onClick={onClose}>Close sample</button></div>
  </fieldset>;
}
