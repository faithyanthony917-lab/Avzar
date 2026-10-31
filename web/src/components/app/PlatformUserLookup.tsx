import { type PlatformUser, when } from '@/lib/platformAdmin';

export function PlatformUserLookup({ email, user, message }: { email: string; user: PlatformUser | null; message: string | null }) {
  return (
    <div className="ap-stack">
      <section className="ap-panel ap-stack">
        <form method="get" action="/platform-admin/users" className="ap-row" role="search">
          <label className="ap-filter">Email address <input className="ap-input" type="email" name="email" defaultValue={email} maxLength={254} required /></label>
          <button type="submit" className="ap-btn">Find</button>
        </form>
        <p className="ap-foot">Each lookup is recorded in the audit log, without the address searched for.</p>
      </section>
      {message ? <div className="ap-panel" role="status"><p style={{ margin: 0 }}>{message}</p></div> : null}
      {user ? (
        <section className="ap-panel ap-stack" aria-label="Account">
          <h2 className="ap-h2">{user.fullName}</h2>
          <dl className="ap-stack" style={{ margin: 0 }}>
            <div><dt>Email</dt><dd>{user.email} ({user.emailConfirmed ? 'confirmed' : 'not confirmed'})</dd></div>
            <div><dt>Two-step sign-in</dt><dd>{user.twoFactorEnabled ? 'On' : 'Off'}</dd></div>
            <div><dt>Sign-in lock</dt><dd>{user.lockedUntilUtc ? `Locked until ${when(user.lockedUntilUtc)}` : 'Not locked'} ({user.failedSignIns} failed {user.failedSignIns === 1 ? 'attempt' : 'attempts'} on record)</dd></div>
            <div><dt>Account created</dt><dd>{when(user.createdAtUtc)}</dd></div>
          </dl>
          <h3 className="ap-h3">Businesses</h3>
          {user.memberships.length === 0 ? <p>This account belongs to no business.</p> : (
            <div className="ap-scroll"><table className="ap-table">
              <thead><tr><th>Business</th><th>Role</th><th>Membership</th></tr></thead>
              <tbody>{user.memberships.map((m) => (
                <tr key={m.id}>
                  <td><a href={`/platform-admin/businesses/${m.businessId}`}>{m.businessName}</a>{m.businessActive ? '' : ' (inactive)'}</td>
                  <td>{m.isOwner ? 'Owner' : 'Staff'}</td>
                  <td>{m.active ? 'Active' : 'Deactivated'}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      ) : null}
    </div>
  );
}
