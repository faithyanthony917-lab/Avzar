export interface AuditEntry {
  id: string;
  createdAtUtc: string;
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  detailsJson: unknown;
}

export interface AuditPage {
  items: AuditEntry[];
  page: number;
  pageSize: number;
  totalCount: number;
}

/** Render audit metadata safely without exposing a JSON parsing error to the page. */
export function auditDetailsText(details: unknown): string {
  if (details == null || details === '') return '—';
  if (typeof details === 'string') {
    try {
      const parsed: unknown = JSON.parse(details);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return details;
    }
  }
  try {
    return JSON.stringify(details, null, 2) ?? '—';
  } catch {
    return 'Details unavailable';
  }
}

export function auditPageCount(totalCount: number, pageSize: number): number {
  if (!Number.isFinite(totalCount) || totalCount <= 0 || !Number.isSafeInteger(pageSize) || pageSize <= 0) return 0;
  return Math.ceil(totalCount / pageSize);
}
