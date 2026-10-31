'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { CurrentUser } from '@/lib/auth-types';
import { api } from '@/lib/client';
import { ApiError, messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import type { Invitation, Location, Role, StaffMember } from '@/lib/staff-types';
import { avatarTone, initials } from '@/lib/people-view';
import { assignableRoles, roleNames, sameSet, toggle } from '@/lib/team';
import { Field } from './Field';
import { Pager, usePaged } from './Pager';

interface Props { me: CurrentUser; staff: StaffMember[]; roles: Role[]; locations: Location[]; canManage: boolean }

function RoleLocationPickers(props: {
  idPrefix: string; roles: Role[]; locations: Location[];
  roleIds: string[]; locationIds: string[];
  onRoles: (v: string[]) => void; onLocations: (v: string[]) => void;
}) {
  const { idPrefix, roles, locations, roleIds, locationIds, onRoles, onLocations } = props;
  return (
    <>
      <fieldset className="ap-fieldset">
        <legend>Roles (at least one)</legend>
        {assignableRoles(roles).map((r) => (
          <div key={r.id} className="ap-check">
            <input id={`${idPrefix}-r-${r.id}`} type="checkbox" checked={roleIds.includes(r.id)} onChange={(e) => onRoles(toggle(roleIds, r.id, e.target.checked))} />
            <label htmlFor={`${idPrefix}-r-${r.id}`}>{r.name}</label>
          </div>
        ))}
      </fieldset>
      <fieldset className="ap-fieldset">
        <legend>Locations</legend>
        {locations.filter((l) => l.isActive).map((l) => (
          <div key={l.id} className="ap-check">
            <input id={`${idPrefix}-l-${l.id}`} type="checkbox" checked={locationIds.includes(l.id)} onChange={(e) => onLocations(toggle(locationIds, l.id, e.target.checked))} />
            <label htmlFor={`${idPrefix}-l-${l.id}`}>{l.name}</label>
          </div>
        ))}
        <p className="ap-hint">Without a location, staff see no orders or fittings unless their role includes the &ldquo;locations all&rdquo; permission.</p>
      </fieldset>
    </>
  );
}

function InvitePanel({ roles, locations }: { roles: Role[]; locations: Location[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null); setFields({});
    if (roleIds.length === 0) { setError('Choose at least one role.'); return; }
    setBusy(true);
    try {
      const inv = await api<Invitation>('/api/staff/invitations', { method: 'POST', json: { email: email.trim(), fullName: fullName.trim(), roleIds, locationIds } });
      toast.success(`Invitation sent to ${inv.email}. It expires ${new Date(inv.expiresAtUtc).toLocaleString()}.`);
      setFullName(''); setEmail(''); setRoleIds([]); setLocationIds([]); setOpen(false);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) setFields(err.fields);
      toast.error(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ap-panel" aria-labelledby="invite-h">
      <div className="ap-row">
        <h2 id="invite-h" className="ap-h2">Invite someone</h2>
        {!open && <button type="button" className="ap-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setOpen(true)}><svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M12 5v14" /></svg>Invite teammate</button>}
      </div>
      {open && (
        <form onSubmit={submit} className="ap-form" aria-busy={busy}>
          {error && <p role="alert" className="ap-alert">{error}</p>}
          <Field id="inv-name" label="Full name" required minLength={2} maxLength={120} value={fullName} onChange={setFullName} error={fields.fullName?.[0]} />
          <Field id="inv-email" label="Email" type="email" required maxLength={256} value={email} onChange={setEmail} error={fields.email?.[0]} />
          <RoleLocationPickers idPrefix="inv" roles={roles} locations={locations} roleIds={roleIds} locationIds={locationIds} onRoles={setRoleIds} onLocations={setLocationIds} />
          <div className="ap-row">
            <button className="ap-btn" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send invitation'}</button>
            <button className="ap-btn ap-btn-quiet" type="button" onClick={() => { setOpen(false); setError(null); }} disabled={busy}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}

function MemberRow({ member, me, roles, locations, canManage }: { member: StaffMember; me: CurrentUser; roles: Role[]; locations: Location[]; canManage: boolean }) {
  const router = useRouter();
  const activeIds = new Set(locations.filter((l) => l.isActive).map((l) => l.id));
  const origLocations = member.locationIds.filter((id) => activeIds.has(id));
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [roleIds, setRoleIds] = useState(member.roleIds);
  const [locationIds, setLocationIds] = useState(origLocations);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSelf = member.userId === me.userId;
  const deactivated = member.status === 'Deactivated';
  const locName = new Map(locations.map((l) => [l.id, l.name]));
  const locs = member.locationIds.map((id) => locName.get(id)).filter(Boolean).join(', ');

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(null);
    try { await fn(); router.refresh(); } catch (err) { toast.error(messageFor(err)); } finally { setBusy(false); }
  }

  async function save() {
    if (roleIds.length === 0) { setError('Choose at least one role.'); return; }
    await run(async () => {
      if (!sameSet(roleIds, member.roleIds)) await api(`/api/staff/${member.membershipId}/roles`, { method: 'PUT', json: { roleIds } });
      if (!sameSet(locationIds, origLocations)) await api(`/api/staff/${member.membershipId}/locations`, { method: 'PUT', json: { locationIds } });
      setEditing(false);
      toast.success(`Access updated for ${member.displayName}.`);
    });
  }

  const setStatus = (action: 'deactivate' | 'reactivate') => run(async () => {
    await api(`/api/staff/${member.membershipId}/${action}`, { method: 'POST' });
    setConfirming(false);
    toast.success(action === 'deactivate' ? `${member.displayName} was deactivated.` : `${member.displayName} was reactivated.`);
  });

  return (
    <>
      <tr className={deactivated ? 'ap-dim' : undefined}>
        <td><div className="ap-person"><span className={`ap-av ap-av-${avatarTone(member.displayName)}`} aria-hidden="true">{initials(member.displayName)}</span><div><strong>{member.displayName}</strong>{isSelf && <span className="ap-badge">You</span>}<br /><span className="ap-hint">{member.email}</span></div></div></td>
        <td>{member.isOwner ? 'Studio owner' : (roleNames(member.roleIds, roles).join(', ') || '—')}</td>
        <td>{member.isOwner ? 'Full access' : (locs || '—')}</td>
        <td><span className={`ap-badge ap-st ${deactivated ? 'ap-st-Cancelled' : 'ap-st-Ready'}`}>{member.status}</span></td>
        {canManage && (
          <td>
            {!member.isOwner && (
              <div className="ap-actions">
                {!deactivated && <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" onClick={() => { setEditing(!editing); setConfirming(false); setError(null); }} aria-expanded={editing}>Edit access</button>}
                {deactivated && <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" onClick={() => setStatus('reactivate')} disabled={busy}>Reactivate</button>}
                {!deactivated && !isSelf && !confirming && <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" onClick={() => { setConfirming(true); setEditing(false); }}>Deactivate</button>}
                {confirming && (
                  <>
                    <button type="button" className="ap-btn ap-btn-danger ap-btn-sm" onClick={() => setStatus('deactivate')} disabled={busy}>Confirm deactivate</button>
                    <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
                  </>
                )}
              </div>
            )}
          </td>
        )}
      </tr>
      {(editing || error) && (
        <tr>
          <td colSpan={canManage ? 5 : 4}>
            {error && <p role="alert" className="ap-alert">{error}</p>}
            {editing && (
              <div className="ap-form">
                <RoleLocationPickers idPrefix={`m-${member.membershipId}`} roles={roles} locations={locations} roleIds={roleIds} locationIds={locationIds} onRoles={setRoleIds} onLocations={setLocationIds} />
                <div className="ap-row">
                  <button type="button" className="ap-btn" onClick={save} disabled={busy || (sameSet(roleIds, member.roleIds) && sameSet(locationIds, origLocations))}>{busy ? 'Saving…' : 'Save access'}</button>
                  <button type="button" className="ap-btn ap-btn-quiet" onClick={() => { setEditing(false); setRoleIds(member.roleIds); setLocationIds(origLocations); setError(null); }} disabled={busy}>Cancel</button>
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function OwnershipTransferPanel({ staff }: { staff: StaffMember[] }) {
  const [targetId, setTargetId] = useState('');
  const [password, setPassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const candidates = staff.filter((m) => m.status === 'Active' && !m.isOwner);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !targetId) return;
    setBusy(true); setSent(false);
    try {
      await api<{ status: string }>('/api/business/ownership-transfer', { method: 'POST', json: {
        newOwnerMembershipId: targetId, password: password,
        twoFactorCode: twoFactorCode.trim() || undefined, recoveryCode: recoveryCode.trim() || undefined,
      } });
      setSent(true); setPassword(''); setTwoFactorCode(''); setRecoveryCode('');
    } catch (err) { toast.error(messageFor(err)); }
    finally { setBusy(false); }
  }

  return <section className="ap-panel ap-stack" aria-labelledby="ownership-transfer-heading">
    <h2 id="ownership-transfer-heading" className="ap-h2">Transfer business ownership</h2>
    <p className="ap-foot">This does not transfer ownership immediately. After you re-enter your password, Avzar emails you a one-time confirmation link that expires in 30 minutes. The transfer occurs only after you open that link while signed in and confirm.</p>
    {sent && <p role="status" className="ap-ok">Confirmation email queued. Ownership has not changed. Open the link sent to your account email to finish the transfer.</p>}
    {candidates.length === 0 ? <p className="ap-hint">There are no other active staff members to transfer ownership to.</p> : <form className="ap-form" onSubmit={submit}>
      <div className="ap-field"><label htmlFor="ownership-target">New owner</label><select id="ownership-target" className="ap-input" required value={targetId} disabled={busy} onChange={(e) => setTargetId(e.target.value)}><option value="">Choose an active staff member</option>{candidates.map((m) => <option key={m.membershipId} value={m.membershipId}>{m.displayName} · {m.email}</option>)}</select></div>
      <div className="ap-field"><label htmlFor="ownership-password">Your password</label><input id="ownership-password" className="ap-input" type="password" autoComplete="current-password" required maxLength={128} value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} /></div>
      <div className="ap-field"><label htmlFor="ownership-2fa">Authenticator code (if enabled)</label><input id="ownership-2fa" className="ap-input" inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={twoFactorCode} disabled={busy} onChange={(e) => setTwoFactorCode(e.target.value)} /></div>
      <div className="ap-field"><label htmlFor="ownership-recovery">Recovery code (instead of authenticator code)</label><input id="ownership-recovery" className="ap-input" autoComplete="off" maxLength={80} value={recoveryCode} disabled={busy} onChange={(e) => setRecoveryCode(e.target.value)} /></div>
      <button className="ap-btn ap-btn-danger" type="submit" disabled={busy || !targetId || !password.trim()}>{busy ? 'Requesting confirmation…' : 'Email confirmation link'}</button>
    </form>}
  </section>;
}

export function TeamView({ me, staff, roles, locations, canManage }: Props) {
  const paged = usePaged(staff);
  const activeStaff = staff.filter((m) => m.status === 'Active').length;
  const pending = staff.length - activeStaff;
  const activeLocs = locations.filter((l) => l.isActive);
  const pad = (n: number) => String(n).padStart(2, '0');
  const home = activeLocs[0];
  return (
    <div className="ap-stack">
      <ul className="ap-team-top" aria-label="Team summary">
        <li className="ap-team-card"><span>Team members</span><strong>{pad(staff.length)}</strong><small>{activeStaff} active{pending > 0 ? ` · ${pending} deactivated` : ''}</small></li>
        <li className="ap-team-card"><span>Studio locations</span><strong>{pad(activeLocs.length)}</strong><small>{home ? home.name : 'No location yet'}</small></li>
      </ul>
      {canManage && <InvitePanel roles={roles} locations={locations} />}
      <section className="ap-panel ap-table-panel" aria-labelledby="team-h">
        <div className="ap-team-intro">
          <div>
            <h2 id="team-h">Good work is a team effort.</h2>
            <p>Manage studio roles, permissions and locations.</p>
          </div>
          <Link href="/staff/roles" className="ap-btn ap-btn-quiet ap-btn-sm" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}><svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></svg>Roles &amp; permissions</Link>
        </div>
        <div className="ap-scroll">
          <table className="ap-table">
            <thead><tr><th>Team member</th><th>Role</th><th>Access</th><th>Status</th>{canManage && <th><span className="ap-sr">Actions</span></th>}</tr></thead>
            <tbody>
              {paged.slice.map((m) => (
                <MemberRow key={`${m.membershipId}:${m.status}:${m.roleIds.join(',')}:${m.locationIds.join(',')}`} member={m} me={me} roles={roles} locations={locations} canManage={canManage} />
              ))}
            </tbody>
          </table>
        </div>
        <Pager page={paged.page} pages={paged.pages} total={paged.total} size={paged.size} onPage={paged.setPage} label="Team pages" />
      </section>
      {home && (
        <section className="ap-panel ap-team-location" aria-label="Studio location">
          <span className="ap-team-location-icon" aria-hidden="true">
            <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5" /><path d="M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244" /><path d="M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05" /></svg>
          </span>
          <div className="ap-grow"><strong>{home.name}</strong><span>{[home.address, me.timeZoneId].filter(Boolean).join(' · ')}</span></div>
          <Link href="/staff/locations" className="ap-tasklink" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>Manage location<svg aria-hidden="true" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg></Link>
        </section>
      )}
      {me.isOwner && <OwnershipTransferPanel staff={staff} />}
    </div>
  );
}
