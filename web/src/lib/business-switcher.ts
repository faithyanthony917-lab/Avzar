import type { BusinessMembership } from './auth-types';

/** Keeps only well-formed entries so a bad API payload can never render a broken switcher. */
export function normalizeMemberships(payload: unknown): BusinessMembership[] {
  const list = (payload as { businesses?: unknown } | null | undefined)?.businesses;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: BusinessMembership[] = [];
  for (const raw of list) {
    const item = raw as Partial<BusinessMembership> | null;
    if (!item || typeof item.businessId !== 'string' || !item.businessId || typeof item.businessName !== 'string') continue;
    if (seen.has(item.businessId)) continue;
    seen.add(item.businessId);
    out.push({ businessId: item.businessId, businessName: item.businessName, isOwner: item.isOwner === true, isCurrent: item.isCurrent === true });
  }
  return out;
}

/** The switcher is only worth showing when there is somewhere else to go. */
export function switchTargets(memberships: BusinessMembership[], currentBusinessId: string): BusinessMembership[] {
  return memberships.filter((m) => m.businessId !== currentBusinessId);
}
