import type { Trade } from '../types.js';

export type NetworkTradeMember = Pick<Trade, 'id' | 'accountId' | 'date' | 'timestamp'>
  & Partial<Omit<Trade, 'id' | 'accountId' | 'date' | 'timestamp' | 'pnl'>>
  & { pnl: number | null; user_id: string; accountName?: string };
export interface NetworkTradeActivity {
  type: string;
  id: string | number;
  date: string;
  data: NetworkTradeMember;
  meta: { pnlFormat?: 'usd' | 'rr' | 'hidden'; accountCount?: number; groupPnl?: number | null; [key: string]: unknown };
  members?: NetworkTradeMember[];
}

/** Same-day resemblance is never evidence of a copy. Input rows have already
 * passed sharing filters; neither counts nor totals include hidden accounts. */
export function groupNetworkTrades<T extends NetworkTradeActivity>(activity: readonly T[]): T[] {
  const output: T[] = [];
  const groups = new Map<string, T>();
  const seen = new Set<string>();
  for (const item of activity) {
    if (item.type !== 'trade') { output.push(item); continue; }
    const row = item.data;
    const identity = JSON.stringify([row.user_id, row.id]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const key = row.groupId && row.accountId && row.user_id
      ? JSON.stringify([row.user_id, row.groupId, row.instrument, row.direction, item.meta.pnlFormat])
      : identity;
    const current = groups.get(key);
    if (current) current.members!.push(row);
    else {
      const group = { ...item, meta: { ...item.meta }, members: [row] };
      groups.set(key, group); output.push(group);
    }
  }
  for (const item of groups.values()) {
    const members = item.members!;
    item.meta.accountCount = new Set(members.map(row => row.accountId).filter(Boolean)).size;
    const known = item.meta.pnlFormat !== 'hidden' && members.every(row => typeof row.pnl === 'number' && Number.isFinite(row.pnl));
    const sum = known ? members.reduce((total, row) => total + row.pnl!, 0) : null;
    item.meta.groupPnl = sum !== null && Number.isFinite(sum) ? sum : null;
    // A card may display the group sum, but execution prices/media always belong
    // to this real account. Opening it must not replace the member's own PnL.
    item.data = members.find(row => row.isMaster) ?? members[0];
    item.date = members.map(row => row.date).sort().at(-1) ?? item.date;
  }
  return output;
}
