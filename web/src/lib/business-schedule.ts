export interface BusinessDayHours {
  dayOfWeek: number;
  isOpen: boolean;
  opensAt: string | null;
  closesAt: string | null;
}

/** Client-side guard only; the API repeats this validation before persisting hours. */
export function isValidBusinessWeek(days: readonly BusinessDayHours[]): boolean {
  if (days.length !== 7) return false;
  const seen = new Set<number>();
  for (const day of days) {
    if (!Number.isInteger(day.dayOfWeek) || day.dayOfWeek < 0 || day.dayOfWeek > 6 || seen.has(day.dayOfWeek)) return false;
    seen.add(day.dayOfWeek);
    if (!day.isOpen) {
      if (day.opensAt !== null || day.closesAt !== null) return false;
      continue;
    }
    if (!day.opensAt || !day.closesAt || !/^\d{2}:\d{2}(?::\d{2})?$/.test(day.opensAt) || !/^\d{2}:\d{2}(?::\d{2})?$/.test(day.closesAt)) return false;
    if (day.opensAt.slice(0, 5) >= day.closesAt.slice(0, 5)) return false;
  }
  return seen.size === 7;
}

export function normalizeTimeInput(value: string | null): string {
  return value ? value.slice(0, 5) : '';
}
