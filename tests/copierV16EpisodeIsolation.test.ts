import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
import type { CopierAuditEntry } from '../services/copierRunner';
import { createMockBroker, type MockBroker } from '../services/mockBroker';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const SYMBOL = 'MNQU6';

const stepClock = () => {
  let value = Date.parse('2026-09-28T14:35:00.000Z');
  return () => ++value;
};

const groupWithFollowers = (accountIds: readonly number[]): CopyGroupConfig => ({
  id: 'v16-episode-isolation',
  name: 'V16 episode isolation',
  enabled: true,
  leaderAccountId: 100,
  followers: accountIds.map(accountId => ({
    accountId,
    mode: 'on-submit' as const,
    multiplier: 1,
  })),
});

const leaderOrder = (partial: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '',
  brokerOrderId: 'leader-entry',
  accountId: 100,
  symbol: SYMBOL,
  side: 'Buy',
  orderType: 'Market',
  quantity: 1,
  filledQuantity: 0,
  status: 'working',
  sourceVersion: '1:Working',
  updatedAt: 1,
  ...partial,
});

const positionEvent = (accountId: number, netQuantity: number) => ({
  type: 'position' as const,
  position: { accountId, symbol: SYMBOL, netQuantity },
});

const openLeaderEpisode = async (
  broker: MockBroker,
  controller: Awaited<ReturnType<typeof bootstrapCopierRuntime>>,
) => {
  broker.emitEvent({ type: 'order', order: leaderOrder() });
  await controller.waitForIdle();
  broker.setPosition(100, SYMBOL, 1);
  broker.emitEvent(positionEvent(100, 1));
  await controller.waitForIdle();
};

const boot = async ({
  followers,
  exclusions,
}: {
  followers: readonly number[];
  exclusions: Array<{
    accountId: number;
    state: 'breached' | 'dll-locked' | 'unverifiable';
    reason: string;
  }>;
}) => {
  const audits: CopierAuditEntry[] = [];
  const unavailable = new Set(
    exclusions.filter(exclusion => exclusion.state === 'unverifiable').map(exclusion => exclusion.accountId),
  );
  const broker = createMockBroker({
    behavior: request => request.orderType === 'Market'
      ? { kind: 'fill', price: 30_000 }
      : { kind: 'working' },
    ...(unavailable.size > 0 ? {
      accountCapabilities: [100, ...followers]
        .filter(accountId => !unavailable.has(accountId))
        .map(accountId => ({ accountId, active: true, canTrade: true })),
    } : {}),
  });
  const initial = emptySnapshot();
  const unverifiable = exclusions.filter(exclusion => exclusion.state === 'unverifiable');
  if (unverifiable.length > 0) {
    initial.safety = {
      entryCooldownUntil: 0,
      dayLockUntil: 0,
      accountEligibility: unverifiable.map(exclusion => ({
        ...exclusion,
        at: Date.parse('2026-09-28T14:34:00.000Z'),
      })),
    };
  }
  const controller = await bootstrapCopierRuntime({
    broker,
    store: createMemoryCopierStore(initial),
    group: groupWithFollowers(followers),
    clock: stepClock(),
    onAudit: entries => audits.push(...entries),
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  await controller.applyAccountEligibilityExclusions(
    exclusions.filter(exclusion => exclusion.state !== 'unverifiable') as Array<{
      accountId: number;
      state: 'breached' | 'dll-locked';
      reason: string;
    }>,
  );
  controller.arm();
  await openLeaderEpisode(broker, controller);
  return { audits, broker, controller };
};

describe('V16 — episode-bound izolace ineligible followera', () => {
  it('čtyři BREACHED skipy neblokují SL ani exit zdravému followerovi a skupinu neodzbrojí', async () => {
    const breached = [300, 301, 302, 303];
    const { audits, broker, controller } = await boot({
      followers: [200, ...breached],
      exclusions: breached.map(accountId => ({
        accountId,
        state: 'breached' as const,
        reason: 'propka účet zlikvidovala',
      })),
    });
    try {
      expect(audits.filter(entry => (
        entry.kind === 'skipped'
        && breached.includes(entry.accountId ?? -1)
        && entry.reason === 'account-ineligible'
      ))).toHaveLength(4);

      const beforeProtection = broker.placedRequests().length;
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'leader-stop',
        side: 'Sell',
        orderType: 'Stop',
        stopPrice: 29_950,
        sourceVersion: '1:Working:stop',
      }) });
      await controller.waitForIdle();
      expect(broker.placedRequests().slice(beforeProtection)).toEqual([
        expect.objectContaining({ accountId: 200, side: 'Sell', orderType: 'Stop' }),
      ]);
      expect(controller.status()).toMatchObject({ armed: true, divergentAccounts: [], lastError: null });

      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'leader-stop',
        side: 'Sell',
        orderType: 'Stop',
        stopPrice: 29_950,
        status: 'canceled',
        sourceVersion: '2:Canceled:stop',
      }) });
      await controller.waitForIdle();

      const beforeExit = broker.placedRequests().length;
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'leader-exit',
        side: 'Sell',
        sourceVersion: '1:Working:exit',
      }) });
      await controller.waitForIdle();
      expect(broker.placedRequests().slice(beforeExit)).toEqual([
        expect.objectContaining({ accountId: 200, side: 'Sell', orderType: 'Market' }),
      ]);
      expect(controller.status()).toMatchObject({ armed: true, divergentAccounts: [], lastError: null });
    } finally {
      controller.stop();
    }
  });

  it('BREACHED follower s kopií z dřívější epizody zůstává fail-closed', async () => {
    const { broker, controller } = await boot({
      followers: [200, 300],
      exclusions: [{ accountId: 300, state: 'breached', reason: 'propka účet zlikvidovala' }],
    });
    try {
      broker.setPosition(300, SYMBOL, 1);
      const beforeExit = broker.placedRequests().length;
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'leader-exit-with-stale-copy', side: 'Sell', sourceVersion: '2:Working',
      }) });
      await controller.waitForIdle();

      expect(controller.status()).toMatchObject({
        armed: false,
        divergentAccounts: [300],
        lastError: expect.stringContaining('nevysvětlená divergence'),
      });
      expect(broker.placedRequests().slice(beforeExit)).toEqual([
        expect.objectContaining({
          accountId: 200, side: 'Sell', orderType: 'Market', quantity: 1,
        }),
      ]);
    } finally {
      controller.stop();
    }
  });

  it('unverifiable follower není izolovaný a zůstává fail-closed', async () => {
    const { broker, controller } = await boot({
      followers: [200, 300],
      exclusions: [{ accountId: 300, state: 'unverifiable', reason: 'OAuth účet nelze ověřit' }],
    });
    try {
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'leader-exit-unverifiable', side: 'Sell', sourceVersion: '2:Working',
      }) });
      await controller.waitForIdle();

      expect(controller.status()).toMatchObject({
        armed: false,
        divergentAccounts: [300],
        lastError: expect.stringContaining('nevysvětlená divergence'),
      });
    } finally {
      controller.stop();
    }
  });

  it('DLL-locked follower bez kopie je izolovaný jen pro aktuální epizodu', async () => {
    const { broker, controller } = await boot({
      followers: [200, 300],
      exclusions: [{ accountId: 300, state: 'dll-locked', reason: 'daily loss limit' }],
    });
    try {
      const beforeExit = broker.placedRequests().length;
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'leader-exit-dll', side: 'Sell', sourceVersion: '2:Working',
      }) });
      await controller.waitForIdle();

      expect(broker.placedRequests().slice(beforeExit)).toEqual([
        expect.objectContaining({ accountId: 200, side: 'Sell' }),
      ]);
      expect(controller.status()).toMatchObject({ armed: true, divergentAccounts: [], lastError: null });
    } finally {
      controller.stop();
    }
  });

  it('reconcile použije stejné pravidlo a pracovní příkaz BREACHED followera neprohlásí za izolaci', async () => {
    const { broker, controller } = await boot({
      followers: [200, 300],
      exclusions: [{ accountId: 300, state: 'breached', reason: 'propka účet zlikvidovala' }],
    });
    try {
      await broker.placeOrder({
        tag: 'stale-working-entry',
        accountId: 300,
        symbol: SYMBOL,
        side: 'Buy',
        quantity: 1,
        orderType: 'Limit',
        limitPrice: 29_900,
      });
      await controller.waitForIdle();
      await controller.reconcile();

      expect(controller.status()).toMatchObject({
        armed: false,
        reconciliationRequired: true,
        divergentAccounts: [300],
      });
    } finally {
      controller.stop();
    }
  });

  it('reconcile přijme stejný episode-bound flat/no-working důkaz jako live divergence kontrola', async () => {
    const { controller } = await boot({
      followers: [200, 300],
      exclusions: [{ accountId: 300, state: 'breached', reason: 'propka účet zlikvidovala' }],
    });
    try {
      await controller.reconcile();

      expect(controller.status()).toMatchObject({
        armed: false,
        divergentAccounts: [],
        workingOrderAccounts: [],
        lastError: null,
      });
    } finally {
      controller.stop();
    }
  });
});
