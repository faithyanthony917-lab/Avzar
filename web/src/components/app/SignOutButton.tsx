'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/client';

export function SignOutButton({ row = false }: { row?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function signOut() {
    if (busy) return;
    setBusy(true);
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* an expired session is already signed out */ }
    router.replace('/login');
    router.refresh();
  }
  if (row) {
    return (
      <button type="button" className="ap-signout-row" onClick={signOut} disabled={busy}>
        <span className="ap-xicon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M9 4H5v16h4M15 8l4 4-4 4M19 12H9" /></svg></span>
        <strong>{busy ? 'Signing out…' : 'Sign out'}</strong>
      </button>
    );
  }
  return <button type="button" className="ap-btn ap-btn-quiet" onClick={signOut} disabled={busy}>{busy ? 'Signing out…' : 'Sign out'}</button>;
}
