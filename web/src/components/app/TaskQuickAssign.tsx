'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import type { WorkerOption } from '@/lib/production-types';

/** Assign or unassign a worker straight from the production list. Overrides stay on the task page. */
export function TaskQuickAssign({ taskId, assigneeMembershipId, workers }: { taskId: string; assigneeMembershipId: string | null; workers: WorkerOption[] }) {
  const router = useRouter();
  const [value, setValue] = useState(assigneeMembershipId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const changed = value !== (assigneeMembershipId ?? '');

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/assign`, { method: 'POST', json: { membershipId: value || null, override: false, reason: null } });
      router.refresh();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label className="ap-sr" htmlFor={`assign-${taskId}`}>Assigned worker</label>
      <select id={`assign-${taskId}`} className="ap-input" value={value} disabled={busy} onChange={(e) => setValue(e.target.value)}>
        <option value="">Unassigned</option>
        {workers.filter((w) => w.isActive || w.membershipId === assigneeMembershipId).map((w) => <option key={w.membershipId} value={w.membershipId}>{w.displayName}{!w.isActive ? ' · inactive' : ''} · {w.openTasks} open</option>)}
      </select>
      {changed && <button type="button" className="ap-btn ap-btn-sm" disabled={busy} onClick={() => void save()} style={{ marginTop: '.35rem' }}>{busy ? 'Saving…' : 'Save'}</button>}
      {error && <div className="ap-err" role="alert">{error}</div>}
    </div>
  );
}
