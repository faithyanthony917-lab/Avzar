'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { BusinessChoice, CurrentUser } from '@/lib/auth-types';
import { api } from '@/lib/client';
import { ApiError, messageFor } from '@/lib/problem';
import { Field, SelectField } from './Field';

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [choices, setChoices] = useState<BusinessChoice[]>([]);
  const [businessId, setBusinessId] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const trimmed = code.trim();
      await api<CurrentUser>('/api/auth/login', {
        method: 'POST',
        json: {
          email: email.trim(),
          password,
          businessId: businessId || undefined,
          twoFactorCode: needsCode && !useRecovery && trimmed ? trimmed : undefined,
          recoveryCode: needsCode && useRecovery && trimmed ? trimmed : undefined,
        },
      });
      router.replace(next);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'choose_business') {
        const list = ((err.body as { choices?: BusinessChoice[] } | undefined)?.choices ?? []).filter((c) => c && c.businessId);
        setChoices(list);
        setBusinessId(list[0]?.businessId ?? '');
        setError('This email belongs to more than one business. Choose which one to open.');
      } else if (err instanceof ApiError && err.code === 'two_factor_required') {
        setNeedsCode(true);
        setError(null);
      } else {
        setError(messageFor(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="ap-form" aria-busy={busy}>
      <h1>Sign in</h1>
      {error && <p role="alert" className="ap-alert">{error}</p>}
      <Field id="email" label="Email" type="email" autoComplete="username" required value={email} onChange={setEmail} maxLength={256} readOnly={needsCode} />
      <Field id="password" label="Password" type="password" autoComplete="current-password" required value={password} onChange={setPassword} maxLength={128} readOnly={needsCode} />
      {choices.length > 0 && (
        <SelectField id="business" label="Business" value={businessId} onChange={setBusinessId} options={choices.map((c) => ({ value: c.businessId, label: c.businessName }))} />
      )}
      {needsCode && (
        <>
          <Field
            id="code"
            label={useRecovery ? 'Recovery code' : 'Authenticator code'}
            autoComplete="one-time-code"
            inputMode={useRecovery ? 'text' : 'numeric'}
            required
            autoFocus
            value={code}
            onChange={setCode}
            hint={useRecovery ? 'Each recovery code works once.' : 'Enter the 6-digit code from your authenticator app.'}
          />
          <button type="button" className="ap-link" onClick={() => { setUseRecovery(!useRecovery); setCode(''); }}>
            {useRecovery ? 'Use my authenticator app instead' : 'Use a recovery code instead'}
          </button>
        </>
      )}
      <button className="ap-btn" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <p className="ap-foot"><Link href="/forgot-password">Forgot password?</Link></p>
      <p className="ap-foot">New here? <Link href="/register">Create a business account</Link></p>
    </form>
  );
}
