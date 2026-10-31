'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { deleteAccountBody, deleteAccountProblem, exportFileName, type DeleteFactor } from '@/lib/account-data';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import { Field } from './Field';

type Notice = { kind: 'ok' | 'error'; text: string } | null;

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return notice.kind === 'error' ? <p role="alert" className="ap-alert">{notice.text}</p> : <p role="status" className="ap-ok">{notice.text}</p>;
}

/** Download your own account data and delete your account. Both act on the signed-in person only (accountRoutes.js). */
export function AccountData({ twoFactorEnabled }: { twoFactorEnabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<'export' | 'delete' | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<Notice>(null);
  const [password, setPassword] = useState('');
  const [factor, setFactor] = useState<DeleteFactor>('authenticator');
  const [code, setCode] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  async function download() {
    if (busy) return;
    setBusy('export');
    try {
      const data = await api<unknown>('/api/account/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = exportFileName();
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success('Your data was downloaded.');
    } catch (err) {
      toast.error(messageFor(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const problem = deleteAccountProblem({ password, twoFactorEnabled, factor, code, confirmed });
    if (problem) { setDeleteNotice({ kind: 'error', text: problem }); return; }
    setBusy('delete');
    setDeleteNotice(null);
    try {
      await api('/api/account/delete', { method: 'POST', json: deleteAccountBody({ password, twoFactorEnabled, factor, code }) });
      router.replace('/login');
      router.refresh();
    } catch (err) {
      toast.error(messageFor(err));
      setBusy(null);
    }
  }

  return (
    <div className="ap-stack">
      <section className="ap-panel ap-stack" aria-labelledby="ad-export">
        <h2 id="ad-export" className="ap-h2">Download your data</h2>
        <p className="ap-foot" style={{ margin: 0 }}>A JSON file with your sign-in details, your roles in each studio and your signed-in devices. It does not include your studio's orders or customers.</p>
        <div><button type="button" className="ap-btn ap-btn-quiet" onClick={() => void download()} disabled={busy !== null}>{busy === 'export' ? 'Preparing…' : 'Download my data'}</button></div>
      </section>

      <section className="ap-panel" aria-labelledby="ad-delete">
        <form className="ap-form" onSubmit={remove} noValidate>
          <h2 id="ad-delete" className="ap-h2">Delete your account</h2>
          <p className="ap-foot">Your name and email are removed and you are signed out everywhere. Records your studio needs, such as invoices and the audit log, stay, without your name. This cannot be undone. If you own a studio, close it or hand it over first.</p>
          <Field id="ad-password" label="Your password" type="password" autoComplete="current-password" value={password} onChange={setPassword} />
          {twoFactorEnabled && (
            <fieldset className="ap-fieldset">
              <legend>Second step</legend>
              <label className="ap-check"><input type="radio" name="ad-factor" checked={factor === 'authenticator'} onChange={() => { setFactor('authenticator'); setCode(''); }} /> Authenticator app code</label>
              <label className="ap-check"><input type="radio" name="ad-factor" checked={factor === 'recovery'} onChange={() => { setFactor('recovery'); setCode(''); }} /> Recovery code</label>
              <Field id="ad-code" label={factor === 'authenticator' ? '6-digit code' : 'Recovery code'} autoComplete="one-time-code" inputMode={factor === 'authenticator' ? 'numeric' : 'text'} value={code} onChange={setCode} />
            </fieldset>
          )}
          <label className="ap-check"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I understand my account will be deleted for good.</label>
          <NoticeLine notice={deleteNotice} />
          <div><button type="submit" className="ap-btn ap-btn-danger" disabled={busy !== null}>{busy === 'delete' ? 'Deleting…' : 'Delete my account'}</button></div>
        </form>
      </section>
    </div>
  );
}
