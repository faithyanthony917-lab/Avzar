export type LeaveInterval = { startsAtUtc: string | Date; endsAtUtc: string | Date; status: string };

function timestamp(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export function validLeaveInterval(start: string | Date, end: string | Date): boolean {
  const from = timestamp(start);
  const to = timestamp(end);
  return Number.isFinite(from) && Number.isFinite(to) && to > from;
}

export function intervalsOverlap(aStart: string | Date, aEnd: string | Date, bStart: string | Date, bEnd: string | Date): boolean {
  const a0 = timestamp(aStart); const a1 = timestamp(aEnd);
  const b0 = timestamp(bStart); const b1 = timestamp(bEnd);
  if (![a0, a1, b0, b1].every(Number.isFinite) || a1 <= a0 || b1 <= b0) return false;
  return a0 < b1 && b0 < a1;
}

export function canReviewLeave(status: string): boolean {
  return status.toLowerCase() === 'pending';
}
