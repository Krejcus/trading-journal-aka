/** A row ID does not represent its contents. Preserve React identity only when
 * the entire returned data is unchanged, or a local edit is still pending. */
export function reconcileDashboardRows<T>(previous: T[], incoming: T[] | undefined | null, dirty = false): T[] {
  if (dirty) return previous;
  const next = incoming ?? [];
  // Delta sync vrací nezměněné obchody jako tytéž objekty: shodné reference
  // = shodný obsah, bez serializace 5–10 MB (na iPhonu stovky ms hlavního vlákna).
  if (previous.length === next.length && previous.every((row, index) => row === next[index])) return previous;
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}
