// Step 17b: shapes returned by the platform-admin routes, and small display helpers (fixed UTC so a page reads the same for everyone).
export type PlatformBusiness = { id: string; name: string; contactEmail: string | null; currencyCode: string; timeZoneId: string; isActive: boolean; createdAtUtc: string };
export type PlatformBusinessPage = { items: PlatformBusiness[]; next: string | null };
export type PlatformBusinessDetail = PlatformBusiness & {
  updatedAtUtc: string | null;
  suspendedAtUtc?: string | null;
  suspendedReason?: string | null;
  owner: { email: string; fullName: string } | null;
  plan: { code: string; name: string; status: string; currentPeriodEndUtc: string | null } | null;
  usage: { activeStaff: number; locations: number; customers: number; orders: number; ordersLast30Days: number; invoices: number; storageBytes: number };
};
export type PlatformUser = {
  id: string; email: string; fullName: string; emailConfirmed: boolean; twoFactorEnabled: boolean; lockedUntilUtc: string | null; failedSignIns: number; createdAtUtc: string;
  memberships: { id: string; businessId: string; businessName: string; businessActive: boolean; isOwner: boolean; active: boolean; displayName: string }[];
};
export type PlatformAuditEntry = { id: string; actorEmail: string; action: string; entityType: string; entityId: string | null; details: Record<string, unknown>; createdAtUtc: string };
export type PlatformAuditPage = { items: PlatformAuditEntry[]; next: string | null };
export type PlatformHealth = {
  checkedAtUtc: string;
  process: { nodeVersion: string; uptimeSeconds: number; environment: string | null; emailProvider: string | null; storageProvider: string | null };
  database: { ok: boolean; pingMs: number | null };
  migrations: { applied: number; latest: string | null } | null;
  queues: { kind: string; statuses: Record<string, number> }[] | null;
  configuration: { key: string; label: string; set: boolean }[];
};

export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024; let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

export function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86400); const h = Math.floor((seconds % 86400) / 3600); const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
