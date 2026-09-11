import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import { cloneDayRuleActions, DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';

const symbol = 'MNQU6';
const group: CopyGroupConfig = {
  id: 'stale-exposure', name: 'Regression', enabled: true, leaderAccountId: 100,
  followers: [200, 300].map(accountId => ({ accountId, mode: 'on-submit', multiplier: 1 })),
  safety: { ...DEFAULT_COPY_GROUP_SAFETY, armExpiryFlatten: 'off', entryCooldownMinutes: 0 },
};

const order = (side: 'Buy' | 'Sell', overrides: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'new-entry', accountId: 100, symbol, side,
  orderType: 'Limit', quantity: 15, filledQuantity: 0, limitPrice: 29_450,
  status: 'working', sourceVersion: '1:Working', updatedAt: 100, ...overrides,
});

describe('new entry after a stale leader exposure epoch', () => {
  it.each([false, true])('orders respect the newest evidence during a pause (new flat Position=%s)', async newerFlatPosition => {
    let now = Date.parse('2026-01-15T20:59:00.000Z');
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 29_450 }) });
    const actions = cloneDayRuleActions(DEFAULT_COPY_GROUP_SAFETY.dayRuleActions);
    actions.windowEnd.atEnd = { kind: 'pause', minutes: 10 };
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), clock: () => now,
      followerTransitionCorrelationWindowMs: 60_000,
      group: { ...group, safety: {
        ...group.safety!, dayRuleActions: actions,
        tradingWindow: { enabled: true, from: '15:30', to: '22:00', timeZone: 'Europe/Prague' },
      } },
    });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      broker.emitEvent({ type: 'order', order: order('Buy', {
        orderType: 'Market', limitPrice: undefined, updatedAt: now,
      }) });
      await controller.waitForIdle();
      broker.emitEvent({ type: 'fill', fill: {
        fillId: 'entry-filled-before-position', tag: '', brokerOrderId: 'new-entry',
        accountId: 100, symbol, side: 'Buy', quantity: 15, price: 29_450, filledAt: now,
      } });
      await controller.waitForIdle();
      if (newerFlatPosition) {
        // The closing Position arrives before the closing Fill. The old long
        // lot must now NOT turn a new short entry into a pause-exempt exit.
        broker.emitEvent({ type: 'position', position: { accountId: 100, symbol, netQuantity: 15 } });
        broker.emitEvent({ type: 'position', position: { accountId: 100, symbol, netQuantity: 0 } });
        for (const accountId of [200, 300]) {
          broker.setPosition(accountId, symbol, 0);
          broker.emitEvent({ type: 'position', position: { accountId, symbol, netQuantity: 0 } });
        }
        await controller.waitForIdle();
      }
      now = Date.parse('2026-01-15T21:00:00.000Z');
      broker.emitEvent({ type: 'heartbeat', at: now });
      await controller.waitForIdle();
      expect(controller.status().pause?.rule).toBe('window-end');
      broker.emitEvent({ type: 'order', order: order('Sell', {
        brokerOrderId: 'actual-exit', orderType: 'Market', limitPrice: undefined,
        sourceVersion: '2:Working', updatedAt: now,
      }) });
      await controller.waitForIdle();
      expect(broker.placedRequests().filter(request => request.side === 'Sell')).toEqual(
        newerFlatPosition ? []
          : [200, 300].map(accountId => expect.objectContaining({ accountId, side: 'Sell', quantity: 15 })),
      );
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(broker.liquidateRequests()).toEqual([]);
    } finally {
      controller.stop();
    }
  });

  for (const path of ['standard', 'oso', 'fill-only'] as const) {
    for (const flatSource of ['empty-snapshot', 'explicit-zero'] as const) {
      it.each(['Buy', 'Sell'] as const)(`${path}, ${flatSource}: new %s stays armed and copies both followers`, async side => {
        const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
        const initial = emptySnapshot();
        const store = createMemoryCopierStore({
          ...initial,
          safety: {
            ...initial.safety!,
            leaderExposureEpochs: [{
              id: 'old-trade', groupId: group.id, leaderAccountId: 100, symbol,
              openedAt: 50, lastLeaderNet: side === 'Sell' ? 15 : -15,
              generation: 1, phase: 'blocked',
              followers: [200, 300].map(accountId => ({
                accountId, replicationModeAtOpen: 'on-submit', eligibleAtOpen: true,
                copyLineage: 'unproven',
              })),
              leaderEntryOrderIds: ['old-entry'], leaderExitOrderIds: [],
            }],
          },
        });
        if (flatSource === 'explicit-zero') broker.setPosition(100, symbol, 0);
        let now = 100;
        const controller = await bootstrapCopierRuntime({
          broker, store,
          group: path === 'fill-only'
            ? { ...group, followers: group.followers.map(follower => ({ ...follower, mode: 'on-fill' })) }
            : group,
          clock: () => ++now, osoCorrelationWindowMs: 50,
        });
        try {
          broker.setConnected(true);
          await controller.waitForIdle();
          await controller.reconcile();
          expect((await store.load()).safety?.leaderExposureEpochs).toContainEqual(
            expect.objectContaining({ id: 'old-trade', phase: 'blocked' }),
          );
          controller.arm();
          if (path === 'fill-only') {
            broker.emitEvent({ type: 'fill', fill: {
              fillId: 'new-fill', tag: '', brokerOrderId: 'new-entry', accountId: 100,
              symbol, side, quantity: 15, price: 29_450, filledAt: ++now,
            } });
          } else {
            broker.emitEvent({ type: 'order', order: order(side, path === 'standard'
              ? { orderType: 'Market', limitPrice: undefined }
              : {}) });
          }
          if (path === 'oso') {
            const exitSide = side === 'Buy' ? 'Sell' : 'Buy';
            broker.emitEvent({ type: 'order', order: order(exitSide, {
              brokerOrderId: 'new-stop', parentOrderId: 'new-entry', orderType: 'Stop',
              limitPrice: undefined, stopPrice: side === 'Buy' ? 29_400 : 29_500,
            }) });
            broker.emitEvent({ type: 'order', order: order(exitSide, {
              brokerOrderId: 'new-target', parentOrderId: 'new-entry',
              limitPrice: side === 'Buy' ? 29_550 : 29_350,
            }) });
          }
          await controller.waitForIdle();
          expect(controller.status()).toMatchObject({ armed: true, lastError: null });
          const copied = path === 'oso' ? broker.placedOsoRequests() : broker.placedRequests();
          expect(copied).toEqual([200, 300].map(accountId => expect.objectContaining({
            accountId, side, quantity: 15,
          })));
          expect(broker.liquidateRequests()).toEqual([]);
          expect(broker.orders().filter(item => item.status === 'canceled')).toEqual([]);
        } finally {
          controller.stop();
        }
      });
    }
  }
});
