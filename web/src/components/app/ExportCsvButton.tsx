'use client';

import { useState } from 'react';
import { downloadExport } from '@/lib/csv-export';
import { messageFor } from '@/lib/problem';

/** Downloads a CSV export of the list the person is looking at. `query` is the screen's current filter string. */
export function ExportCsvButton({ path, query = '', fileName, label = 'Export CSV' }: { path: string; query?: string; fileName: string; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      await downloadExport(path, query, fileName);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="ap-stack" style={{ display: 'inline-flex', gap: '.25rem' }}>
      <button type="button" className="ap-btn ap-btn-quiet" disabled={busy} onClick={() => void run()}>{busy ? 'Preparing file…' : label}</button>
      {error && <span role="alert" className="ap-foot">{error}</span>}
    </span>
  );
}
