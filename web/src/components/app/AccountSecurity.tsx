'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  changePasswordProblem, disableTwoFactorBody, groupSetupKey, normalizeAuthenticatorCode, safeOtpAuthUri,
  type DeviceSession, type SecondFactorMethod, type SecuritySummary, type TwoFactorSetup,
} from '@/lib/account-security';
import { api } from '@/lib/client';
import { formatDateTime } from '@/lib/dates';
import { ApiError, messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import { Field } from './Field';

type Notice = { kind: 'ok' | 'error'; text: string } | null;

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return notice.kind === 'error' ? <p role="alert" className="ap-alert">{notice.text}</p> : <p role="status" className="ap-ok">{notice.text}</p>;
}

export function AccountSecurity({ initialSecurity, initialSessions, timeZoneId }: { initialSecurity: SecuritySummary; initialSessions: DeviceSession[]; timeZoneId: string }) {
  const router = useRouter();
  const [security, setSecurity] = useState(initialSecurity);
  const [sessions, setSessions] = useState(initialSessions);
  const [busy, setBusy] = useState<string | null>(null);

  const [emailNotice, setEmailNotice] = useState<Notice>(null);
  const [pwNotice, setPwNotice] = useState<Notice>(null);
  const [tfNotice, setTfNotice] = useState<Notice>(null);
  const [sessionNotice, setSessionNotice] = useState<Notice>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [enableCode, setEnableCode] = useState('');
  // Recovery codes live only in this component's state: never in storage, never re-fetched (the API shows them once, at enable time).
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableMethod, setDisableMethod] = useState<SecondFactorMethod>('authenticator');
  const [disableValue, setDisableValue] = useState('');

  const when = (iso: string) => formatDateTime(iso, timeZoneId);

  async function reload() {
    try {
      const [s, l] = await Promise.all([api<SecuritySummary>('/api/account/security'), api<DeviceSession[]>('/api/account/sessions')]);
      setSecurity(s);
      setSessions(l);
    } catch { /* keep what is on screen; the next action shows its own error */ }
  }

  async function run(key: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    try { await fn(); } catch (err) { toast.error(messageFor(err)); } finally { setBusy(null); }
  }

  const resend = () => run('resend', async () => {
    setEmailNotice(null);
    try {
      await api('/api/account/resend-verification', { method: 'POST' });
      toast.success('A verification email has been queued. Open the link in it to confirm your address.');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'email_already_confirmed') { await reload(); toast.success('Your email address is already confirmed.'); return; }
      throw err;
    }
  });

  const changePassword = (e: FormEvent) => {
    e.preventDefault();
    setPwNotice(null);
    const problem = changePasswordProblem(currentPassword, newPassword, confirmPassword);
    if (problem) { setPwNotice({ kind: 'error', text: problem }); return; }
    return run('password', async () => {
      await api('/api/account/change-password', { method: 'POST', json: { currentPassword, newPassword } });
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      await reload(); // the API signs out every other session; this browser gets a fresh one
      toast.success('Password changed. Your other sessions were signed out.');
    });
  };

  const beginSetup = () => run('setup', async () => {
    setTfNotice(null);
    setSetup(await api<TwoFactorSetup>('/api/account/two-factor/setup', { method: 'POST' }));
    setEnableCode('');
  });

  const enable = (e: FormEvent) => {
    e.preventDefault();
    setTfNotice(null);
    const code = normalizeAuthenticatorCode(enableCode);
    if (!code) { setTfNotice({ kind: 'error', text: 'Enter the 6-digit code from your authenticator app.' }); return; }
    return run('enable', async () => {
      const result = await api<{ codes: string[] }>('/api/account/two-factor/enable', { method: 'POST', json: { code } });
      setSetup(null); setEnableCode(''); setCopied(false);
      setRecoveryCodes(result.codes);
      await reload();
      toast.success('Two-factor authentication is on. Save your recovery codes below before you leave this page.');
    });
  };

  const disable = (e: FormEvent) => {
    e.preventDefault();
    setTfNotice(null);
    const built = disableTwoFactorBody(disablePassword, disableMethod, disableValue);
    if (!built.ok) { setTfNotice({ kind: 'error', text: built.error }); return; }
    if (!window.confirm('Turn off two-factor authentication? Your account will be protected by your password alone.')) return;
    return run('disable', async () => {
      await api('/api/account/two-factor/disable', { method: 'POST', json: built.body });
      setDisablePassword(''); setDisableValue(''); setRecoveryCodes(null); setSetup(null);
      await reload();
      toast.success('Two-factor authentication is off.');
    });
  };

  async function copyCodes() {
    try { await navigator.clipboard.writeText((recoveryCodes ?? []).join('\n')); setCopied(true); } catch { setCopied(false); }
  }

  const revokeOne = (s: DeviceSession) => {
    if (!window.confirm(`Sign out "${s.deviceName || 'this device'}"?`)) return;
    return run(`revoke-${s.id}`, async () => {
      setSessionNotice(null);
      await api(`/api/account/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      await reload();
      toast.success('That device was signed out.');
    });
  };

  const revokeAll = () => {
    if (!window.confirm('Sign out everywhere? Every device AND this browser will be signed out, and you will need to sign in again.')) return;
    return run('revoke-all', async () => {
      setSessionNotice(null);
      await api('/api/account/sessions/revoke-all', { method: 'POST' });
      router.replace('/login'); // the API revokes every session of this user, including the one this tab is using
      router.refresh();
    });
  };

  const otpLink = setup ? safeOtpAuthUri(setup.otpAuthUri) : null;

  return <div className="ap-stack">
    <section className="ap-panel" aria-labelledby="sec-overview">
      <h2 id="sec-overview" className="ap-h2">Overview</h2>
      <dl className="ap-dl">
        <dt>Email address</dt><dd>{security.emailConfirmed ? <span className="ap-badge ap-badge-on">Confirmed</span> : <span className="ap-badge ap-badge-off">Not confirmed</span>}</dd>
        <dt>Two-factor authentication</dt><dd>{security.twoFactorEnabled ? <span className="ap-badge ap-badge-on">On</span> : <span className="ap-badge ap-badge-off">Off</span>}</dd>
        {security.twoFactorEnabled && <><dt>Recovery codes left</dt><dd>{security.recoveryCodesLeft}</dd></>}
        <dt>Signed-in devices</dt><dd>{security.activeSessions}</dd>
      </dl>
      {!security.emailConfirmed && <div className="ap-stack" style={{ marginTop: '.75rem' }}>
        <div><button type="button" className="ap-btn ap-btn-quiet" onClick={resend} disabled={busy !== null}>{busy === 'resend' ? 'Sending…' : 'Resend verification email'}</button></div>
        <NoticeLine notice={emailNotice} />
      </div>}
      {security.emailConfirmed && <NoticeLine notice={emailNotice} />}
    </section>

    <section className="ap-panel" aria-labelledby="sec-password">
      <h2 id="sec-password" className="ap-h2">Change password</h2>
      <form onSubmit={changePassword} className="ap-form" aria-busy={busy === 'password'}>
        <NoticeLine notice={pwNotice} />
        <Field id="current-password" label="Current password" type="password" autoComplete="current-password" required maxLength={128} value={currentPassword} onChange={setCurrentPassword} />
        <Field id="new-password" label="New password" type="password" autoComplete="new-password" required minLength={10} maxLength={128} value={newPassword} onChange={setNewPassword} hint="At least 10 characters. Changing it signs out your other sessions." />
        <Field id="confirm-password" label="Confirm new password" type="password" autoComplete="new-password" required minLength={10} maxLength={128} value={confirmPassword} onChange={setConfirmPassword} />
        <button className="ap-btn" type="submit" disabled={busy !== null}>{busy === 'password' ? 'Changing…' : 'Change password'}</button>
      </form>
    </section>

    <section className="ap-panel" aria-labelledby="sec-2fa">
      <h2 id="sec-2fa" className="ap-h2">Two-factor authentication</h2>
      <NoticeLine notice={tfNotice} />

      {recoveryCodes && <div className="ap-stack" role="region" aria-label="Recovery codes" style={{ margin: '.75rem 0' }}>
        <h3 className="ap-h3">Save your recovery codes</h3>
        <p className="ap-foot" style={{ margin: 0 }}>These are shown only once. Each code works once if you lose your authenticator app. Store them somewhere safe, away from this device.</p>
        <ul className="ap-plain">{recoveryCodes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
        <div className="ap-actions">
          <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" onClick={() => void copyCodes()}>{copied ? 'Copied' : 'Copy codes'}</button>
          <button type="button" className="ap-btn ap-btn-sm" onClick={() => { setRecoveryCodes(null); setCopied(false); }}>I have saved these codes</button>
        </div>
      </div>}

      {!security.twoFactorEnabled && !setup && <div style={{ marginTop: '.5rem' }}>
        <p className="ap-foot" style={{ marginTop: 0 }}>Add a second step at sign-in using an authenticator app.</p>
        <button type="button" className="ap-btn" onClick={beginSetup} disabled={busy !== null}>{busy === 'setup' ? 'Starting…' : 'Set up two-factor authentication'}</button>
      </div>}

      {!security.twoFactorEnabled && setup && <form onSubmit={enable} className="ap-form" aria-busy={busy === 'enable'}>
        <p style={{ margin: 0 }}>In your authenticator app choose “enter a setup key” and type this key. Keep it private.</p>
        <p style={{ margin: 0 }}><code style={{ userSelect: 'all', wordBreak: 'break-all' }}>{groupSetupKey(setup.sharedKey)}</code></p>
        {otpLink && <p style={{ margin: 0 }}><a href={otpLink}>Open in an authenticator app on this device</a></p>}
        <Field id="enable-code" label="Code from the app" inputMode="numeric" autoComplete="one-time-code" required maxLength={7} value={enableCode} onChange={setEnableCode} hint="6 digits. Check the time on your phone if a correct code is refused." />
        <div className="ap-actions">
          <button className="ap-btn" type="submit" disabled={busy !== null}>{busy === 'enable' ? 'Checking…' : 'Turn on two-factor authentication'}</button>
          <button type="button" className="ap-btn ap-btn-quiet" onClick={() => { setSetup(null); setEnableCode(''); }} disabled={busy !== null}>Cancel</button>
        </div>
      </form>}

      {security.twoFactorEnabled && <form onSubmit={disable} className="ap-form" aria-busy={busy === 'disable'} style={{ marginTop: '.75rem' }}>
        <h3 className="ap-h3">Turn off two-factor authentication</h3>
        <Field id="disable-password" label="Current password" type="password" autoComplete="current-password" required maxLength={128} value={disablePassword} onChange={setDisablePassword} />
        <div className="ap-field">
          <label htmlFor="disable-method">Verify with</label>
          <select id="disable-method" value={disableMethod} onChange={(e) => { setDisableMethod(e.target.value as SecondFactorMethod); setDisableValue(''); }}>
            <option value="authenticator">Authenticator app code</option>
            <option value="recovery">Recovery code</option>
          </select>
        </div>
        <Field id="disable-code" label={disableMethod === 'recovery' ? 'Recovery code' : 'Authenticator code'} autoComplete="one-time-code" inputMode={disableMethod === 'recovery' ? 'text' : 'numeric'} required maxLength={disableMethod === 'recovery' ? 80 : 7} value={disableValue} onChange={setDisableValue} />
        <button className="ap-btn ap-btn-danger" type="submit" disabled={busy !== null}>{busy === 'disable' ? 'Turning off…' : 'Turn off two-factor authentication'}</button>
      </form>}
    </section>

    <section className="ap-panel" aria-labelledby="sec-sessions">
      <div className="ap-row">
        <h2 id="sec-sessions" className="ap-h2">Signed-in devices</h2>
        <button type="button" className="ap-btn ap-btn-danger ap-btn-sm" onClick={revokeAll} disabled={busy !== null}>{busy === 'revoke-all' ? 'Signing out…' : 'Sign out everywhere'}</button>
      </div>
      <p className="ap-foot">Phones and other apps you are signed in on. Web browsers, including this one, are not listed here. “Sign out everywhere” ends those sessions too, this browser included.</p>
      <NoticeLine notice={sessionNotice} />
      {sessions.length === 0 ? <p style={{ margin: 0 }}>No other devices are signed in.</p> : <div className="ap-scroll"><table className="ap-table">
        <thead><tr><th>Device</th><th>Signed in</th><th>Last used</th><th>Expires if idle</th><th><span className="ap-sr">Action</span></th></tr></thead>
        <tbody>{sessions.map((s) => <tr key={s.id}>
          <td>{s.deviceName || 'Unknown device'}</td><td>{when(s.createdAtUtc)}</td><td>{when(s.lastUsedAtUtc)}</td><td>{when(s.expiresAtUtc)}</td>
          <td><button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" onClick={() => revokeOne(s)} disabled={busy !== null}>{busy === `revoke-${s.id}` ? 'Signing out…' : 'Sign out'}</button></td>
        </tr>)}</tbody>
      </table></div>}
    </section>
  </div>;
}
