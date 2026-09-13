export interface NetworkTradeRow {
  id: string;
  user_id: string;
  account_id: string;
  data?: { groupId?: string | null; [key: string]: unknown };
  [key: string]: unknown;
}

/** Expand only explicit groups found in the recent page. Exact count and rows
 * come from one response; a row cap must fail instead of claiming fewer copies. */
export async function completeNetworkTradeGroups<T extends NetworkTradeRow>(
  recent: readonly T[],
  readGroup: (owner: string, groupId: string) => Promise<{ data: T[] | null; count: number | null; error?: unknown }>,
  stillCurrent: () => boolean | Promise<boolean>,
): Promise<T[]> {
  const keys = new Map<string, [string, string]>();
  const standalone: T[] = [];
  for (const row of recent) {
    const group = row.data?.groupId;
    if (typeof group === 'string' && group && row.user_id) keys.set(JSON.stringify([row.user_id, group]), [row.user_id, group]);
    else standalone.push(row);
  }
  const scopes = [...keys.values()];
  const expanded: T[] = [];
  for (let offset = 0; offset < scopes.length; offset += 4) {
    if (!await stillCurrent()) throw new Error('network-session-changed');
    const batch = scopes.slice(offset, offset + 4);
    const responses = await Promise.all(batch.map(([owner, group]) => readGroup(owner, group)));
    for (let index = 0; index < responses.length; index++) {
      const { data, count, error } = responses[index];
      const [owner, group] = batch[index];
      if (error || !Array.isArray(data) || count === null || data.length !== count || count > 1000
        || new Set(data.map(row => row.id)).size !== data.length
        || data.some(row => !row.id || row.user_id !== owner || row.data?.groupId !== group)) {
        throw new Error('network-copy-group-incomplete');
      }
      expanded.push(...data);
    }
  }
  if (!await stillCurrent()) throw new Error('network-session-changed');
  return [...standalone, ...expanded];
}
