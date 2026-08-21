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
  accounts: ManualFlattenAccountResult[];
  failedAccounts: number[];
}

export interface ManualFlattenAccountResult {
  accountId: number;
  ok: boolean;
  canceledOrders: number;
  submittedClosures: number;
  error?: string;
  remainingPositions: number;
  workingOrders: number;
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
  accountConcurrency?: number;
  wait?: (ms: number) => Promise<void>;
}

const operationToken = (value: string) => {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9:_-]{8,120}$/.test(normalized)) {
    throw new Error('Flatten vyžaduje stabilní operationId (8–120 znaků)');
  }
  return normalized;
};

const cancelKey = (groupId: string, operationId: string, order: BrokerOrder) =>
  `manual-cancel:${groupId}:${operationId}:${order.accountId}:${order.brokerOrderId}`;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(items.length || 1, limit));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

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

  // Mapy outboxů zůstávají sdílené mezi account workery; holder nese vždy
  // poslední revizi vrácenou durable storem.
  const runtime = { current: options.runtime };
  const confirmationAttempts = Math.max(1, Math.trunc(options.confirmationAttempts ?? 50));
  const confirmationPollMs = Math.max(0, Math.trunc(options.confirmationPollMs ?? 100));
  const requestedConcurrency = Math.trunc(options.accountConcurrency ?? 5);
  const accountConcurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, requestedConcurrency)
    : 5;
  const wait = options.wait ?? sleep;
  let commitTail: Promise<void> = Promise.resolve();
  let commitFailed = false;
  let commitFailure: unknown;

  const throwIfCommitFailed = () => {
    if (commitFailed) throw commitFailure;
  };

  // Snapshoty se smí překrývat v přípravě, ale samotné CAS commity musí
  // navazovat na revizi předchozího dokončeného zápisu.
  const commitSerialized = () => {
    throwIfCommitFailed();
    const pending = commitTail.then(async () => {
      throwIfCommitFailed();
      const current = runtime.current;
      try {
        const saved = await options.store.commit(
          toSnapshot(
            current.state,
            current.outbox.values(),
            current.cancelOutbox.values(),
            current.revision,
            current.bracketOutbox.values(),
            current.osoOutbox.values(),
          ),
          current.revision,
        );
        runtime.current = { ...current, revision: saved.revision };
      } catch (reason) {
        commitFailed = true;
        commitFailure = reason;
        throw reason;
      }
    });
    commitTail = pending.catch(() => undefined);
    return pending;
  };

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
      runtime.current.cancelOutbox.set(entry.key, entry);
      await commitSerialized();
      if (entry.status === 'confirmed' || entry.status === 'abandoned') break;
    }
    return entry;
  };

  // Každý worker zpracuje účet sekvenčně cancel → close. Pool omezuje jen
  // počet současně rozběhnutých účtů, nikoli pořadí operací uvnitř účtu.
  const pipelineResults = await mapWithConcurrency(accountIds, accountConcurrency, async accountId => {
    let canceledOrders = 0;
    let submittedClosures = 0;
    try {
      const working = (await options.broker.listOrders(accountId)).filter(order => order.status === 'working');
      for (const order of working) {
        const key = cancelKey(options.groupId, operationId, order);
        let entry = runtime.current.cancelOutbox.get(key);
        if (entry?.status === 'confirmed') continue;
        if (entry && entry.status !== 'planned') {
          throw new Error(`Flatten cancel ${order.brokerOrderId} čeká na ruční dohledání (${entry.status})`);
        }
        if (!entry) {
          entry = createCancelEntry(
            key,
            `manual-flatten:${operationId}`,
            runtime.current.state.lastSequence,
            accountId,
            order.brokerOrderId,
            options.clock(),
          );
          runtime.current.cancelOutbox.set(key, entry);
          await commitSerialized();
        }

        entry = markCancelSending(entry, options.clock());
        runtime.current.cancelOutbox.set(key, entry);
        await commitSerialized();
        try {
          await options.broker.cancelOrder(accountId, order.brokerOrderId);
          entry = await confirmCancel(entry, accountId, order.brokerOrderId);
        } catch (reason) {
          throwIfCommitFailed();
          try {
            entry = await confirmCancel(entry, accountId, order.brokerOrderId);
          } catch {
            throwIfCommitFailed();
            entry = markCancelUnknown(entry, errorMessage(reason), options.clock());
          }
        }
        runtime.current.cancelOutbox.set(key, entry);
        await commitSerialized();
        if (entry.status !== 'confirmed') {
          throw new Error(`Flatten cancel ${order.brokerOrderId} není autoritativně potvrzen (${entry.status})`);
        }
        canceledOrders += 1;
      }

      const positions = (await options.broker.listPositions(accountId))
        .filter(position => position.netQuantity !== 0);
      for (const position of positions) {
        const plan = planFlatten(options.groupId, position, `${operationId}:${position.symbol}`);
        if (!plan) continue;
        let entry = runtime.current.outbox.get(plan.key);
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
          runtime.current.outbox.set(plan.key, entry);
          await commitSerialized();
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
            runtime.current.state.lastSequence,
          );
          runtime.current.outbox.set(plan.key, entry);
          await commitSerialized();
        }

        entry = markSending(entry, options.clock());
        runtime.current.outbox.set(plan.key, entry);
        await commitSerialized();
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
            entry = markUnknown(entry, errorMessage(reason), options.clock());
          }
        }
        runtime.current.outbox.set(plan.key, entry);
        await commitSerialized();
        if (entry.status !== 'acknowledged') {
          throw new Error(`Flatten close ${position.symbol} nebyl bezpečně potvrzen (${entry.status})`);
        }
        submittedClosures += 1;
      }
      return { accountId, canceledOrders, submittedClosures };
    } catch (reason) {
      return { accountId, canceledOrders, submittedClosures, error: errorMessage(reason) };
    }
  });

  throwIfCommitFailed();

  let finalState: Array<{
    accountId: number;
    positions: Awaited<ReturnType<BrokerPort['listPositions']>>;
    orders: Awaited<ReturnType<BrokerPort['listOrders']>>;
    error?: string;
  }> = [];
  for (let attempt = 0; attempt < confirmationAttempts; attempt += 1) {
    if (attempt > 0) await wait(confirmationPollMs);
    finalState = await Promise.all(accountIds.map(async accountId => {
      try {
        return {
          accountId,
          positions: await options.broker.listPositions(accountId),
          orders: await options.broker.listOrders(accountId),
        };
      } catch (reason) {
        return { accountId, positions: [], orders: [], error: errorMessage(reason) };
      }
    }));
    if (finalState.every(item => (
      !('error' in item)
      &&
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
  const accounts = accountIds.map((accountId, index): ManualFlattenAccountResult => {
    const pipeline = pipelineResults[index];
    const final = finalState[index];
    const remainingPositions = final.positions.filter(position => position.netQuantity !== 0).length;
    const workingOrders = final.orders.filter(order => order.status === 'working').length;
    const verificationError = final.error;
    const error = pipeline.error
      ?? (verificationError ? `Finální kontrola selhala: ${verificationError}` : undefined)
      ?? (remainingPositions > 0 ? `Po finální kontrole zbývá ${remainingPositions} otevřených pozic` : undefined)
      ?? (workingOrders > 0 ? `Po finální kontrole zbývá ${workingOrders} working orderů` : undefined)
      ?? undefined;
    return {
      accountId,
      ok: error === undefined,
      canceledOrders: pipeline.canceledOrders,
      submittedClosures: pipeline.submittedClosures,
      ...(error ? { error } : {}),
      remainingPositions,
      workingOrders,
    };
  });
  const canceledOrders = accounts.reduce((sum, account) => sum + account.canceledOrders, 0);
  const submittedClosures = accounts.reduce((sum, account) => sum + account.submittedClosures, 0);
  const failedAccounts = accounts.filter(account => !account.ok).map(account => account.accountId);

  return {
    runtime: runtime.current,
    result: {
      operationId,
      accountIds,
      canceledOrders,
      submittedClosures,
      flat: accounts.every(account => account.remainingPositions === 0 && account.workingOrders === 0)
        && finalState.every(item => item.error === undefined),
      remainingPositionAccounts,
      workingOrderAccounts,
      accounts,
      failedAccounts,
    },
  };
}
