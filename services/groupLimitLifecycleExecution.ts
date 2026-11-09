import type { BrokerOrder, BrokerOrderRequest, BrokerOcoRequest } from './brokerPort';
import type { LeaderOrderManageCommand } from '../lib/leaderOrderManage';
import type { GroupLimitMemberRecord } from './groupLimitLifecycle';

export interface GroupLimitMemberSnapshot { orders: BrokerOrder[]; net: number }
export interface GroupLimitManagementExecution {
  command: LeaderOrderManageCommand;
  symbol: string;
  side: 'Buy' | 'Sell';
  members: GroupLimitMemberRecord[];
  snapshots: Map<number, GroupLimitMemberSnapshot>;
  /** Config/routes/brakes/entry/net/foreign state plus exact permitted WAL transition. */
  guard(expected: Map<number, GroupLimitMemberSnapshot>, cleanup?: boolean): Promise<string | null>;
  save(members: GroupLimitMemberRecord[]): Promise<void>;
  bind(members: GroupLimitMemberRecord[]): Promise<void>;
  place(request: BrokerOrderRequest): Promise<string>;
  oco(request: BrokerOcoRequest): Promise<{ stopId: string; targetId: string }>;
  modify(accountId: number, id: string, quantity: number, type: 'Stop' | 'Limit', price: number): Promise<void>;
  cancel(accountId: number, id: string, cleanup?: boolean): Promise<void>;
  lookup(accountId: number, id: string): Promise<BrokerOrder | null>;
}

/** One writer for group legs. Every stage is WAL first, no automatic retry or resume. */
export async function executeGroupLimitManagement(input: GroupLimitManagementExecution): Promise<{ status: 'acknowledged' | 'unknown' | 'not-sent'; reason?: string }> {
  if (input.members.some(member => member.status !== 'planned')) return { status: 'not-sent', reason: 'Uložená rozpracovaná operace se automaticky neobnovuje.' };
  const { command, symbol, side } = input;
  const members = input.members.map(member => ({ ...member }));
  const expected = new Map([...input.snapshots].map(([id, row]) => [id, { net: row.net, orders: row.orders.map(order => ({ ...order })) }]));
  let wrote = false;
  const save = () => input.save(members.map(member => ({ ...member })));
  const stage = async <T>(member: GroupLimitMemberRecord, phase: GroupLimitMemberRecord['phase'], write: () => Promise<T>, cleanup = false): Promise<T> => {
    member.status = 'sending'; member.phase = phase; await save();
    const problem = await input.guard(expected, cleanup);
    if (problem) throw new Error(problem);
    wrote = true;
    return write();
  };
  const row = (member: GroupLimitMemberRecord, id: string | undefined) => expected.get(member.accountId)!.orders.find(order => order.brokerOrderId === id);
  const replace = (member: GroupLimitMemberRecord, order: BrokerOrder) => {
    const snapshot = expected.get(member.accountId)!;
    snapshot.orders = [...snapshot.orders.filter(item => item.brokerOrderId !== order.brokerOrderId), { ...order }];
  };
  const remove = (member: GroupLimitMemberRecord, id: string) => { const snapshot = expected.get(member.accountId)!; snapshot.orders = snapshot.orders.filter(order => order.brokerOrderId !== id); };
  const cancel = async (member: GroupLimitMemberRecord, id: string, cleanup = false) => {
    await stage(member, member.phase ?? 'write-sending', () => input.cancel(member.accountId, id, cleanup), cleanup);
    const found = await input.lookup(member.accountId, id);
    if (!found || found.status !== 'canceled' || found.filledQuantity !== 0) throw new Error(`Účet ${member.accountId}: zrušení ${id} nepotvrzené nebo se noha vyplnila.`);
    remove(member, id);
  };
  const created = async (member: GroupLimitMemberRecord, id: string, type: 'Stop' | 'Limit', price: number) => {
    const found = await input.lookup(member.accountId, id);
    if (!found || found.accountId !== member.accountId || found.symbol !== symbol || found.side !== (side === 'Buy' ? 'Sell' : 'Buy')
      || found.orderType !== type || found.quantity !== member.quantity || found.filledQuantity !== 0 || found.status !== 'working'
      || (type === 'Stop' ? found.stopPrice : found.limitPrice) !== price) throw new Error(`Účet ${member.accountId}: nová noha ${id} nemá potvrzený tvar.`);
    replace(member, found);
  };
  try {
    for (const member of members) {
      if (member.quantity === 0) { member.status = 'acknowledged'; await save(); continue; }
      const stop = row(member, member.stopId), target = row(member, member.targetId);
      const leg = command.action === 'move-stop' ? 'stopLoss' : command.action === 'move-target' ? 'takeProfit' : command.leg;
      const current = leg === 'stopLoss' ? stop : target;
      if (command.action === 'move-stop' || command.action === 'move-target') {
        if (!current) throw new Error('Přesná vlastní noha chybí.');
        const type = leg === 'stopLoss' ? 'Stop' as const : 'Limit' as const;
        await stage(member, 'write-sending', () => input.modify(member.accountId, current.brokerOrderId, member.quantity, type, command.newPrice!));
        await created(member, current.brokerOrderId, type, command.newPrice!);
      } else if (command.action === 'remove-leg') {
        if (!current) throw new Error('Přesná vlastní noha chybí.');
        await cancel(member, current.brokerOrderId);
        if (leg === 'stopLoss') member.stopId = undefined; else member.targetId = undefined;
      } else if (command.action === 'attach-brackets' || command.action === 'add-leg') {
        const stopPrice = command.action === 'attach-brackets' ? command.stopLoss : leg === 'stopLoss' ? command.newPrice : stop?.stopPrice;
        const targetPrice = command.action === 'attach-brackets' ? command.takeProfit : leg === 'takeProfit' ? command.newPrice : target?.limitPrice;
        if (stopPrice != null && targetPrice != null) {
          // TP-only -> cancel old target before OCO; SL-only -> keep old SL until new OCO verified.
          if (target && !stop) { member.oldLegId = target.brokerOrderId; await cancel(member, target.brokerOrderId); member.phase = 'target-canceled'; member.targetId = undefined; await save(); await input.bind(members); }
          const ids = await stage(member, member.phase ?? 'write-sending', () => input.oco({ tag: member.tag!, accountId: member.accountId, symbol, quantity: member.quantity,
            first: { side: side === 'Buy' ? 'Sell' : 'Buy', orderType: 'Stop', stopPrice },
            second: { side: side === 'Buy' ? 'Sell' : 'Buy', orderType: 'Limit', limitPrice: targetPrice } }));
          member.newStopId = ids.stopId; member.newTargetId = ids.targetId; member.phase = 'oco-acked';
          member.oldLegId = stop?.brokerOrderId ?? member.oldLegId;
          member.stopId = ids.stopId; member.targetId = ids.targetId; await save(); await input.bind(members);
          await created(member, ids.stopId, 'Stop', stopPrice); await created(member, ids.targetId, 'Limit', targetPrice);
          const newStop = row(member, ids.stopId)!, newTarget = row(member, ids.targetId)!;
          const linked = newStop.linkedOrderId === ids.targetId && newTarget.linkedOrderId === ids.stopId
            || newStop.ocoId === ids.targetId && newTarget.ocoId === ids.stopId;
          if (!linked) throw new Error(`Účet ${member.accountId}: nové nohy nemají potvrzené vzájemné OCO vazby; původní SL se neruší.`);
          if (stop) await cancel(member, stop.brokerOrderId, true);
        } else {
          const type = leg === 'stopLoss' ? 'Stop' as const : 'Limit' as const;
          const id = await stage(member, 'write-sending', () => input.place({ tag: member.tag!, accountId: member.accountId, symbol,
            side: side === 'Buy' ? 'Sell' : 'Buy', orderType: type, quantity: member.quantity,
            ...(type === 'Stop' ? { stopPrice: command.newPrice! } : { limitPrice: command.newPrice! }) }));
          if (type === 'Stop') { member.stopId = id; member.newStopId = id; } else { member.targetId = id; member.newTargetId = id; }
          await save(); await input.bind(members); await created(member, id, type, command.newPrice!);
        }
      } else throw new Error('Nepodporovaná správa skupiny.');
      const problem = await input.guard(expected);
      if (problem) throw new Error(problem);
      member.status = 'acknowledged'; await save(); await input.bind(members);
    }
    return { status: 'acknowledged' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    for (const member of members) if (member.status === 'sending') { member.status = 'unknown'; member.reason = reason; }
    await save();
    return { status: wrote ? 'unknown' : 'not-sent', reason };
  }
}
