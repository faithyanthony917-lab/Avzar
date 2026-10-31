/** The API sends UTC instants; some serialisers drop the trailing Z. Treat a bare timestamp as UTC. */
function parse(iso: string): Date | null {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso);
  const d = new Date(hasZone ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmt(iso: string, timeZone: string, opts: Intl.DateTimeFormatOptions): string {
  const d = parse(iso);
  if (!d) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(d); // unknown zone id: fall back to UTC
  }
}

/** Dates are shown in the business's time zone. Run on the server so server and browser markup always agree. */
export const formatDate = (iso: string, timeZone: string) => fmt(iso, timeZone, { dateStyle: 'medium' });
export const formatDateTime = (iso: string, timeZone: string) => fmt(iso, timeZone, { dateStyle: 'medium', timeStyle: 'short' });
