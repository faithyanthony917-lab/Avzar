/** Immutable section reordering shared by pointer drag/drop and button controls. */
export function reorderItems<T>(items: readonly T[], from: number, to: number): T[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= items.length || to >= items.length) return [...items];
  if (from === to) return [...items];
  const result = [...items];
  const [moved] = result.splice(from, 1);
  if (moved !== undefined) result.splice(to, 0, moved);
  return result;
}
