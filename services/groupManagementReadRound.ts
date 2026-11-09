import type { BrokerOrderStateLookup, BrokerPort } from './brokerPort';

/** Independent account reads may share the adapter's same-login singleflight.
 * Never parallelize writes or reuse a completed round for a later guard. */
export async function readGroupManagementRound(
  members: readonly { accountId: number; entryId: string }[],
  broker: Pick<BrokerPort, 'listOrders' | 'listPositions'>,
  readEntry: (accountId: number, entryId: string) => Promise<BrokerOrderStateLookup | null>,
) {
  if (new Set(members.map(member => member.accountId)).size !== members.length) throw new Error('Duplicate group read account');
  const results: Array<{
    accountId: number;
    orders: Awaited<ReturnType<BrokerPort['listOrders']>>;
    positions: Awaited<ReturnType<BrokerPort['listPositions']>>;
    entryRead: BrokerOrderStateLookup | null;
  }> = [];
  // Bound bursts even for a larger copier group. This is read-only; the caller
  // still validates all accounts and its synchronous dispatch fences afterwards.
  for (let offset = 0; offset < members.length; offset += 4) {
    const batch = await Promise.allSettled(members.slice(offset, offset + 4).map(async member => {
      const reads = await Promise.allSettled([
        broker.listOrders(member.accountId, { fresh: true }),
        broker.listPositions(member.accountId),
        readEntry(member.accountId, member.entryId),
      ] as const);
      const failed = reads.find(read => read.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      const [orders, positions, entryRead] = reads as [
        PromiseFulfilledResult<Awaited<ReturnType<BrokerPort['listOrders']>>>,
        PromiseFulfilledResult<Awaited<ReturnType<BrokerPort['listPositions']>>>,
        PromiseFulfilledResult<BrokerOrderStateLookup | null>,
      ];
      return { accountId: member.accountId, orders: orders.value, positions: positions.value, entryRead: entryRead.value };
    }));
    const failed = batch.find(read => read.status === 'rejected');
    // Drain the complete read batch before returning failure; no next batch and
    // no write can start while one of these reads is still outstanding.
    if (failed?.status === 'rejected') throw failed.reason;
    for (const read of batch) if (read.status === 'fulfilled') results.push(read.value);
  }
  return results;
}
