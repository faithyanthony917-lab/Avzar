/** Says so when a list was cut at the API's limit, instead of letting the screen look complete. */
export function ListCapNotice({ shown, total, hint }: { shown: number; total: number; hint?: string }) {
  if (total <= shown) return null;
  return <p className="ap-hint" role="status">Showing the first {shown.toLocaleString()} of {total.toLocaleString()}. {hint ?? 'Narrow the list to see the rest.'}</p>;
}
