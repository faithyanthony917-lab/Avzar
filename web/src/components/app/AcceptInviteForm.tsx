'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { CurrentUser } from '@/lib/auth-types';
import { api } from '@/lib/client';
import { ApiError, messageFor } from '@/lib/problem';
import { Field } from './Field';

interface Props {
  token: string;
  /** Set when someone is already signed in: the invitation is accepted with that account. */
  signedInAs: string | null;
}

export function AcceptInviteForm({ token, signedInAs }: Props) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setFields({});
    try {
      if (signedInAs) await api<CurrentUser>('/api/auth/accept-invitation/existing', { method: 'POST', json: { token } });
      else await api<CurrentUser>('/api/auth/accept-invitation', { method: 'POST', json: { token, password } });
      router.replace('/dashboard');
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) setFields(err.fields);
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  const loginHref = `/login?next=${encodeURIComponent(`/accept-invite?token=${token}`)}`;

  return (
    <form onSubmit={submit} className="ap-form" aria-busy={busy}>
      <h1>Join your team</h1>
      {error && <p role="alert" className="ap-alert">{error}</p>}
      {signedInAs ? (
        <p>You are signed in as <strong>{signedInAs}</strong>. The invitation must have been sent to this email address.</p>
      ) : (
        <>
          <p>Choose a password to finish creating your account.</p>
          <Field id="password" label="Password" type="password" required minLength={10} maxLength={128} autoComplete="new-password" value={password} onChange={setPassword} error={fields.password?.[0]} hint="At least 10 characters." />
        </>
      )}
      <button className="ap-btn" type="submit" disabled={busy}>{busy ? 'Joining…' : signedInAs ? 'Accept invitation' : 'Create account and join'}</button>
      {!signedInAs && <p className="ap-foot">Already have an account? <Link href={loginHref}>Sign in to accept</Link></p>}
    </form>
  );
}
