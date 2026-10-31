import { type PlatformHealth, uptime, when } from '@/lib/platformAdmin';

export function PlatformHealthReport({ report: r }: { report: PlatformHealth }) {
  return (
    <div className="ap-stack">
      <section className="ap-panel ap-stack">
        <h2 className="ap-h2">This server</h2>
        <p className="ap-foot">Checked {when(r.checkedAtUtc)}. Uptime restarts when the service sleeps or is redeployed.</p>
        <dl className="ap-stack" style={{ margin: 0 }}>
          <div><dt>Database</dt><dd>{r.database.ok ? `Reachable (${r.database.pingMs} ms)` : 'Not reachable'}</dd></div>
          <div><dt>Migrations</dt><dd>{r.migrations ? `${r.migrations.applied} applied, latest ${r.migrations.latest ?? '—'}` : 'Not readable by the API role'}</dd></div>
          <div><dt>Environment</dt><dd>{r.process.environment ?? '—'}, Node {r.process.nodeVersion}, up {uptime(r.process.uptimeSeconds)}</dd></div>
          <div><dt>Email and storage</dt><dd>Email: {r.process.emailProvider ?? '—'}. Storage: {r.process.storageProvider ?? '—'}.</dd></div>
        </dl>
      </section>
      <section className="ap-panel ap-stack">
        <h2 className="ap-h2">Queues, all businesses</h2>
        {r.queues === null ? <p>Queue depth could not be read.</p> : (
          <div className="ap-scroll"><table className="ap-table">
            <thead><tr><th>Queue</th><th>Counts by status</th></tr></thead>
            <tbody>{r.queues.map((q) => {
              const parts = Object.entries(q.statuses);
              return <tr key={q.kind}><td>{q.kind}</td><td>{parts.length ? parts.map(([s, n]) => `${s} ${n}`).join(', ') : 'Empty'}</td></tr>;
            })}</tbody>
          </table></div>
        )}
        <a className="ap-btn ap-btn-quiet" href="/platform-admin/operations">Failed jobs and retries</a>
      </section>
      <section className="ap-panel ap-stack">
        <h2 className="ap-h2">Settings present</h2>
        <p className="ap-foot">Shows only whether a setting exists, never its value. A shown “Not set” may be intended.</p>
        <div className="ap-scroll"><table className="ap-table"><tbody>
          {r.configuration.map((c) => <tr key={c.key}><th scope="row">{c.label}</th><td>{c.set ? 'Set' : 'Not set'}</td></tr>)}
        </tbody></table></div>
      </section>
    </div>
  );
}
