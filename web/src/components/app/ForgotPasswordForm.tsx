'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { Field } from './Field';

/** POST /api/auth/forgot-password (accountRoutes.js:43). The API answers 202 whether or not the address has an account, and so does this page. */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/forgot-password', { method: 'POST', json: { email: email.trim() } });
      setSent(true);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return <div className="ap-form">
      <h1>Check your email</h1>
      <p role="status" style={{ margin: 0 }}>If an account exists for that address, we have sent a link to choose a new password. The link works once and expires after a short time.</p>
      <p className="ap-foot">Nothing arrived? Check your spam folder, wait a couple of minutes, then try again.</p>
      <p className="ap-foot"><Link href="/login">Back to sign in</Link></p>
    </div>;
  }

  return <form onSubmit={submit} className="ap-form" aria-busy={busy}>
    <h1>Forgot your password?</h1>
    <p style={{ margin: 0 }}>Enter the email address you sign in with and we will send you a link to choose a new password.</p>
    {error && <p role="alert" className="ap-alert">{error}</p>}
    <Field id="email" label="Email" type="email" autoComplete="username" required autoFocus maxLength={256} value={email} onChange={setEmail} />
    <button className="ap-btn" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
    <p className="ap-foot"><Link href="/login">Back to sign in</Link></p>
  </form>;
}
