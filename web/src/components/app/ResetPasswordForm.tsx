'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { passwordProblem } from '@/lib/account-security';
import { api } from '@/lib/client';
import { ApiError, messageFor } from '@/lib/problem';
import { Field } from './Field';

/** POST /api/auth/reset-password { userId, token, newPassword } (accountRoutes.js:47). userId and token come from the emailed link. */
export function ResetPasswordForm({ userId, token }: { userId: string; token: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const problem = passwordProblem(password) ?? (password !== confirm ? 'The two passwords do not match.' : null);
    if (problem) { setError(problem); return; }
    setBusy(true);
    try {
      await api('/api/auth/reset-password', { method: 'POST', json: { userId, token, newPassword: password } });
      setPassword(''); setConfirm('');
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_token') setExpired(true);
      else setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return <div className="ap-form">
      <h1>Password changed</h1>
      <p role="status" style={{ margin: 0 }}>Your password has been changed and you were signed out everywhere. Sign in with your new password.</p>
      <Link className="ap-btn" href="/login" style={{ textDecoration: 'none', textAlign: 'center' }}>Go to sign in</Link>
    </div>;
  }

  if (expired) {
    return <div className="ap-form">
      <h1>This link has expired</h1>
      <p role="alert" style={{ margin: 0 }}>This reset link is invalid, has expired or has already been used. Request a new one and try again.</p>
      <Link className="ap-btn" href="/forgot-password" style={{ textDecoration: 'none', textAlign: 'center' }}>Request a new link</Link>
    </div>;
  }

  return <form onSubmit={submit} className="ap-form" aria-busy={busy}>
    <h1>Choose a new password</h1>
    {error && <p role="alert" className="ap-alert">{error}</p>}
    <Field id="password" label="New password" type="password" autoComplete="new-password" required minLength={10} maxLength={128} value={password} onChange={setPassword} hint="At least 10 characters." />
    <Field id="confirm" label="Confirm new password" type="password" autoComplete="new-password" required minLength={10} maxLength={128} value={confirm} onChange={setConfirm} />
    <button className="ap-btn" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
  </form>;
}
