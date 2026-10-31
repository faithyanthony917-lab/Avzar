'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import type { CurrentUser } from '@/lib/auth-types';
import { api } from '@/lib/client';
import { CURRENCIES, defaultCurrency } from '@/lib/locale';
import { ApiError, messageFor } from '@/lib/problem';
import { Field, SelectField } from './Field';

export function RegisterForm() {
  const router = useRouter();
  const [businessName, setBusinessName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [locationName, setLocationName] = useState('');
  const [timeZoneId, setTimeZoneId] = useState('UTC');
  const [zones, setZones] = useState<string[]>(['UTC']);
  const [currencyCode, setCurrencyCode] = useState('USD');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);

  // Time zones come from the browser, so they are filled in after mount to keep server and client markup identical.
  useEffect(() => {
    try {
      const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const all = Array.from(new Set(['UTC', detected, ...list])).sort();
      setZones(all);
      setTimeZoneId(detected);
      setCurrencyCode(defaultCurrency(detected));
    } catch { /* keep UTC / USD */ }
  }, []);

  const err = (k: string) => fields[k]?.[0];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !agreed) return;
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await api<CurrentUser>('/api/auth/register-business', {
        method: 'POST',
        json: {
          businessName: businessName.trim(),
          ownerName: ownerName.trim(),
          email: email.trim(),
          password,
          timeZoneId,
          currencyCode,
          locationName: locationName.trim() || undefined,
        },
      });
      router.replace('/dashboard');
      router.refresh();
    } catch (e2) {
      if (e2 instanceof ApiError) setFields(e2.fields);
      setError(messageFor(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="ap-form" aria-busy={busy}>
      <h1>Create your business</h1>
      {error && <p role="alert" className="ap-alert">{error}</p>}
      <Field id="businessName" label="Business name" required minLength={2} maxLength={120} autoComplete="organization" value={businessName} onChange={setBusinessName} error={err('businessName')} />
      <Field id="ownerName" label="Your name" required minLength={2} maxLength={120} autoComplete="name" value={ownerName} onChange={setOwnerName} error={err('ownerName')} />
      <Field id="email" label="Email" type="email" required maxLength={256} autoComplete="username" value={email} onChange={setEmail} error={err('email')} />
      <Field id="password" label="Password" type="password" required minLength={10} maxLength={128} autoComplete="new-password" value={password} onChange={setPassword} error={err('password')} hint="At least 10 characters." />
      <Field id="locationName" label="First location (optional)" maxLength={120} value={locationName} onChange={setLocationName} error={err('locationName')} hint="For example your shop or studio. You can add more later." />
      <SelectField id="timeZoneId" label="Time zone" value={timeZoneId} onChange={setTimeZoneId} options={zones.map((z) => ({ value: z, label: z }))} error={err('timeZoneId')} />
      <SelectField id="currencyCode" label="Currency" value={currencyCode} onChange={setCurrencyCode} options={CURRENCIES.map((c) => ({ value: c, label: c }))} error={err('currencyCode')} />
      <label className="ap-check">
        <input type="checkbox" required checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>I agree to the <Link href="/terms" target="_blank">Terms</Link> and <Link href="/privacy" target="_blank">Privacy Policy</Link>.</span>
      </label>
      <button className="ap-btn" type="submit" disabled={busy || !agreed}>{busy ? 'Creating…' : 'Create business'}</button>
      <p className="ap-foot">Already have an account? <Link href="/login">Sign in</Link></p>
    </form>
  );
}
