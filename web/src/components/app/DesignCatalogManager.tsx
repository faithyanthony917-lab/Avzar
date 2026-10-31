'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, apiUpload } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { downloadCsvRows } from '@/lib/csv-download';
import { bulkCatalogPayload, type CatalogBulkAction } from '@/lib/design-catalog';
import { toast } from '@/lib/toast';

type Design = { id: string; name: string; slug: string; kind: string; categoryName: string | null; basePrice: number | null; currencyCode: string | null; isFeatured: boolean; visibility: string; status: string; tags: string[] };
type Page = { items: Design[]; page: number; pageSize: number; totalCount: number };
type RowIssue = { row: number; field?: string | null; name: string | null; outcome: string; message: string | null };
type Preview = { fileHash: string; totalRows: number; validRows: number; duplicateRows: number; invalidRows: number; problems: RowIssue[] };
type ImportResult = { created: number; skipped: number; failed: number; rows: RowIssue[] };
type BulkAction = CatalogBulkAction;

export function DesignCatalogManager({ canManage }: { canManage: boolean }) {
  const [items, setItems] = useState<Design[]>([]);
  const [status, setStatus] = useState<'Active' | 'Archived'>('Active');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [action, setAction] = useState<BulkAction>('archive');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: '1', pageSize: '100', status });
      if (search.trim()) params.set('search', search.trim());
      const page = await api<Page>(`/api/designs?${params.toString()}`);
      setItems(page.items);
      setSelected((current) => current.filter((id) => page.items.some((item) => item.id === id)));
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setLoading(false);
    }
  }, [status, search]);

  useEffect(() => { void refresh(); }, [refresh]);

  function toggleSelected(id: string, checked: boolean) {
    setSelected((current) => checked ? [...new Set([...current, id])] : current.filter((value) => value !== id));
  }

  async function runBulk() {
    if (!selected.length) return;
    const body = bulkCatalogPayload(selected, action);
    setBusy(true); setError('');
    try {
      const response = await api<{ updated: number }>('/api/designs/bulk', { method: 'POST', json: body });
      toast.success(`${response.updated} design${response.updated === 1 ? '' : 's'} updated.`);
      setSelected([]);
      await refresh();
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }

  async function previewCsv() {
    if (!file) return;
    setBusy(true); setError(''); setResult(null);
    try { setPreview(await apiUpload<Preview>('/api/designs/import/preview', file)); }
    catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }

  async function commitCsv() {
    if (!file || !preview) return;
    setBusy(true); setError('');
    try {
      const imported = await apiUpload<ImportResult>('/api/designs/import/commit', file, { expectedHash: preview.fileHash, skipInvalidRows: String(skipInvalid) });
      setResult(imported);
      toast.success(`Import finished: ${imported.created} created, ${imported.skipped} skipped, ${imported.failed} failed.`);
      setFile(null); setPreview(null); setSelected([]);
      await refresh();
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }

  const allSelected = items.length > 0 && items.every((item) => selected.includes(item.id));
  return <div className="ap-stack">
    {error && <p className="ap-alert" role="alert">{error}</p>}
    
    {canManage && <details className="ap-panel ap-stack ap-collapse" open={!!(preview || result) || undefined}>
      <summary><h2 className="ap-h2">Import designs from CSV</h2></summary>
      <p className="ap-foot">Required column: Name. Optional columns: Description, Kind, Category, Garment Type, Base price, Production days, Featured, Tags, Fabrics, Colours and Sizes. Separate list values with semicolons. Imports create private, active designs; they never publish storefront content. Duplicate names are skipped.</p>
      <div className="ap-actions">
        <input className="ap-input" type="file" accept=".csv,text/csv" aria-label="Choose designs CSV" disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setResult(null); }} />
        <button className="ap-btn ap-btn-quiet" disabled={busy || !file} onClick={() => void previewCsv()}>Preview CSV</button>
      </div>
      {preview && <div className="ap-stack">
        <p>{preview.totalRows} rows · {preview.validRows} ready · {preview.duplicateRows} duplicate · {preview.invalidRows} invalid</p>
        {preview.problems.length > 0 && <><button className="ap-btn ap-btn-quiet ap-btn-sm" disabled={busy} onClick={()=>downloadCsvRows('design-import-errors.csv',['row','field','name','outcome','message'],preview.problems.map(r=>[r.row,r.field,r.name,r.outcome,r.message]))}>Download row report CSV</button><div className="ap-scroll"><table className="ap-table"><thead><tr><th>Row</th><th>Design</th><th>Field</th><th>Outcome</th><th>Details</th></tr></thead><tbody>{preview.problems.map((row) => <tr key={`${row.row}-${row.outcome}`}><td>{row.row}</td><td>{row.name ?? '—'}</td><td>{row.field ?? '—'}</td><td>{row.outcome}</td><td>{row.message ?? '—'}</td></tr>)}</tbody></table></div></>}
        <label className="ap-check"><input type="checkbox" checked={skipInvalid} disabled={busy} onChange={(event) => setSkipInvalid(event.target.checked)} /> Import valid rows and skip invalid rows</label>
        <button className="ap-btn" disabled={busy || preview.validRows === 0 || (preview.invalidRows > 0 && !skipInvalid)} onClick={() => void commitCsv()}>Confirm import</button>
      </div>}
      {result && <div className="ap-stack"><p className="ap-foot">Last import: {result.created} created, {result.skipped} skipped, {result.failed} failed.</p>{result.rows.some((row) => row.outcome === 'Invalid' || row.outcome === 'Failed') && <><button className="ap-btn ap-btn-quiet ap-btn-sm" onClick={()=>downloadCsvRows('design-import-results.csv',['row','field','name','outcome','message'],result.rows.filter(row=>row.outcome==='Invalid'||row.outcome==='Failed').map(r=>[r.row,r.field,r.name,r.outcome,r.message]))}>Download result CSV</button><div className="ap-scroll"><table className="ap-table"><thead><tr><th>Row</th><th>Design</th><th>Field</th><th>Outcome</th><th>Details</th></tr></thead><tbody>{result.rows.filter((row) => row.outcome === 'Invalid' || row.outcome === 'Failed').map((row) => <tr key={`${row.row}-${row.outcome}`}><td>{row.row}</td><td>{row.name ?? '—'}</td><td>{row.field ?? '—'}</td><td>{row.outcome}</td><td>{row.message ?? '—'}</td></tr>)}</tbody></table></div></>}</div>}
    </details>}

    <section className="ap-panel ap-stack">
      <div className="ap-row"><h2 className="ap-h2">Design catalog</h2><div className="ap-actions"><a className="ap-btn ap-btn-quiet ap-btn-sm" href={`/backend/api/designs/export?status=${encodeURIComponent(status)}${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ''}`}>Export CSV</a><button className="ap-btn ap-btn-quiet ap-btn-sm" onClick={() => void refresh()} disabled={busy || loading}>Refresh</button></div></div>
      <div className="ap-grid2"><div className="ap-field"><label htmlFor="catalog-status">Status</label><select id="catalog-status" className="ap-input" value={status} disabled={busy} onChange={(event) => setStatus(event.target.value as 'Active' | 'Archived')}><option value="Active">Active</option><option value="Archived">Archived</option></select></div><div className="ap-field"><label htmlFor="catalog-search">Search</label><input id="catalog-search" className="ap-input" value={search} maxLength={100} disabled={busy} onChange={(event) => setSearch(event.target.value)} placeholder="Name, description or garment type" /></div></div>
      {canManage && <div className="ap-stack"><div className="ap-actions"><label className="ap-check"><input type="checkbox" checked={allSelected} disabled={busy || items.length === 0} onChange={(event) => setSelected(event.target.checked ? items.map((item) => item.id) : [])} /> Select all on this page ({items.length})</label><span className="ap-foot">{selected.length} selected</span></div><div className="ap-actions"><select aria-label="Bulk catalog action" className="ap-input" value={action} disabled={busy || selected.length === 0} onChange={(event) => setAction(event.target.value as BulkAction)}><option value="archive">Archive</option><option value="activate">Activate</option><option value="make-public">Make public</option><option value="make-private">Make private</option><option value="feature">Feature</option><option value="unfeature">Remove featured</option></select><button className="ap-btn" disabled={busy || selected.length === 0} onClick={() => void runBulk()}>Apply to selected</button></div></div>}
      {loading && <p className="ap-foot" role="status">Loading catalog…</p>}
      {!loading && items.length === 0 && <p className="ap-foot">No designs match this view. Try another status or search, or import a CSV.</p>}
      {!loading && items.length > 0 && <div className="ap-scroll"><table className="ap-table"><thead><tr>{canManage && <th>Select</th>}<th>Name</th><th>Kind</th><th>Category</th><th>Base price</th><th>Visibility</th><th>Featured</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}>{canManage && <td><input type="checkbox" aria-label={`Select ${item.name}`} checked={selected.includes(item.id)} disabled={busy} onChange={(event) => toggleSelected(item.id, event.target.checked)} /></td>}<td><strong>{item.name}</strong><div className="ap-foot">{item.slug}</div></td><td>{item.kind}</td><td>{item.categoryName ?? '—'}</td><td>{item.basePrice == null ? '—' : `${item.currencyCode ?? ''} ${item.basePrice.toLocaleString()}`}</td><td>{item.visibility}</td><td>{item.isFeatured ? 'Yes' : 'No'}</td></tr>)}</tbody></table></div>}
      <p className="ap-foot">Showing up to 100 designs per view. Bulk actions affect only the selected designs in the current business. Public visibility requires an active design.</p>
    </section>
  </div>;
}
