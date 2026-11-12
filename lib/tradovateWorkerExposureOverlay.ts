import type { LocalCopierAgentStatus } from './localCopierAgentProtocol';
import type {
  TradovateAccountDataAccount,
  TradovateAccountDataResult,
  TradovateAccountOrder,
  TradovateAccountPosition,
} from './tradovateAccountDataTypes';
import type { TradovateWorkerAccountCoverage } from './tradovateRequestControl';
import { coveredWorkerAccounts, type WorkerCoverageOwner } from './tradovateWorkerCoverage.js';
import { tradovateAccountReadState } from './tradovateLiveReadState.js';

/** Starší doručení důkazu kontinuity už nepokrývá webové čtení. */
export const WORKER_EXPOSURE_MAX_AGE_MS = 8_000;
/** Text workeru (`services/copierRuntimeController.ts`) pro followera bez ověřené pozice. */
export const WORKER_POSITION_UNKNOWN_DETAIL = 'pozice neověřena';
/** Texty workeru, které vznikají jen z porovnání skutečně držené pozice followera. */
export const WORKER_POSITION_DIVERGENT_DETAIL = 'pozice se liší od leadera';
export const WORKER_POSITION_MISMATCH_DETAIL = /: drží -?\d+, očekáváno -?\d+$/;
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
 * Pozice a aktivní příkazy přebírá jen pro explicitně pokryté účty: úplná
 * baseline, shodná route/session a nepřerušený synchronizovaný stream bez
 * mezery, backlogu či merge. Samotný heartbeat ani role leadera nestačí.
 * Čas dat zůstává poslední skutečnou změnou, nikoli časem doručení statusu.
 * Účty bez tohoto důkazu zůstávají na REST. Zůstatky a P&L se nemění.
 */
export function overlayWorkerExposure<T extends TradovateAccountDataResult>(
  data: T | null,
  status: LocalCopierAgentStatus | null | undefined,
  observedAtMs: number | null | undefined,
  now = Date.now(),
  owners: ReadonlyMap<number, WorkerCoverageOwner> = new Map(),
): T | null {
  if (!data) return null;
  const exposure = status?.controller?.exposure;
  if (!exposure || !status?.controller?.connected || observedAtMs == null || !Number.isFinite(observedAtMs)) return data;
  if (observedAtMs > now + 5_000 || now - observedAtMs > WORKER_EXPOSURE_MAX_AGE_MS) return data;
  const covered = new Map<number, TradovateWorkerAccountCoverage>();
  for (const [accountId, owner] of owners) {
    const proof = coveredWorkerAccounts({ status, observedAt: observedAtMs }, owner, [accountId], now).get(accountId);
    if (proof) covered.set(accountId, proof);
  }
  if (!covered.size) return data;
  const context = workerExposureOverlayContext(data, exposure);
  let changed = false;
  const accounts = data.accounts.map((account): TradovateAccountDataAccount => {
    const proof = covered.get(account.id);
    if (!proof || !exposure.orders) return account;
    changed = true;
    return overlayWorkerAccount(account, data, context, proof.lastDataAt, proof);
  });
  return changed ? { ...data, accounts } : data;
}

export interface WorkerExposureOverlayContext {
  exposure: WorkerExposure;
  contractIdBySymbol: Map<string, number>;
  positionsByAccount: Map<number, WorkerExposure['positions']>;
  ordersByAccount: Map<number, NonNullable<WorkerExposure['orders']>>;
}

export function workerExposureOverlayContext(data: TradovateAccountDataResult, exposure: WorkerExposure): WorkerExposureOverlayContext {
  const contractIdBySymbol = new Map(data.contracts.flatMap(contract => (contract.name ? [[contract.name, contract.id] as const] : [])));
  const positionsByAccount = new Map<number, WorkerExposure['positions']>();
  for (const position of exposure.positions) {
    positionsByAccount.set(position.accountId, [...(positionsByAccount.get(position.accountId) ?? []), position]);
  }
  const ordersByAccount = new Map<number, NonNullable<WorkerExposure['orders']>>();
  for (const order of exposure.orders ?? []) {
    ordersByAccount.set(order.accountId, [...(ordersByAccount.get(order.accountId) ?? []), order]);
  }
  return { exposure, contractIdBySymbol, positionsByAccount, ordersByAccount };
}

/**
 * Pozice a aktivní příkazy jednoho účtu z expozice workeru. `proof` = doklad
 * kontinuity (jen ten smí do `displayStreamCoverage`); bez něj volá jen
 * zobrazovací projekce grafu (`lib/liveChartExposureProjection.ts`), která
 * účet označí jako neověřený. `dataAtMs` = čas dat workeru (doklad: poslední
 * změna, projekce: příjem statusu).
 */
export function overlayWorkerAccount(
  account: TradovateAccountDataAccount,
  data: TradovateAccountDataResult,
  context: WorkerExposureOverlayContext,
  dataAtMs: number,
  proof: TradovateWorkerAccountCoverage | null,
): TradovateAccountDataAccount {
  const { exposure, contractIdBySymbol, positionsByAccount, ordersByAccount } = context;
  const asOf = new Date(dataAtMs).toISOString();
  const previousBySymbol = new Map(account.positions.flatMap(position => (position.symbol ? [[position.symbol, position] as const] : [])));
  const restPositionsAt = Date.parse(tradovateAccountReadState(account, data).positionsAsOf ?? '');
  // REST tutéž pozici ještě nezná (čerstvý vstup, přikoupení, otočení): jeho
  // otevřené P&L patří k dřívějšímu stavu — karta obchodu ho do potvrzení
  // z REST neukáže (nedopočítá cenu trhu z cizího P&L, utažení SL zůstane
  // blokované). Zdroj P&L pro ostatní (denní limit účtu) se nemění.
  const restBehind = (positionsByAccount.get(account.id) ?? []).some(position => previousBySymbol.get(position.symbol)?.netPosition !== position.netQuantity
    || (typeof position.avgPrice === 'number' && Number.isFinite(position.avgPrice) && position.avgPrice > 0
      && (!Number.isFinite(restPositionsAt) || restPositionsAt < dataAtMs)
      && previousBySymbol.get(position.symbol)?.averagePrice !== position.avgPrice))
    || account.positions.some(position => position.netPosition !== 0
      && !(positionsByAccount.get(account.id) ?? []).some(next => next.symbol === position.symbol));
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
      // Průměrná cena z REST platí jen pro tutéž pozici; jinak (otočení,
      // přikoupení, částečné zavření) průměr z fillů workeru (jen když jeho
      // lot sedí na kusy), nebo neznámo, dokud ji nepotvrdí REST.
      averagePrice: previous && previous.netPosition === position.netQuantity
        && restPositionsAt >= dataAtMs ? previous.averagePrice
        : typeof position.avgPrice === 'number' && Number.isFinite(position.avgPrice) && position.avgPrice > 0 ? position.avgPrice : null,
      previousPrice: previous?.previousPrice ?? null,
    };
  });
  const restOrderById = new Map(account.orders.map(order => [order.id, order] as const));
  const linkId = (value: string | undefined, fallback: number | null | undefined) => {
    const parsed = value != null ? Number(value) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback ?? null;
  };
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
      // Vazby bracketu: od workeru, jinak z REST téhož příkazu (noha SL/TP ≠ čekající vstup).
      ocoId: linkId((order as { ocoId?: string }).ocoId, restOrderById.get(Number(order.brokerOrderId))?.ocoId),
      parentId: linkId((order as { parentOrderId?: string }).parentOrderId, restOrderById.get(Number(order.brokerOrderId))?.parentId),
      linkedId: null,
    }))
    : account.orders;
  const { displayStreamCoverage: _previousProof, displayProjection: _previousProjection, ...readState } = tradovateAccountReadState(account, data);
  const workingOrderCount = orders.filter(order => order.status === 'Working').length;
  return {
    ...account,
    ...(restBehind ? { balance: { ...account.balance, openPnlBehindPosition: true } } : {}),
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
      ...(proof ? { displayStreamCoverage: proof } : { displayProjection: 'worker-unverified' as const }),
      ...(exposure.orders
        ? { orders: { availability: orders.length > 0 ? 'available' : 'empty', count: orders.length, httpStatus: null }, ordersAsOf: asOf }
        : {}),
    },
  };
}
