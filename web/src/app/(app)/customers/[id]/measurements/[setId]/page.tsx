import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHead } from '@/components/app/PageHead';
import { LoadError, NoAccess } from '@/components/app/Notices';
import type { Customer } from '@/lib/customer-types';
import { formatDateTime } from '@/lib/dates';
import type { MeasurementDiffRow, MeasurementRevision, MeasurementSet } from '@/lib/measurement-types';
import { diffKind, formatDelta, formatValue, parseRevisionNumber, resolveCompare } from '@/lib/measurement-view-model';
import { getSession, serverGet } from '@/lib/session';
import { can } from '@/lib/team';

export const metadata = { title: 'Measurements · Avzar' };
export const dynamic = 'force-dynamic';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Query = Record<string, string | string[] | undefined>;

export default async function MeasurementProfilePage({ params, searchParams }: { params: Promise<{ id: string; setId: string }>; searchParams: Promise<Query> }) {
  const { id, setId } = await params;
  const query = await searchParams;
  if (!GUID.test(id) || !GUID.test(setId)) notFound();
  const me = (await getSession())!;
  if (!can(me, 'customers.view')) return <NoAccess />;

  const [cust, sets, history] = await Promise.all([
    serverGet<Customer>(`/api/customers/${id}`),
    serverGet<MeasurementSet[]>(`/api/customers/${id}/measurements`),
    serverGet<MeasurementRevision[]>(`/api/measurement-sets/${setId}/history`),
  ]);
  if (!cust.ok) { if (cust.status === 404) notFound(); return <LoadError status={cust.status} />; }
  if (!sets.ok) return <LoadError status={sets.status} />;
  const set = sets.data.find((s) => s.id === setId);
  if (!set) notFound(); // the profile does not belong to this customer
  if (!history.ok) return <LoadError status={history.status} />;

  const revisions = [...history.data].sort((a, b) => b.revisionNumber - a.revisionNumber);
  const selection = resolveCompare(revisions.map((r) => r.revisionNumber), query.from, query.to);
  let diff: MeasurementDiffRow[] | null = null;
  let diffFailed: number | null = null;
  if (selection) {
    const res = await serverGet<MeasurementDiffRow[]>(`/api/measurement-sets/${setId}/compare?from=${selection.from}&to=${selection.to}`);
    if (res.ok) diff = res.data; else diffFailed = res.status;
  }
  const asked = query.from !== undefined || query.to !== undefined;
  const adjusted = !!selection && asked && (parseRevisionNumber(query.from) !== selection.from || parseRevisionNumber(query.to) !== selection.to);
  const canRecord = can(me, 'measurements.record') && cust.data.status === 'Active';
  const tz = me.timeZoneId;
  const numbers = revisions.map((r) => r.revisionNumber).sort((a, b) => a - b);

  return (
    <>
      <PageHead title={set.label} zone={tz} back={<Link href={`/customers/${id}`}>← {cust.data.fullName}</Link>}>
        {canRecord && <Link href={`/customers/${id}/measurements/${setId}/revise`} className="ap-btn" style={{ textDecoration: 'none' }}>Record new revision</Link>}
      </PageHead>

      <div className="ap-stack">
        <section className="ap-panel" aria-labelledby="current-h">
          <h2 id="current-h" className="ap-h2">Current values</h2>
          <p className="ap-hint">{set.templateName} · revision {set.currentRevision} · updated {formatDateTime(set.updatedAtUtc, tz)}</p>
          {set.values.length === 0 ? <p className="ap-hint" style={{ margin: 0 }}>No values recorded.</p> : (
            <dl className="ap-dl">
              {set.values.map((v) => <div key={v.key} style={{ display: 'contents' }}><dt>{v.label}</dt><dd>{formatValue(v.value, v.unit)}</dd></div>)}
            </dl>
          )}
        </section>

        <section className="ap-panel" aria-labelledby="compare-h">
          <h2 id="compare-h" className="ap-h2">Compare revisions</h2>
          {!selection ? <p className="ap-hint" style={{ margin: 0 }}>Record another revision to compare changes.</p> : (
            <>
              <form method="get" className="ap-form">
                <div className="ap-grid2">
                  <div className="ap-field">
                    <label htmlFor="cmp-from">From</label>
                    <select id="cmp-from" name="from" defaultValue={String(selection.from)}>{numbers.map((n) => <option key={n} value={n}>Revision {n}</option>)}</select>
                  </div>
                  <div className="ap-field">
                    <label htmlFor="cmp-to">To</label>
                    <select id="cmp-to" name="to" defaultValue={String(selection.to)}>{numbers.map((n) => <option key={n} value={n}>Revision {n}</option>)}</select>
                  </div>
                </div>
                <div><button className="ap-btn ap-btn-quiet" type="submit">Compare</button></div>
              </form>
              {adjusted && (
                <p className="ap-hint" role="status">Choose two different revisions that exist. Showing revision {selection.from} against {selection.to}.</p>
              )}
              {diffFailed !== null && <LoadError status={diffFailed} />}
              {diff && (diff.length === 0 ? <p className="ap-hint">Neither revision has any values.</p> : (
                <div className="ap-scroll">
                  <table className="ap-table">
                    <caption className="ap-sr">Revision {selection.from} compared with revision {selection.to}</caption>
                    <thead><tr><th scope="col">Measurement</th><th scope="col">Rev {selection.from}</th><th scope="col">Rev {selection.to}</th><th scope="col">Change</th></tr></thead>
                    <tbody>
                      {diff.map((r) => {
                        const kind = diffKind(r);
                        return (
                          <tr key={r.key}>
                            <td>{r.label}{kind === 'added' && <div className="ap-hint">Added in revision {selection.to}</div>}{kind === 'removed' && <div className="ap-hint">Not in revision {selection.to}</div>}</td>
                            <td>{formatValue(r.from, r.unit)}</td>
                            <td>{formatValue(r.to, r.unit)}</td>
                            <td>{formatDelta(r.delta, r.unit)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            </>
          )}
        </section>

        <section className="ap-panel" aria-labelledby="history-h">
          <h2 id="history-h" className="ap-h2">History</h2>
          {revisions.length === 0 ? <p className="ap-hint" style={{ margin: 0 }}>No revisions found.</p> : (
            <ol className="ap-plain ap-log">
              {revisions.map((r) => (
                <li key={r.revisionNumber}>
                  <p style={{ margin: 0 }}><strong>Revision {r.revisionNumber}</strong>{r.revisionNumber === set.currentRevision && <> <span className="ap-badge ap-badge-on">Current</span></>} <span className="ap-hint">· {formatDateTime(r.recordedAtUtc, tz)}</span></p>
                  {r.notes && <p className="ap-pre" style={{ margin: '.15rem 0 0' }}>{r.notes}</p>}
                  <p className="ap-hint" style={{ margin: '.15rem 0 0' }}>{r.values.length === 0 ? 'No values' : r.values.map((v) => `${v.label} ${formatValue(v.value, v.unit)}`).join(' · ')}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </>
  );
}
