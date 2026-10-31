'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, apiUpload } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { taskPhotoFilePath, taskPhotosApiPath } from '@/lib/task-photos';
import { toast } from '@/lib/toast';

type Photo = { id: string; taskId: string; mediaId: string; caption: string | null; uploadedAtUtc: string; fileName: string; contentType?: string; sizeBytes: number };
type PhotoList = { items: Photo[] };

/** Task-scoped progress photos. The API enforces assignment, tenant, and location access. */
export function TaskProgressPhotos({ taskId, workerOnly = false }: { taskId: string; workerOnly?: boolean }) {
  const base = taskPhotosApiPath(taskId, workerOnly);
  const [items, setItems] = useState<Photo[]>([]);
  const [caption, setCaption] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  
  const load = useCallback(async () => {
    const result = await api<PhotoList>(base);
    setItems(result.items ?? []);
  }, [base]);

  useEffect(() => { void load().catch((e) => setError(messageFor(e))); }, [load]);

  async function upload() {
    if (!file || busy) return;
    if (!file.type.startsWith('image/')) { setError('Choose an image file.'); return; }
    setBusy(true); setError('');
    try {
      await apiUpload<Photo>(base, file, caption.trim() ? { caption: caption.trim() } : {});
      setFile(null); setCaption('');
      const input = document.getElementById(`task-photo-${taskId}`) as HTMLInputElement | null;
      if (input) input.value = '';
      await load();
      toast.success('Progress photo uploaded.');
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }

  return <section className="ap-panel ap-stack" aria-labelledby={`task-photos-title-${taskId}`}>
    <h2 id={`task-photos-title-${taskId}`} className="ap-h2">Progress photos</h2>
    {error && <p className="ap-alert" role="alert">{error}</p>}
    {workerOnly ? <>
      <div className="ap-field">
        <label htmlFor={`task-photo-${taskId}`}>Choose photo</label>
        <input id={`task-photo-${taskId}`} className="ap-input" type="file" accept="image/*" capture="environment" disabled={busy} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      <div className="ap-field">
        <label htmlFor={`task-photo-caption-${taskId}`}>Caption (optional)</label>
        <input id={`task-photo-caption-${taskId}`} className="ap-input" maxLength={500} value={caption} disabled={busy} onChange={(e) => setCaption(e.target.value)} placeholder="e.g. Fitting completed" />
      </div>
      <div className="ap-actions"><button className="ap-btn" type="button" disabled={busy || !file} onClick={() => void upload()}>{busy ? 'Uploading…' : 'Upload photo'}</button><button className="ap-btn ap-btn-quiet" type="button" disabled={busy} onClick={() => void load().catch((e) => setError(messageFor(e)))}>Refresh photos</button></div>
    </> : <div className="ap-actions"><span className="ap-foot">Read-only view. Assigned workers upload progress photos from their task screen.</span><button className="ap-btn ap-btn-quiet" type="button" disabled={busy} onClick={() => void load().catch((e) => setError(messageFor(e)))}>Refresh photos</button></div>}
    {items.length === 0 ? <p className="ap-foot" style={{ margin: 0 }}>No progress photos yet.</p> : <div className="ap-grid2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 12rem), 1fr))' }}>
      {items.map((photo) => <figure key={photo.id} style={{ margin: 0, minWidth: 0 }}>
        <a href={`/backend${taskPhotoFilePath(taskId, photo.id, workerOnly)}`} target="_blank" rel="noreferrer" aria-label={`Open ${photo.fileName}`}>
          {/* The protected same-origin API proxy checks authorization before streaming the image. */}
          <img src={`/backend${taskPhotoFilePath(taskId, photo.id, workerOnly)}`} alt={photo.caption || `Task progress photo uploaded ${new Date(photo.uploadedAtUtc).toLocaleString()}`} loading="lazy" style={{ display: 'block', width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: '.5rem', background: 'var(--panel-muted, #f4f4f5)' }} />
        </a>
        <figcaption className="ap-small" style={{ marginTop: '.4rem', overflowWrap: 'anywhere' }}>{photo.caption || photo.fileName}<br />{new Date(photo.uploadedAtUtc).toLocaleString()}</figcaption>
      </figure>)}
    </div>}
  </section>;
}
