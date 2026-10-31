'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import { ApiError, messageFor } from '@/lib/problem';
import type { Location } from '@/lib/staff-types';
import { Field } from './Field';
import { Pager, usePaged } from './Pager';
import { toast } from '@/lib/toast';

export function LocationManager({ locations, canManage }: { locations: Location[]; canManage: boolean }) {
  const router = useRouter();
  const paged = usePaged(locations);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setFields({});
    try {
      await api<Location>('/api/locations', { method: 'POST', json: { name: name.trim(), address: address.trim() || undefined } });
      setName(''); setAddress('');
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) setFields(err.fields);
      toast.error(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ap-stack">
      {canManage && (
        <form onSubmit={submit} className="ap-panel ap-form" aria-busy={busy}>
          <h2 className="ap-h2">Add a location</h2>
          <Field id="loc-name" label="Name" required minLength={2} maxLength={120} value={name} onChange={setName} error={fields.name?.[0]} />
          <Field id="loc-address" label="Address (optional)" maxLength={500} value={address} onChange={setAddress} error={fields.address?.[0]} />
          <div><button className="ap-btn" type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add location'}</button></div>
        </form>
      )}
      <section className="ap-panel" aria-labelledby="loc-h">
        <h2 id="loc-h" className="ap-h2">Locations ({locations.length})</h2>
        <div className="ap-scroll">
          <table className="ap-table">
            <thead><tr><th>Name</th><th>Address</th><th>Status</th></tr></thead>
            <tbody>
              {paged.slice.map((l) => (
                <tr key={l.id} className={l.isActive ? undefined : 'ap-dim'}>
                  <td><strong>{l.name}</strong></td>
                  <td>{l.address || '—'}</td>
                  <td><span className={l.isActive ? 'ap-badge ap-badge-on' : 'ap-badge ap-badge-off'}>{l.isActive ? 'Active' : 'Inactive'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager page={paged.page} pages={paged.pages} total={paged.total} size={paged.size} onPage={paged.setPage} label="Locations pages" />
      </section>
    </div>
  );
}
