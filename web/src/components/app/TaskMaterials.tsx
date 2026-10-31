'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { Pager, usePaged } from '@/components/app/Pager';
import { buildTaskMaterialsPayload, confirmMessage, NOTE_MAX, type StockMaterial, type TaskMaterialAction } from '@/lib/task-materials';
import { toast } from '@/lib/toast';

const DONE: Record<TaskMaterialAction, string> = {
  reserve: 'Stock reserved for this task.',
  release: 'The selected reservations were released.',
  consume: 'The selected reserved stock was consumed.',
};

/** Reserve / release / consume stock for one production task: POST /api/inventory/tasks/:id/{reserve,release,consume} (catalogRoutes.js:283-299). */
export function TaskMaterials({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [materials, setMaterials] = useState<StockMaterial[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [qty, setQty] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<TaskMaterialAction | null>(null);
  const [error, setError] = useState('');
  const paged = usePaged(materials ?? []);

  const load = useCallback(async () => {
    try { setMaterials(await api<StockMaterial[]>('/api/inventory')); setLoadError(''); }
    catch (e) { setLoadError(messageFor(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function submit(action: TaskMaterialAction) {
    if (busy || !materials) return;
    setError('');
    const rows = materials.filter((m) => ticked[m.id]).map((m) => ({ materialId: m.id, label: m.name, quantity: qty[m.id] ?? '1' }));
    const built = buildTaskMaterialsPayload(rows, note);
    if (!built.ok) { setError(built.error); return; }
    if ((action === 'reserve' || action === 'consume') && !window.confirm(confirmMessage(action, rows.length))) return;
    setBusy(action);
    try {
      await api(`/api/inventory/tasks/${encodeURIComponent(taskId)}/${action}`, { method: 'POST', json: built.body });
      setTicked({}); setQty({}); setNote('');
      toast.success(DONE[action]);
      await load();
      router.refresh(); // task history and requirements are server-rendered
    } catch (e) {
      toast.error(messageFor(e));
      await load(); // stock may have changed under us
    } finally {
      setBusy(null);
    }
  }

  return <section className="ap-panel ap-stack" aria-labelledby="task-stock">
    <h2 id="task-stock" className="ap-h2">Task materials</h2>
    <p className="ap-foot" style={{ margin: 0 }}>Reserve stock for this task, release a reservation you no longer need, or consume reserved stock once it has been used. Consuming works only from stock reserved for this task.</p>
    {loadError && <p className="ap-alert" role="alert">{loadError}</p>}
    {error && <p className="ap-alert" role="alert">{error}</p>}
    {materials === null && !loadError && <p style={{ margin: 0 }}>Loading stock…</p>}
    {materials !== null && materials.length === 0 && <p style={{ margin: 0 }}>No materials are available at your locations.</p>}
    {materials !== null && materials.length > 0 && <>
      <div className="ap-scroll"><table className="ap-table">
        <thead><tr><th><span className="ap-sr">Select</span></th><th>Material</th><th>Available</th><th>Quantity</th></tr></thead>
        <tbody>{paged.slice.map((m) => <tr key={m.id}>
          <td><input type="checkbox" checked={!!ticked[m.id]} disabled={busy !== null} aria-label={`Select ${m.name}`} onChange={(e) => setTicked((t) => ({ ...t, [m.id]: e.target.checked }))} /></td>
          <td>{m.name}<div className="ap-foot">{m.sku} · {m.unit}</div></td>
          <td>{m.available}</td>
          <td><input className="ap-input" type="number" inputMode="decimal" min="0.001" step="0.001" max="1000000000" value={qty[m.id] ?? '1'} disabled={busy !== null} aria-label={`Quantity of ${m.name}`} onChange={(e) => setQty((q) => ({ ...q, [m.id]: e.target.value }))} /></td>
        </tr>)}</tbody>
      </table></div>
      <Pager page={paged.page} pages={paged.pages} total={paged.total} size={paged.size} onPage={paged.setPage} label="Task materials pages" />
      <div className="ap-field">
        <label htmlFor="task-stock-note">Note (optional)</label>
        <input id="task-stock-note" className="ap-input" maxLength={NOTE_MAX} value={note} disabled={busy !== null} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="ap-actions">
        <button type="button" className="ap-btn" disabled={busy !== null} onClick={() => void submit('reserve')}>{busy === 'reserve' ? 'Reserving…' : 'Reserve selected'}</button>
        <button type="button" className="ap-btn ap-btn-quiet" disabled={busy !== null} onClick={() => void submit('release')}>{busy === 'release' ? 'Releasing…' : 'Release selected'}</button>
        <button type="button" className="ap-btn ap-btn-quiet" disabled={busy !== null} onClick={() => void submit('consume')}>{busy === 'consume' ? 'Consuming…' : 'Consume selected'}</button>
      </div>
    </>}
  </section>;
}
