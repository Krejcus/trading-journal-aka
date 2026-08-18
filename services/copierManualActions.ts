import type { BrokerOrder, BrokerPort } from './brokerPort';
import { planFlatten } from './copierEngine';
import {
  createCancelEntry,
  markCancelSending,
  markCancelUnknown,
  resolveCancelLookup,
  type CancelOutboxEntry,
} from './copierCancelOutbox';
import {
  createOutboxEntry,
  markAcknowledged,
  markRejected,
  markSending,
  markUnknown,
  resolveLookup,
} from './copierOutbox';
import type { CopierRuntime } from './copierRunner';
import { toSnapshot, type CopierStore } from './copierStore';

export interface ManualFlattenResult {
  operationId: string;
  accountIds: number[];
  canceledOrders: number;
  submittedClosures: number;
  flat: boolean;
  remainingPositionAccounts: number[];
  workingOrderAccounts: number[];
}

interface ManualFlattenOptions {
  runtime: CopierRuntime;
  broker: BrokerPort;
  store: CopierStore;
  groupId: string;
  accountIds: readonly number[];
  operationId: string;
  clock: () => number;
  /** Počet read-only kontrol autoritativního Order/Position stavu. */
  confirmationAttempts?: number;
  confirmationPollMs?: number;
  wait?: (ms: number) => Promise<void>;
}

const operationToken = (value: string) => {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9:_-]{8,120}$/.test(normalized)) {
    throw new Error('Flatten vyžaduje stabilní operationId (8–120 znaků)');
  }
  return normalized;
};

async function commit(runtime: CopierRuntime, store: CopierStore): Promise<CopierRuntime> {
  const saved = await store.commit(
    toSnapshot(
      runtime.state,
      runtime.outbox.values(),
      runtime.cancelOutbox.values(),
      runtime.revision,
      runtime.bracketOutbox.values(),
      runtime.osoOutbox.values(),
    ),
    runtime.revision,
  );
  return { ...runtime, revision: saved.revision };
}

const cancelKey = (groupId: string, operationId: string, order: BrokerOrder) =>
  `manual-cancel:${groupId}:${operationId}:${order.accountId}:${order.brokerOrderId}`;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Explicitní ruční Flatten. Nejdřív durable zruší všechny working příkazy,
 * teprve potom odešle market close pro aktuální pozice. Nejasný výsledek
 * zůstává v outboxu a operace failne zavřeně; nikdy se slepě neopakuje.
 */
export async function processManualFlatten(options: ManualFlattenOptions): Promise<{
  runtime: CopierRuntime;
  result: ManualFlattenResult;
}> {
  const operationId = operationToken(options.operationId);
  const accountIds = [...new Set(options.accountIds)];
  if (accountIds.length === 0 || accountIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('Flatten nemá platný cílový účet');
  }

  let runtime = options.runtime;
  let canceledOrders = 0;
  let submittedClosures = 0;
  const confirmationAttempts = Math.max(1, Math.trunc(options.confirmationAttempts ?? 50));
  const confirmationPollMs = Math.max(0, Math.trunc(options.confirmationPollMs ?? 100));
  const wait = options.wait ?? sleep;

  const confirmCancel = async (
    current: CancelOutboxEntry,
    accountId: number,
    brokerOrderId: string,
  ) => {
    let entry = current;
    for (let attempt = 0; attempt < confirmationAttempts; attempt += 1) {
      if (attempt > 0) await wait(confirmationPollMs);
      const lookup = await options.broker.findOrderById(accountId, brokerOrderId);
      entry = resolveCancelLookup(entry, lookup.order, lookup.completeness, options.clock());
      runtime.cancelOutbox.set(entry.key, entry);
      runtime = await commit(runtime, options.store);
      if (entry.status === 'confirmed' || entry.status === 'abandoned') break;
    }
    return entry;
  };

  for (const accountId of accountIds) {
    const working = (await options.broker.listOrders(accountId)).filter(order => order.status === 'working');
    for (const order of working) {
      const key = cancelKey(options.groupId, operationId, order);
      let entry = runtime.cancelOutbox.get(key);
      if (entry?.status === 'confirmed') continue;
      if (entry && entry.status !== 'planned') {
        throw new Error(`Flatten cancel ${order.brokerOrderId} čeká na ruční dohledání (${entry.status})`);
      }
      if (!entry) {
        entry = createCancelEntry(
          key,
          `manual-flatten:${operationId}`,
          runtime.state.lastSequence,
          accountId,
          order.brokerOrderId,
          options.clock(),
        );
        runtime.cancelOutbox.set(key, entry);
        runtime = await commit(runtime, options.store);
      }

      entry = markCancelSending(entry, options.clock());
      runtime.cancelOutbox.set(key, entry);
      runtime = await commit(runtime, options.store);
      try {
        await options.broker.cancelOrder(accountId, order.brokerOrderId);
        entry = await confirmCancel(entry, accountId, order.brokerOrderId);
      } catch (reason) {
        try {
          entry = await confirmCancel(entry, accountId, order.brokerOrderId);
        } catch {
          entry = markCancelUnknown(
            entry,
            reason instanceof Error ? reason.message : String(reason),
            options.clock(),
          );
        }
      }
      runtime.cancelOutbox.set(key, entry);
      runtime = await commit(runtime, options.store);
      if (entry.status !== 'confirmed') {
        throw new Error(`Flatten cancel ${order.brokerOrderId} není autoritativně potvrzen (${entry.status})`);
      }
      canceledOrders += 1;
    }
  }

  for (const accountId of accountIds) {
    const positions = (await options.broker.listPositions(accountId)).filter(position => position.netQuantity !== 0);
    for (const position of positions) {
      const plan = planFlatten(
        options.groupId,
        position,
        `${operationId}:${position.symbol}`,
      );
      if (!plan) continue;
      let entry = runtime.outbox.get(plan.key);
      if (entry?.status === 'acknowledged') continue;
      if (entry?.status === 'rejected' || entry?.status === 'abandoned' || entry?.status === 'waived') {
        throw new Error(`Flatten close ${position.symbol} skončil jako ${entry.status}`);
      }
      if (entry?.status === 'sending' || entry?.status === 'unknown') {
        const lookup = await options.broker.findOrdersByTag(accountId, entry.tag);
        if (lookup.orders.length > 1) {
          entry = { ...entry, status: 'abandoned', reason: 'nalezeno více flatten objednávek se stejným tagem', updatedAt: options.clock() };
        } else {
          const found = lookup.orders[0];
          entry = resolveLookup(
            entry,
            found ? { brokerOrderId: found.brokerOrderId, rejected: found.status === 'rejected', reason: found.rejectReason } : null,
            lookup.completeness,
            options.clock(),
          );
        }
        runtime.outbox.set(plan.key, entry);
        runtime = await commit(runtime, options.store);
        if (entry.status !== 'acknowledged') {
          throw new Error(`Flatten close ${position.symbol} čeká na ruční dohledání (${entry.status})`);
        }
        continue;
      }
      if (!entry) {
        entry = createOutboxEntry(
          plan.key,
          plan.request.tag,
          `manual-flatten:${operationId}:${position.symbol}`,
          plan.request,
          options.clock(),
          false,
          `manual-flatten:${operationId}`,
          runtime.state.lastSequence,
        );
        runtime.outbox.set(plan.key, entry);
        runtime = await commit(runtime, options.store);
      }

      entry = markSending(entry, options.clock());
      runtime.outbox.set(plan.key, entry);
      runtime = await commit(runtime, options.store);
      try {
        const ack = await options.broker.placeOrder(entry.request);
        entry = ack.accepted && ack.definitive
          ? markAcknowledged(entry, ack.brokerOrderId, options.clock())
          : ack.definitive
            ? markRejected(entry, ack.rejectReason ?? 'Flatten odmítnut brokerem', options.clock())
            : markUnknown(entry, 'Flatten vrátil nejednoznačnou odpověď', options.clock());
      } catch (reason) {
        try {
          const lookup = await options.broker.findOrdersByTag(accountId, entry.tag);
          if (lookup.orders.length > 1) {
            entry = { ...entry, status: 'abandoned', reason: 'nalezeno více flatten objednávek se stejným tagem', updatedAt: options.clock() };
          } else {
            const found = lookup.orders[0];
            entry = resolveLookup(
              entry,
              found ? { brokerOrderId: found.brokerOrderId, rejected: found.status === 'rejected', reason: found.rejectReason } : null,
              lookup.completeness,
              options.clock(),
            );
          }
        } catch {
          entry = markUnknown(
            entry,
            reason instanceof Error ? reason.message : String(reason),
            options.clock(),
          );
        }
      }
      runtime.outbox.set(plan.key, entry);
      runtime = await commit(runtime, options.store);
      if (entry.status !== 'acknowledged') {
        throw new Error(`Flatten close ${position.symbol} nebyl bezpečně potvrzen (${entry.status})`);
      }
      submittedClosures += 1;
    }
  }

  let finalState: Array<{
    accountId: number;
    positions: Awaited<ReturnType<BrokerPort['listPositions']>>;
    orders: Awaited<ReturnType<BrokerPort['listOrders']>>;
  }> = [];
  for (let attempt = 0; attempt < confirmationAttempts; attempt += 1) {
    if (attempt > 0) await wait(confirmationPollMs);
    finalState = await Promise.all(accountIds.map(async accountId => ({
      accountId,
      positions: await options.broker.listPositions(accountId),
      orders: await options.broker.listOrders(accountId),
    })));
    if (finalState.every(item => (
      item.positions.every(position => position.netQuantity === 0)
      && item.orders.every(order => order.status !== 'working')
    ))) break;
  }
  const remainingPositionAccounts = finalState
    .filter(item => item.positions.some(position => position.netQuantity !== 0))
    .map(item => item.accountId);
  const workingOrderAccounts = finalState
    .filter(item => item.orders.some(order => order.status === 'working'))
    .map(item => item.accountId);

  return {
    runtime,
    result: {
      operationId,
      accountIds,
      canceledOrders,
      submittedClosures,
      flat: remainingPositionAccounts.length === 0 && workingOrderAccounts.length === 0,
      remainingPositionAccounts,
      workingOrderAccounts,
    },
  };
}
