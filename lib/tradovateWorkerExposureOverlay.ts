import type { LocalCopierAgentStatus } from './localCopierAgentProtocol';
import type {
  TradovateAccountDataAccount,
  TradovateAccountDataResult,
  TradovateAccountOrder,
  TradovateAccountPosition,
} from './tradovateAccountDataTypes';
import { tradovateAccountReadState } from './tradovateLiveReadState';

/** Heartbeat starší než tohle už není živý obraz brokera; web se vrátí k REST čtení. */
export const WORKER_EXPOSURE_MAX_AGE_MS = 8_000;

type WorkerExposure = NonNullable<NonNullable<LocalCopierAgentStatus['controller']['exposure']>>;

const tradovateOrderStatus = (status: string): string => {
  switch (status) {
    case 'working': return 'Working';
    case 'pending': return 'PendingNew';
    case 'filled': return 'Filled';
    case 'canceled': return 'Canceled';
    case 'rejected': return 'Rejected';
    default: return status;
  }
};

/**
 * Pozice a aktivní příkazy účtů kopírky z heartbeatu workeru mají přednost
 * před REST čtením přes Vercel: worker je drží z brokerového streamu a hlásí
 * je každou sekundu. Použije se jen když je heartbeat čerstvý, stream
 * připojený a worker už udělal úplnou broker kontrolu; jinak se data vrátí
 * beze změny a platí původní REST čerstvost. Zůstatky a P&L se nemění.
 */
export function overlayWorkerExposure<T extends TradovateAccountDataResult>(
  data: T | null,
  status: LocalCopierAgentStatus | null | undefined,
  observedAtMs: number | null | undefined,
  now = Date.now(),
): T | null {
  if (!data) return null;
  const exposure = status?.controller?.exposure;
  if (!exposure || !status?.controller?.connected || observedAtMs == null || !Number.isFinite(observedAtMs)) return data;
  if (observedAtMs > now + 5_000 || now - observedAtMs > WORKER_EXPOSURE_MAX_AGE_MS) return data;
  const members = new Set<number>([
    ...(typeof status.group?.leaderAccountId === 'number' ? [status.group.leaderAccountId] : []),
    ...(status.group?.followers ?? []).map(follower => follower.accountId),
  ]);
  if (members.size === 0) return data;
  const asOf = new Date(observedAtMs).toISOString();
  const contractIdBySymbol = new Map(data.contracts.flatMap(contract => (contract.name ? [[contract.name, contract.id] as const] : [])));
  const positionsByAccount = new Map<number, WorkerExposure['positions']>();
  for (const position of exposure.positions) {
    positionsByAccount.set(position.accountId, [...(positionsByAccount.get(position.accountId) ?? []), position]);
  }
  const ordersByAccount = new Map<number, NonNullable<WorkerExposure['orders']>>();
  for (const order of exposure.orders ?? []) {
    ordersByAccount.set(order.accountId, [...(ordersByAccount.get(order.accountId) ?? []), order]);
  }
  let changed = false;
  const accounts = data.accounts.map((account): TradovateAccountDataAccount => {
    if (!members.has(account.id)) return account;
    changed = true;
    const previousBySymbol = new Map(account.positions.flatMap(position => (position.symbol ? [[position.symbol, position] as const] : [])));
    const positions: TradovateAccountPosition[] = (positionsByAccount.get(account.id) ?? []).map(position => {
      const previous = previousBySymbol.get(position.symbol);
      return {
        id: previous?.id ?? null,
        contractId: previous?.contractId ?? contractIdBySymbol.get(position.symbol) ?? 0,
        symbol: position.symbol,
        timestamp: asOf,
        tradeDate: previous?.tradeDate ?? null,
        netPosition: position.netQuantity,
        bought: previous?.bought ?? null,
        boughtValue: previous?.boughtValue ?? null,
        sold: previous?.sold ?? null,
        soldValue: previous?.soldValue ?? null,
        previousPosition: previous?.previousPosition ?? null,
        // Průměrná cena z REST platí jen pro tutéž pozici; jinak není známa.
        averagePrice: previous && previous.netPosition === position.netQuantity ? previous.averagePrice : previous?.averagePrice ?? null,
        previousPrice: previous?.previousPrice ?? null,
      };
    });
    const orders: TradovateAccountOrder[] = exposure.orders
      ? (ordersByAccount.get(account.id) ?? []).map(order => ({
        id: Number(order.brokerOrderId),
        contractId: contractIdBySymbol.get(order.symbol) ?? null,
        symbol: order.symbol,
        timestamp: new Date(order.updatedAt).toISOString(),
        action: order.side,
        orderType: order.orderType,
        quantity: order.quantity,
        price: order.limitPrice,
        stopPrice: order.stopPrice,
        status: tradovateOrderStatus(order.status),
        admin: null,
        ocoId: null,
        parentId: null,
        linkedId: null,
      }))
      : account.orders;
    const readState = tradovateAccountReadState(account, data);
    const workingOrderCount = orders.filter(order => order.status === 'Working').length;
    return {
      ...account,
      positions,
      orders,
      netPositionCount: positions.filter(position => position.netPosition !== 0).length,
      workingOrderCount,
      activity: {
        ...account.activity,
        positionCount: positions.length,
        netPositionCount: positions.filter(position => position.netPosition !== 0).length,
        orderCount: orders.length,
        workingOrderCount,
      },
      readState: {
        ...readState,
        positions: { availability: positions.length > 0 ? 'available' : 'empty', count: positions.length, httpStatus: null },
        positionsAsOf: asOf,
        ...(exposure.orders
          ? { orders: { availability: orders.length > 0 ? 'available' : 'empty', count: orders.length, httpStatus: null }, ordersAsOf: asOf }
          : {}),
      },
    };
  });
  return changed ? { ...data, accounts } : data;
}
