'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import { ApiError, messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import type { Role } from '@/lib/staff-types';
import { groupPermissions, isOwnerRole, sameSet } from '@/lib/team';
import { Field } from './Field';
import { PermissionPicker } from './PermissionPicker';
import { Pager, usePaged } from './Pager';

function RoleCard({ role, available, editable }: { role: Role; available: string[]; editable: boolean }) {
  const router = useRouter();
  const [draft, setDraft] = useState(role.permissions);
  const [busy, setBusy] = useState(false);
  const locked = isOwnerRole(role);
  const dirty = !sameSet(draft, role.permissions);

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      await api<Role>(`/api/roles/${role.id}/permissions`, { method: 'PUT', json: { permissions: draft } });
      toast.success(`${role.name} permissions saved.`);
      router.refresh();
    } catch (err) {
      toast.error(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ap-panel" aria-labelledby={`role-${role.id}`}>
      <h3 id={`role-${role.id}`} className="ap-h2">{role.name}{role.isSystem && <span className="ap-badge">Built in</span>}</h3>
      {locked ? (
        <p className="ap-hint">The Owner role holds every permission and cannot be edited or assigned. Use ownership transfer to hand the business to someone else.</p>
      ) : editable ? (
        <>
          <PermissionPicker idPrefix={`role-${role.id}`} available={available} selected={draft} onChange={setDraft} disabled={busy} />
          <div className="ap-row" style={{ marginTop: '1rem' }}>
            <button type="button" className="ap-btn" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save permissions'}</button>
          </div>
        </>
      ) : (
        <ul className="ap-chips" role="list">
          {role.permissions.length === 0 && <li className="ap-hint">No permissions.</li>}
          {groupPermissions(role.permissions).flatMap((g) => g.items.map((i) => <li key={i.permission}>{g.label}: {i.label}</li>))}
        </ul>
      )}
    </section>
  );
}

function NewRole({ available }: { available: string[] }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [perms, setPerms] = useState<string[]>([]);
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setFields({});
    try {
      await api<Role>('/api/roles', { method: 'POST', json: { name: name.trim(), permissions: perms } });
      setName(''); setPerms([]);
      toast.success('Role created.');
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) setFields(err.fields);
      toast.error(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="ap-panel ap-form" aria-busy={busy}>
      <h2 className="ap-h2">New role</h2>
      <Field id="role-name" label="Role name" required minLength={2} maxLength={60} value={name} onChange={setName} error={fields.name?.[0]} />
      <PermissionPicker idPrefix="new-role" available={available} selected={perms} onChange={setPerms} disabled={busy} />
      <div><button className="ap-btn" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create role'}</button></div>
    </form>
  );
}

/** `available` is null when the viewer may see roles but not edit them. */
export function RoleManager({ roles, available }: { roles: Role[]; available: string[] | null }) {
  const paged = usePaged(roles, 6);
  return (
    <div className="ap-stack">
      {available && <NewRole available={available} />}
      {paged.slice.map((r) => (
        <RoleCard key={`${r.id}:${r.permissions.join(',')}`} role={r} available={available ?? []} editable={available !== null} />
      ))}
      <Pager page={paged.page} pages={paged.pages} total={paged.total} size={paged.size} onPage={paged.setPage} label="Roles pages" />
    </div>
  );
}
