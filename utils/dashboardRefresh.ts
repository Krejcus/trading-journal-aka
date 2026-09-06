/** A row ID does not represent its contents. Preserve React identity only when
 * the entire returned data is unchanged, or a local edit is still pending. */
export function reconcileDashboardRows<T>(previous: T[], incoming: T[] | undefined | null, dirty = false): T[] {
  if (dirty) return previous;
  const next = incoming ?? [];
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}
