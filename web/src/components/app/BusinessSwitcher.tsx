'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { BusinessMembership } from '@/lib/auth-types';
import { normalizeMemberships, switchTargets } from '@/lib/business-switcher';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';

/** Lets a user who belongs to several businesses move between them without signing out. Renders nothing for single-business users. */
export function BusinessSwitcher({ currentBusinessId }: { currentBusinessId: string }) {
  const router = useRouter();
  const [memberships, setMemberships] = useState<BusinessMembership[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  
  useEffect(() => {
    let alive = true;
    api<unknown>('/api/auth/businesses')
      .then((payload) => { if (alive) setMemberships(normalizeMemberships(payload)); })
      .catch((err) => { if (alive) setLoadError(messageFor(err)); });
    return () => { alive = false; };
  }, [currentBusinessId]);

  async function choose(businessId: string) {
    if (switchingTo) return;
    setSwitchingTo(businessId);
    try {
      await api('/api/auth/switch-business', { method: 'POST', json: { businessId } });
      router.replace('/dashboard');
      router.refresh();
    } catch (err) {
      toast.error(messageFor(err));
      setSwitchingTo(null);
    }
  }

  if (loadError) return <p role="alert" className="ap-alert">Could not load your businesses. {loadError}</p>;
  if (memberships === null) return <p className="ap-who" aria-live="polite">Loading businesses…</p>;
  const targets = switchTargets(memberships, currentBusinessId);
  if (targets.length === 0) return null;

  return (
    <section aria-label="Switch business" className="ap-switcher">
      <p className="ap-who">Switch business</p>
      <ul>
        {targets.map((m) => (
          <li key={m.businessId}>
            <button type="button" className="ap-link" onClick={() => choose(m.businessId)} disabled={switchingTo !== null} aria-busy={switchingTo === m.businessId}>
              {switchingTo === m.businessId ? 'Switching…' : m.businessName}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
