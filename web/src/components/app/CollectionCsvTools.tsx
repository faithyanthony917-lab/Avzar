'use client';

import { useState } from 'react';
import { apiUpload } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { downloadCsvRows } from '@/lib/csv-download';
import { toast } from '@/lib/toast';

type RowIssue = { row: number; field?: string | null; name: string | null; outcome: string; message: string | null };
type Preview = { fileHash: string; totalRows: number; validRows: number; duplicateRows: number; invalidRows: number; problems: RowIssue[] };
type Result = { created: number; skipped: number; failed: number; rows: RowIssue[] };

export function CollectionCsvTools({ canManage }: { canManage: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [skipInvalid, setSkipInvalid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  
  async function previewCsv() {
    if (!file) return;
    setBusy(true); setError(''); setResult(null);
    try { setPreview(await apiUpload<Preview>('/api/collections/import/preview', file)); }
    catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }

  async function commitCsv() {
    if (!file || !preview) return;
    setBusy(true); setError('');
    try {
      const next = await apiUpload<Result>('/api/collections/import/commit', file, {
        expectedHash: preview.fileHash, skipInvalidRows: String(skipInvalid),
      });
      setResult(next);
      toast.success(`Import finished: ${next.created} created, ${next.skipped} skipped, ${next.failed} failed.`);
      setPreview(null); setFile(null);
    } catch (e) { toast.error(messageFor(e)); }
    finally { setBusy(false); }
  }

  return <details className="ap-panel ap-stack ap-collapse" open={!!(preview || result) || undefined}>
    <summary><h2 className="ap-h2">Import collections from CSV</h2></summary>
    <p className="ap-foot">Required column: Name. Optional columns: Description, Visibility (Private or Public), Sort Order. Existing names are reported as duplicates and are never overwritten. Maximum 1,000 rows per import.</p>
    {error && <p className="ap-alert" role="alert">{error}</p>}
    {canManage ? <>
      <div className="ap-actions">
        <input className="ap-input" type="file" accept=".csv,text/csv" aria-label="Choose collections CSV" disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setResult(null); }} />
        <button className="ap-btn ap-btn-quiet" disabled={busy || !file} onClick={() => void previewCsv()}>Preview CSV</button>
      </div>
      {preview && <div className="ap-stack">
        <p role="status">{preview.totalRows} rows: {preview.validRows} valid, {preview.duplicateRows} duplicates, {preview.invalidRows} invalid.</p>
        {preview.problems.length > 0 && <><button className="ap-btn ap-btn-quiet ap-btn-sm" disabled={busy} onClick={()=>downloadCsvRows('collection-import-errors.csv',['row','field','name','outcome','message'],preview.problems.map(r=>[r.row,r.field,r.name,r.outcome,r.message]))}>Download row report CSV</button><div className="ap-table-wrap"><table className="ap-table"><thead><tr><th>Row</th><th>Name</th><th>Field</th><th>Issue</th></tr></thead><tbody>{preview.problems.map((row) => <tr key={`${row.row}-${row.outcome}`}><td>{row.row}</td><td>{row.name || '—'}</td><td>{row.field || '—'}</td><td>{row.message || row.outcome}</td></tr>)}</tbody></table></div></>}
        <label className="ap-check"><input type="checkbox" checked={skipInvalid} disabled={busy} onChange={(event) => setSkipInvalid(event.target.checked)} /> Skip invalid and duplicate rows; import valid rows</label>
        <button className="ap-btn" disabled={busy || preview.validRows === 0 || (preview.problems.length > 0 && !skipInvalid)} onClick={() => void commitCsv()}>Import collections</button>
      </div>}
      {result && result.rows.length > 0 && <><button className="ap-btn ap-btn-quiet ap-btn-sm" onClick={()=>downloadCsvRows('collection-import-results.csv',['row','field','name','outcome','message'],result.rows.map(r=>[r.row,r.field,r.name,r.outcome,r.message]))}>Download result CSV</button><div className="ap-table-wrap"><h3 className="ap-h2">Import row report</h3><table className="ap-table"><thead><tr><th>Row</th><th>Name</th><th>Field</th><th>Result</th><th>Details</th></tr></thead><tbody>{result.rows.map((row) => <tr key={`${row.row}-${row.outcome}`}><td>{row.row}</td><td>{row.name || '—'}</td><td>{row.field || '—'}</td><td>{row.outcome}</td><td>{row.message || '—'}</td></tr>)}</tbody></table></div></>}
    </> : <p className="ap-foot">You need catalog management permission to import collections.</p>}
  </details>;
}
