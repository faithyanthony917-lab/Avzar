'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client';
import type { TaskDetail, WorkerOption } from '@/lib/production-types';
import { workerRequestOptions } from '@/lib/production-workflows';
import { toast } from '@/lib/toast';

type Props = {
  detail: TaskDetail;
  isWorker: boolean;
  canAssign: boolean;
  canManage: boolean;
  canOverride: boolean;
  workers: WorkerOption[];
};

export function TaskActions({ detail, isWorker, canAssign, canManage, canOverride, workers }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [requestType, setRequestType] = useState<'Assistance' | 'Reassignment' | 'Discrepancy'>(detail.task.estimatedMinutes && ['InProgress', 'Paused', 'Completed'].includes(detail.task.status) ? 'Discrepancy' : 'Assistance');
  const [requestMessage, setRequestMessage] = useState('');
  const [actualMinutes, setActualMinutes] = useState('');
  const [note, setNote] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [forceReason, setForceReason] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [assignee, setAssignee] = useState(detail.task.assigneeMembershipId ?? '');
  const [override, setOverride] = useState(false);
  const [issueType, setIssueType] = useState('MissingMaterials');
  const [issue, setIssue] = useState('');
  const [checks, setChecks] = useState<string[]>(detail.completedChecks);
  const [completionNotes, setCompletionNotes] = useState('');
  const t = detail.task;
  const open = t.status !== 'Completed' && t.status !== 'Cancelled';
  const availableRequestTypes = workerRequestOptions(t.status, t.estimatedMinutes);
  const forceAction: 'Start' | 'Complete' | null = t.status === 'Pending' || t.status === 'Scheduled' ? 'Start' : t.status === 'InProgress' || t.status === 'Paused' ? 'Complete' : null;

  async function act(path: string, method: 'POST' | 'PUT' = 'POST', body?: unknown) {
    setBusy(true);
    try { await api(path, { method, ...(body === undefined ? {} : { json: body }) }); toast.success('Task update saved.'); router.refresh(); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'The task action failed. Try again.'); }
    finally { setBusy(false); }
  }

  return <section className="ap-panel ap-stack" aria-labelledby="task-actions-heading">
    <h2 id="task-actions-heading" className="ap-h2">Task actions</h2>
    {isWorker && open && <div className="ap-stack">
      <div className="ap-actions">
        {(t.status === 'Pending' || t.status === 'Scheduled') && <button className="ap-btn" disabled={busy || !t.isEligible} onClick={() => void act(`/api/my/tasks/${t.id}/start`)}>Start task</button>}
        {t.status === 'InProgress' && <><button className="ap-btn ap-btn-quiet" disabled={busy} onClick={() => void act(`/api/my/tasks/${t.id}/pause`, 'POST', { note: note || null })}>Pause</button><button className="ap-btn" disabled={busy || detail.requiredChecks.some((c) => !checks.includes(c))} onClick={() => void act(`/api/my/tasks/${t.id}/complete`, 'POST', { notes: completionNotes || null, completedChecks: checks, alterationsRequired: false })}>Complete task</button></>}
        {t.status === 'Paused' && <button className="ap-btn" disabled={busy} onClick={() => void act(`/api/my/tasks/${t.id}/resume`)}>Resume</button>}
      </div>
      {t.status === 'InProgress' && <div className="ap-field"><label htmlFor="task-completion-notes">Completion notes (optional)</label><textarea id="task-completion-notes" className="ap-input" value={completionNotes} onChange={(e) => setCompletionNotes(e.target.value)} maxLength={2000} rows={2} /></div>}
      {t.status === 'InProgress' && detail.requiredChecks.length > 0 && <fieldset className="ap-fieldset"><legend>Completion checklist</legend>{detail.requiredChecks.map((c) => <label className="ap-check" key={c}><input type="checkbox" checked={checks.includes(c)} onChange={(e) => setChecks((old) => e.target.checked ? [...old.filter((x) => x !== c), c] : old.filter((x) => x !== c))} />{c}</label>)}</fieldset>}
      <div className="ap-field"><label htmlFor="task-pause-note">Pause note (optional)</label><input id="task-pause-note" className="ap-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></div>
      <fieldset className="ap-fieldset"><legend>Report a problem</legend><div className="ap-field"><label htmlFor="task-issue-type">Problem type</label><select id="task-issue-type" className="ap-input" value={issueType} onChange={(e) => setIssueType(e.target.value)}><option value="MissingMaterials">Missing materials</option><option value="Defect">Defect</option><option value="Clarification">Need clarification</option><option value="Other">Other</option></select></div><div className="ap-field"><label htmlFor="task-issue-description">Describe the problem</label><textarea id="task-issue-description" className="ap-input" value={issue} onChange={(e) => setIssue(e.target.value)} minLength={3} maxLength={2000} rows={3} /></div><button className="ap-btn ap-btn-quiet" disabled={busy || issue.trim().length < 3} onClick={() => void act(`/api/my/tasks/${t.id}/issues`, 'POST', { type: issueType, description: issue.trim() })}>Report problem</button></fieldset>
    </div>}
    {isWorker && availableRequestTypes.length > 0 && <fieldset className="ap-fieldset"><legend>Request support or report time</legend><p className="ap-foot">Requests are sent to your shop managers. A reassignment request does not change your assignment until a manager acts on it.</p><div className="ap-field"><label htmlFor="task-worker-request-type">Request type</label><select id="task-worker-request-type" className="ap-input" value={requestType} onChange={(e) => setRequestType(e.target.value as 'Assistance' | 'Reassignment' | 'Discrepancy')}>{availableRequestTypes.map((type) => <option key={type} value={type}>{type === 'Assistance' ? 'Request assistance' : type === 'Reassignment' ? 'Request reassignment' : 'Report planned vs actual time'}</option>)}</select></div><div className="ap-field"><label htmlFor="task-worker-request-message">Details</label><textarea id="task-worker-request-message" className="ap-input" value={requestMessage} onChange={(e) => setRequestMessage(e.target.value)} minLength={3} maxLength={2000} rows={3} required /></div>{requestType === 'Discrepancy' && <div className="ap-field"><label htmlFor="task-worker-actual-minutes">Actual time spent (minutes)</label><input id="task-worker-actual-minutes" className="ap-input" type="number" min={1} max={100000} step={1} value={actualMinutes} onChange={(e) => setActualMinutes(e.target.value)} required /><p className="ap-foot">Planned time: {t.estimatedMinutes} minutes. Actual time is compared with this estimate.</p></div>}<button type="button" className="ap-btn ap-btn-quiet" disabled={busy || requestMessage.trim().length < 3 || (requestType === 'Discrepancy' && (!Number.isInteger(Number(actualMinutes)) || Number(actualMinutes) < 1))} onClick={() => void act(`/api/my/tasks/${t.id}/requests`, 'POST', { type: requestType, message: requestMessage.trim(), ...(requestType === 'Discrepancy' ? { actualMinutes: Number(actualMinutes) } : {}) })}>Submit request</button></fieldset>}
    {canAssign && open && <fieldset className="ap-fieldset"><legend>Assignment</legend><div className="ap-field"><label htmlFor="task-assignee">Assigned worker</label><select id="task-assignee" className="ap-input" value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">Unassigned</option>{workers.filter((w) => w.isActive || w.membershipId === t.assigneeMembershipId).map((w) => <option key={w.membershipId} value={w.membershipId}>{w.displayName}{!w.isActive ? ' · inactive' : ''} · {w.openTasks} open tasks{w.skills.length ? ` · ${w.skills.join(', ')}` : ''}</option>)}</select></div>{canOverride && <label className="ap-check"><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Override skill/location checks</label>}{override && <div className="ap-field"><label htmlFor="task-override-reason">Override reason (minimum 5 characters)</label><textarea id="task-override-reason" className="ap-input" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} minLength={5} maxLength={500} rows={2} /></div>}<button className="ap-btn" disabled={busy || (override && overrideReason.trim().length < 5)} onClick={() => void act(`/api/tasks/${t.id}/assign`, 'POST', { membershipId: assignee || null, override, reason: override ? overrideReason.trim() : null })}>Save assignment</button></fieldset>}
    {canOverride && forceAction && <fieldset className="ap-fieldset"><legend>Manager override: {forceAction === 'Start' ? 'start task' : 'complete task'}</legend><p className="ap-hint" style={{ margin: 0 }}>Skips the usual eligibility and checklist rules. The reason is recorded in the task history and audit log. The task must be assigned first.</p><div className="ap-field"><label htmlFor="task-force-reason">Override reason (minimum 5 characters)</label><textarea id="task-force-reason" className="ap-input" value={forceReason} onChange={(e) => setForceReason(e.target.value)} minLength={5} maxLength={500} rows={2} /></div><button className="ap-btn ap-btn-quiet" disabled={busy || forceReason.trim().length < 5 || !t.assigneeMembershipId} onClick={() => { if (window.confirm(forceAction === 'Start' ? 'Force-start this task, bypassing eligibility checks?' : 'Mark this task complete by manager override, bypassing the checklist?')) void act(`/api/tasks/${t.id}/override`, 'POST', { action: forceAction, reason: forceReason.trim() }); }}>{forceAction === 'Start' ? 'Override and start' : 'Override and complete'}</button>{!t.assigneeMembershipId && <p className="ap-foot" style={{ margin: 0 }}>Assign this task to someone before overriding it.</p>}</fieldset>}
    {canManage && t.status === 'Blocked' && <fieldset className="ap-fieldset"><legend>Unblock task</legend><div className="ap-field"><label htmlFor="task-unblock-note">Resolution note (optional)</label><textarea id="task-unblock-note" className="ap-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} /></div><button className="ap-btn" disabled={busy} onClick={() => void act(`/api/tasks/${t.id}/unblock`, 'POST', { note: note || null })}>Unblock</button></fieldset>}
    {canManage && open && <fieldset className="ap-fieldset"><legend>Cancel task</legend><div className="ap-field"><label htmlFor="task-cancel-reason">Reason (minimum 3 characters)</label><textarea id="task-cancel-reason" className="ap-input" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} minLength={3} maxLength={500} rows={2} /></div><button className="ap-btn ap-btn-danger" disabled={busy || cancelReason.trim().length < 3} onClick={() => { if (window.confirm('Cancel this production task? This action is recorded in the task history.')) void act(`/api/tasks/${t.id}/cancel`, 'POST', { reason: cancelReason.trim() }); }}>Cancel task</button></fieldset>}
    {!isWorker && !canAssign && !canManage && <p style={{ margin: 0 }}>You can view this task but do not have permission to change it.</p>}
    {busy && <p className="ap-foot" role="status">Saving task change…</p>}
  </section>;
}
