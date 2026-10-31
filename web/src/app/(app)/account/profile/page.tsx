import Link from 'next/link';
import { LoadError } from '@/components/app/Notices';
import { ProfileForm } from '@/components/app/ProfileForm';
import type { Profile } from '@/lib/profile-view-model';
import { serverGet } from '@/lib/session';

export const metadata = { title: 'Edit profile · Avzar' };
export const dynamic = 'force-dynamic';

/** Signed-in only. Every role can edit their own name and phone, so there is no business permission (accountRoutes.js). */
export default async function EditProfilePage() {
  const res = await serverGet<Profile>('/api/account/profile');
  if (!res.ok) return <LoadError status={res.status} />;
  return (
    <>
      <p style={{ margin: '0 0 .5rem' }}><Link href="/account">← Profile</Link></p>
      <h1>Edit profile</h1>
      <ProfileForm profile={res.data} />
    </>
  );
}
