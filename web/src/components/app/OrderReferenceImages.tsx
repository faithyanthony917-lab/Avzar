'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, apiUpload } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { orderReferenceImageFilePath, orderReferenceImagesPath, taskReferenceImageFilePath, taskReferenceImagesPath } from '@/lib/order-reference-images';
import { toast } from '@/lib/toast';

type ReferenceImage = { id: string; orderId: string; mediaId: string; caption: string | null; fileName: string; width: number; height: number; sizeBytes: number; createdAtUtc: string };
type ReferenceList = { items: ReferenceImage[]; maxImages?: number };

function Gallery({ items, fileUrl, onRemove, busy }: { items: ReferenceImage[]; fileUrl: (image: ReferenceImage, variant: 'md' | 'orig') => string; onRemove?: (image: ReferenceImage) => void; busy?: boolean }) {
  return <div className="ap-grid2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 12rem), 1fr))' }}>
    {items.map((image) => <figure key={image.id} style={{ margin: 0, minWidth: 0 }}>
      <a href={fileUrl(image, 'orig')} target="_blank" rel="noreferrer" aria-label={`Open ${image.fileName}`}>
        {/* The protected same-origin API proxy checks authorization before streaming the image. */}
        <img src={fileUrl(image, 'md')} alt={image.caption || `Reference image ${image.fileName}`} loading="lazy" style={{ width: '100%', height: 'auto', display: 'block', borderRadius: '.5rem' }} />
      </a>
      <figcaption className="ap-small" style={{ marginTop: '.4rem', overflowWrap: 'anywhere' }}>
        {image.caption || image.fileName}
        {onRemove && <><br /><button className="ap-btn ap-btn-quiet" type="button" disabled={busy} onClick={() => onRemove(image)} aria-label={`Remove ${image.caption || image.fileName}`}>Remove</button></>}
      </figcaption>
    </figure>)}
  </div>;
}

/** Reference images of an order (a customer's inspiration photos, a sketch, a swatch). Staff with orders.manage can add and remove. */
export function OrderReferenceImages({ orderId, canManage, orderCancelled = false }: { orderId: string; canManage: boolean; orderCancelled?: boolean }) {
  const base = orderReferenceImagesPath(orderId);
  const [items, setItems] = useState<ReferenceImage[]>([]);
  const [maxImages, setMaxImages] = useState(10);
  const [loaded, setLoaded] = useState(false);
  const [caption, setCaption] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const result = await api<ReferenceList>(base);
    setItems(result.items ?? []);
    if (typeof result.maxImages === 'number') setMaxImages(result.maxImages);
    setLoaded(true);
  }, [base]);

  useEffect(() => { void load().catch((e) => { setError(messageFor(e)); setLoaded(true); }); }, [load]);

  async function upload() {
    if (!file || busy) return;
    if (!file.type.startsWith('image/')) { setError('Choose an image file.'); return; }
    setBusy(true); setError('');
    try {
      await apiUpload<ReferenceImage>(base, file, caption.trim() ? { caption: caption.trim() } : {});
      setFile(null); setCaption('');
      const input = document.getElementById(`ref-image-${orderId}`) as HTMLInputElement | null;
      if (input) input.value = '';
      await load();
      toast.success('Reference image added.');
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }

  async function remove(image: ReferenceImage) {
    if (busy) return;
    if (!window.confirm('Remove this reference image? This cannot be undone.')) return;
    setBusy(true); setError('');
    try {
      await api(`${base}/${encodeURIComponent(image.id)}`, { method: 'DELETE' });
      await load();
      toast.success('Reference image removed.');
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }

  const full = items.length >= maxImages;
  return <section className="ap-panel ap-stack" aria-labelledby={`ref-images-title-${orderId}`}>
    <h2 id={`ref-images-title-${orderId}`} className="ap-h2">Reference images</h2>
    {error && <p className="ap-alert" role="alert">{error}</p>}
    {canManage && !orderCancelled && <>
      <div className="ap-field">
        <label htmlFor={`ref-image-${orderId}`}>Choose image</label>
        <input id={`ref-image-${orderId}`} className="ap-input" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || full} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      <div className="ap-field">
        <label htmlFor={`ref-image-caption-${orderId}`}>Caption (optional)</label>
        <input id={`ref-image-caption-${orderId}`} className="ap-input" maxLength={500} value={caption} disabled={busy || full} onChange={(e) => setCaption(e.target.value)} placeholder="e.g. Neckline the customer likes" />
      </div>
      <div className="ap-actions">
        <button className="ap-btn" type="button" disabled={busy || !file || full} onClick={() => void upload()}>{busy ? 'Working…' : 'Add image'}</button>
        <span className="ap-foot">{items.length} of {maxImages} images. JPEG, PNG or WebP. Only your team can see these.</span>
      </div>
    </>}
    {!loaded ? <p className="ap-foot" style={{ margin: 0 }}>Loading…</p>
      : items.length === 0 ? <p className="ap-foot" style={{ margin: 0 }}>No reference images yet.</p>
        : <Gallery items={items} busy={busy} fileUrl={(image, variant) => `/backend${orderReferenceImageFilePath(orderId, image.id, variant)}`} onRemove={canManage && !orderCancelled ? (image) => void remove(image) : undefined} />}
  </section>;
}

/** Read-only view for the worker a task is assigned to. */
export function TaskReferenceImages({ taskId }: { taskId: string }) {
  const [items, setItems] = useState<ReferenceImage[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<ReferenceList>(taskReferenceImagesPath(taskId)).then((result) => setItems(result.items ?? [])).catch((e) => setError(messageFor(e)));
  }, [taskId]);
  if (!error && items.length === 0) return null;
  return <section className="ap-panel ap-stack" aria-labelledby={`task-ref-images-title-${taskId}`}>
    <h2 id={`task-ref-images-title-${taskId}`} className="ap-h2">Reference images</h2>
    {error ? <p className="ap-alert" role="alert">{error}</p>
      : <Gallery items={items} fileUrl={(image, variant) => `/backend${taskReferenceImageFilePath(taskId, image.id, variant)}`} />}
  </section>;
}
