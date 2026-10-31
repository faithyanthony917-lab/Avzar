'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import { ApiError, messageFor } from '@/lib/problem';
import {
  PROFILE_NAME_MAX, PROFILE_PHONE_MAX, profileChanged, validateProfile, type Profile, type ProfileErrors,
} from '@/lib/profile-view-model';
import { toast } from '@/lib/toast';
import { Field } from './Field';

/** Edits the signed-in person's own name and phone. Email is shown but cannot be changed here. */
export function ProfileForm({ profile }: { profile: Profile }) {
  const router = useRouter();
  const [fullName, setFullName] = useState(profile.fullName);
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const check = validateProfile({ fullName, phone });
    if (!check.ok) { setErrors(check.errors); setError('Please fix the highlighted fields.'); return; }
    setErrors({});
    if (!profileChanged(profile, check.body)) { router.push('/account'); return; }
    setBusy(true);
    try {
      await api<Profile>('/api/account/profile', { method: 'PUT', json: check.body });
      toast.success('Profile saved.');
      router.push('/account');
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) setErrors({ fullName: err.fields.fullName?.[0], phone: err.fields.phone?.[0] });
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="ap-panel ap-form" aria-busy={busy} noValidate>
      <h2 className="ap-h2">Edit profile</h2>
      {error && <p role="alert" className="ap-alert">{error}</p>}
      <Field id="p-name" label="Full name" required maxLength={PROFILE_NAME_MAX} autoComplete="name" value={fullName} onChange={setFullName} error={errors.fullName} />
      <Field id="p-phone" label="Phone (optional)" type="tel" inputMode="tel" maxLength={PROFILE_PHONE_MAX} autoComplete="tel" value={phone} onChange={setPhone} error={errors.phone} hint="Leave blank to remove it." />
      <Field id="p-email" label="Email" value={profile.email} onChange={() => undefined} readOnly disabled hint="Your sign-in email cannot be changed here." />
      <div className="ap-row" style={{ justifyContent: 'flex-start' }}>
        <button className="ap-btn" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        <Link href="/account" className="ap-btn ap-btn-quiet" style={{ textDecoration: 'none' }}>Cancel</Link>
      </div>
    </form>
  );
}
