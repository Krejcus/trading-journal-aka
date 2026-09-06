import {
  isOpenOrderStatus,
  type BrokerLiquidateResult,
  type BrokerOrder,
  type BrokerPort,
} from './brokerPort';
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
  isLiquidationOutboxEntry,
  markAcknowledged,
  markLiquidationAwaitingCleanup,
  markLiquidationConfirmedByState,
  markLiquidationResult,
  markLiquidationSending,
  markRejected,
  markSending,
  markUnknown,
  resolveLookup,
} from './copierOutbox';
import { netQuantityForSymbol } from './copierLiquidationRecovery';
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

export interface ManualFlattenTarget {
  accountId: number;
  symbol: string;
}

export interface ManualFlattenOptions {
  runtime: CopierRuntime;
  broker: BrokerPort;
  store: CopierStore;
  groupId: string;
  accountIds?: readonly number[];
  /** Přesný symbolový scope pro policy-gated automatické risk-reduction. */
  targets?: readonly ManualFlattenTarget[];
  cleanupScope?: 'account' | 'target-symbol';
  /** Guard nikdy nesmí spadnout na cancel + Market fallback. */
  nativeOnly?: boolean;
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
 * Explicitní ruční Flatten. Native liquidate nejdřív stavově zavře pozici,
 * autoritativně potvrdí exact-symbol flat a teprve potom dočistí aktivní
 * příkazy. Fallback Market zachovává cancel → close, protože není stavový.
 * Nejasný výsledek se nikdy slepě neopakuje se stejným operationId.
 */
export async function processManualFlatten(options: ManualFlattenOptions): Promise<{
  runtime: CopierRuntime;
  result: ManualFlattenResult;
}> {
  const operationId = operationToken(options.operationId);
  const targetSymbolsByAccount = new Map<number, Set<string>>();
  for (const target of options.targets ?? []) {
    const symbol = target.symbol.trim();
    if (!Number.isSafeInteger(target.accountId) || target.accountId <= 0 || symbol.length === 0) {
      throw new Error('Flatten má neplatný account/symbol target');
    }
    const symbols = targetSymbolsByAccount.get(target.accountId) ?? new Set<string>();
    symbols.add(symbol);
    targetSymbolsByAccount.set(target.accountId, symbols);
  }
  const accountIds = [...new Set(
    options.accountIds ?? [...targetSymbolsByAccount.keys()],
  )];
  if (accountIds.length === 0 || accountIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('Flatten nemá platný cílový účet');
  }
  const cleanupScope = options.cleanupScope ?? 'account';
  if (cleanupScope === 'target-symbol') {
    if (targetSymbolsByAccount.size === 0 || accountIds.some(id => !targetSymbolsByAccount.has(id))) {
      throw new Error('Symbolově cílený Flatten vyžaduje target pro každý účet');
    }
  }
  if (options.nativeOnly && !options.broker.liquidatePosition) {
    throw new Error('Symbolově cílený auto-close vyžaduje broker-native liquidatePosition');
  }
  const symbolInScope = (accountId: number, symbol: string) => cleanupScope === 'account'
    || targetSymbolsByAccount.get(accountId)?.has(symbol) === true;

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

  const confirmPositionFlat = async (accountId: number, symbol: string) => {
    let netQuantity: number | null = null;
    for (let attempt = 0; attempt < confirmationAttempts; attempt += 1) {
      if (attempt > 0) await wait(confirmationPollMs);
      const positionsBefore = await options.broker.listPositions(accountId);
      const orders = await options.broker.listOrders(accountId);
      const positionsAfter = await options.broker.listPositions(accountId);
      const beforeNet = netQuantityForSymbol(positionsBefore, accountId, symbol);
      netQuantity = netQuantityForSymbol(positionsAfter, accountId, symbol);
      if (beforeNet === 0 && netQuantity === 0) {
        return {
          flat: true as const,
          netQuantity,
          workingOrders: orders.filter(order => (
            order.accountId === accountId
            && order.symbol === symbol
            && isOpenOrderStatus(order.status)
          )),
        };
      }
    }
    return { flat: false as const, netQuantity, workingOrders: [] as BrokerOrder[] };
  };

  // Každý worker zpracuje účet samostatně. Když broker umí stavové nativní
  // liquidate, zavíráme nejdřív skutečnou venue pozici a teprve potom
  // dočišťujeme případné orphan working orders. Starý unknown cancel/modify
  // tak nikdy nestojí před risk-redukčním close. Fallback bez nativního
  // liquidate zachovává bezpečné pořadí cancel → přesný Market close.
  const pipelineResults = await mapWithConcurrency(accountIds, accountConcurrency, async accountId => {
    let canceledOrders = 0;
    let submittedClosures = 0;
    try {
      const closeKnownPositions = async () => {
        const positions = (await options.broker.listPositions(accountId))
          .filter(position => position.netQuantity !== 0 && symbolInScope(accountId, position.symbol));
        for (const position of positions) {
          const plan = planFlatten(options.groupId, position, `${operationId}:${position.symbol}`);
          if (!plan) continue;
          let entry = runtime.current.outbox.get(plan.key);
          if (!entry) {
            const created = createOutboxEntry(
              plan.key,
              plan.request.tag,
              `manual-flatten:${operationId}:${position.symbol}`,
              plan.request,
              options.clock(),
              false,
              `manual-flatten:${operationId}`,
              runtime.current.state.lastSequence,
            );
            entry = options.broker.liquidatePosition
              ? { ...created, operationKind: 'liquidate-position' }
              : { ...created, operationKind: 'place-order' };
            runtime.current.outbox.set(plan.key, entry);
            await commitSerialized();
          }

          if (options.broker.liquidatePosition) {
            // `planned` bez pokusu je jediný bezpečně odeslatelný stav. Po
            // sending/unknown/rejected ani po starém ACK se stejný operationId
            // znovu neposílá; pouze čeká na autoritativní cílový stav.
            if (entry.status === 'planned' && entry.attempts === 0) {
              entry = markLiquidationSending(entry, options.clock());
              runtime.current.outbox.set(plan.key, entry);
              await commitSerialized();
              let result: BrokerLiquidateResult;
              try {
                result = await options.broker.liquidatePosition({
                  tag: entry.tag,
                  accountId,
                  symbol: position.symbol,
                });
              } catch (reason) {
                result = { status: 'indeterminate', reason: errorMessage(reason) };
              }
              entry = markLiquidationResult(entry, result, options.clock());
              runtime.current.outbox.set(plan.key, entry);
              await commitSerialized();
              if (result.status === 'submitted') submittedClosures += 1;
            }

            const confirmed = await confirmPositionFlat(accountId, position.symbol);
            if (!confirmed.flat) {
              throw new Error(
                `Flatten close ${position.symbol} není potvrzen stavem (net=${confirmed.netQuantity ?? 'neznámé'}); blind retry stejného operationId je zakázaný`,
              );
            }
            entry = markLiquidationAwaitingCleanup(entry, options.clock());
            runtime.current.outbox.set(plan.key, entry);
            await commitSerialized();
            continue;
          }

          if (entry.status === 'acknowledged') continue;
          if (
            entry.status === 'confirmed-by-state'
            || entry.status === 'rejected'
            || entry.status === 'abandoned'
            || entry.status === 'waived'
          ) {
            throw new Error(`Flatten close ${position.symbol} skončil jako ${entry.status}`);
          }
          if (entry.status === 'sending' || entry.status === 'unknown') {
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
      };

      if (options.broker.liquidatePosition) await closeKnownPositions();

      const working = (await options.broker.listOrders(accountId)).filter(order => (
        isOpenOrderStatus(order.status) && symbolInScope(accountId, order.symbol)
      ));
      for (const order of working) {
        if (options.broker.liquidatePosition) {
          const confirmed = await confirmPositionFlat(accountId, order.symbol);
          if (!confirmed.flat) {
            throw new Error(
              `Flatten cleanup ${order.symbol} není bezpečný: exact-symbol flat důkaz před cancel chybí (net=${confirmed.netQuantity ?? 'neznámé'})`,
            );
          }
        }
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
      if (!options.broker.liquidatePosition) await closeKnownPositions();
      return { accountId, canceledOrders, submittedClosures };
    } catch (reason) {
      return { accountId, canceledOrders, submittedClosures, error: errorMessage(reason) };
    }
  });

  throwIfCommitFailed();

  let finalState: Array<{
    accountId: number;
    positionsBefore: Awaited<ReturnType<BrokerPort['listPositions']>>;
    orders: Awaited<ReturnType<BrokerPort['listOrders']>>;
    positionsAfter: Awaited<ReturnType<BrokerPort['listPositions']>>;
    error?: string;
  }> = [];
  for (let attempt = 0; attempt < confirmationAttempts; attempt += 1) {
    if (attempt > 0) await wait(confirmationPollMs);
    finalState = await Promise.all(accountIds.map(async accountId => {
      try {
        const positionsBefore = await options.broker.listPositions(accountId);
        const orders = await options.broker.listOrders(accountId);
        const positionsAfter = await options.broker.listPositions(accountId);
        return {
          accountId,
          positionsBefore,
          orders,
          positionsAfter,
        };
      } catch (reason) {
        return {
          accountId,
          positionsBefore: [],
          orders: [],
          positionsAfter: [],
          error: errorMessage(reason),
        };
      }
    }));
    if (finalState.every(item => (
      !('error' in item)
      && item.positionsBefore.every(position => (
        !symbolInScope(item.accountId, position.symbol) || position.netQuantity === 0
      ))
      && item.orders.every(order => (
        !symbolInScope(item.accountId, order.symbol) || !isOpenOrderStatus(order.status)
      ))
      && item.positionsAfter.every(position => (
        !symbolInScope(item.accountId, position.symbol) || position.netQuantity === 0
      ))
    ))) break;
  }
  const remainingPositionAccounts = finalState
    .filter(item => item.positionsBefore.some(position => (
      symbolInScope(item.accountId, position.symbol) && position.netQuantity !== 0
    )) || item.positionsAfter.some(position => (
      symbolInScope(item.accountId, position.symbol) && position.netQuantity !== 0
    )))
    .map(item => item.accountId);
  const workingOrderAccounts = finalState
    .filter(item => item.orders.some(order => (
      symbolInScope(item.accountId, order.symbol) && isOpenOrderStatus(order.status)
    )))
    .map(item => item.accountId);
  const accounts = accountIds.map((accountId, index): ManualFlattenAccountResult => {
    const pipeline = pipelineResults[index];
    const final = finalState[index];
    const remainingPositions = Math.max(
      final.positionsBefore.filter(position => (
        symbolInScope(accountId, position.symbol) && position.netQuantity !== 0
      )).length,
      final.positionsAfter.filter(position => (
        symbolInScope(accountId, position.symbol) && position.netQuantity !== 0
      )).length,
    );
    const workingOrders = final.orders.filter(order => (
      symbolInScope(accountId, order.symbol) && isOpenOrderStatus(order.status)
    )).length;
    const verificationError = final.error;
    const stateSafe = verificationError === undefined
      && remainingPositions === 0
      && workingOrders === 0;
    const error = stateSafe
      ? undefined
      : (pipeline.error
      ?? (verificationError ? `Finální kontrola selhala: ${verificationError}` : undefined)
      ?? (remainingPositions > 0 ? `Po finální kontrole zbývá ${remainingPositions} otevřených pozic` : undefined)
      ?? (workingOrders > 0 ? `Po finální kontrole zbývá ${workingOrders} working orderů` : undefined)
      ?? undefined);
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

  // Čistý finální position → orders → position důkaz uzavře nové i legacy
  // manual-liquidate položky pro bezpečné účty. Původní odpověď zůstává
  // v liquidationAttempt; nikdy ji nepřepisujeme falešným broker ACKem.
  let confirmedLiquidations = false;
  for (const final of finalState) {
    if (
      final.error
      || final.positionsBefore.some(position => (
        symbolInScope(final.accountId, position.symbol) && position.netQuantity !== 0
      ))
      || final.orders.some(order => (
        symbolInScope(final.accountId, order.symbol) && isOpenOrderStatus(order.status)
      ))
      || final.positionsAfter.some(position => (
        symbolInScope(final.accountId, position.symbol) && position.netQuantity !== 0
      ))
    ) continue;
    for (const [key, entry] of runtime.current.outbox) {
      if (
        !isLiquidationOutboxEntry(entry)
        || entry.request.accountId !== final.accountId
        || !symbolInScope(final.accountId, entry.request.symbol)
        || entry.status === 'confirmed-by-state'
      ) continue;
      const symbolWorking = final.orders.some(order => (
        order.symbol === entry.request.symbol && isOpenOrderStatus(order.status)
      ));
      const symbolNetBefore = netQuantityForSymbol(
        final.positionsBefore, final.accountId, entry.request.symbol,
      );
      const symbolNetAfter = netQuantityForSymbol(
        final.positionsAfter, final.accountId, entry.request.symbol,
      );
      if (symbolWorking || symbolNetBefore !== 0 || symbolNetAfter !== 0) continue;
      runtime.current.outbox.set(key, markLiquidationConfirmedByState(entry, {
        accountId: final.accountId,
        symbol: entry.request.symbol,
        observedAt: options.clock(),
        source: 'final-check',
      }));
      confirmedLiquidations = true;
    }
  }
  if (confirmedLiquidations) await commitSerialized();
  throwIfCommitFailed();

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

export type TargetedLiquidationOptions = Omit<
  ManualFlattenOptions,
  'accountIds' | 'targets' | 'cleanupScope' | 'nativeOnly'
> & {
  targets: readonly ManualFlattenTarget[];
};

/**
 * Reusable risk-reduction primitive pro LeaderFlatGuard. Oproti ručnímu
 * account-wide Flattenu smí sáhnout pouze na explicitní account/symbol cíle
 * a nikdy nepoužije Market fallback.
 */
export function processTargetedLiquidation(options: TargetedLiquidationOptions) {
  return processManualFlatten({
    ...options,
    accountIds: [...new Set(options.targets.map(target => target.accountId))],
    cleanupScope: 'target-symbol',
    nativeOnly: true,
  });
}
