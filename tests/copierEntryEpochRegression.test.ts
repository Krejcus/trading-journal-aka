import { describe, expect, it } from 'vitest';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import { createLeaderFlatEpoch } from '../services/copierLeaderFlatGuard';
import type { BrokerOrder } from '../services/brokerPort';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const symbol = 'MNQU6';
async function setup(count = 1, phase: 'resolved' | 'invalidated' = 'resolved', explicitZero = false) {
  let time = 100;
  const group: CopyGroupConfig = { id: 'entry-regression', name: 'Offline', enabled: true, leaderAccountId: 100,
    followers: Array.from({ length: count }, (_, i) => ({ accountId: 200 + i, mode: 'on-submit', multiplier: 1 })) };
  const snapshot = emptySnapshot();
  snapshot.safety = { ...snapshot.safety!, leaderExposureEpochs: [{
    ...createLeaderFlatEpoch({ id: 'previous-trade', groupId: group.id, leaderAccountId: 100, symbol,
      openedAt: 1, leaderNet: -2, followers: [] }), phase, terminalAt: 2,
  }] };
  const store = createMemoryCopierStore(snapshot);
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
  if (explicitZero) broker.setPosition(100, symbol, 0);
  const controller = await bootstrapCopierRuntime({ broker, store, group, clock: () => ++time,
    leaderFlatGraceMs: 60000, followerTransitionCorrelationWindowMs: 60000, osoCorrelationWindowMs: 5 });
  const position = (accountId: number, netQuantity: number, instrument = symbol) => {
    broker.setPosition(accountId, instrument, netQuantity);
    broker.emitEvent({ type: 'position', position: { accountId, symbol: instrument, netQuantity } });
  };
  return { broker, store, controller, group, position };
}

describe('2026-09-14 first entry after an empty complete snapshot', () => {
  for (const count of [1, 6, 12]) for (const phase of ['resolved', 'invalidated'] as const) {
    for (const partials of [[-1, -5, -6], [-6]]) {
      it(`${count} followers, old ${phase}, entry ${partials.join('/')}: creates fresh ownership and reaches exit`, async () => {
        const { broker, store, controller, group, position } = await setup(count, phase);
        try {
          broker.setConnected(true); await controller.waitForIdle(); await controller.reconcile(); controller.arm();
          let id: string | undefined;
          for (const net of partials) {
            position(100, net);
            for (const f of group.followers) position(f.accountId, net);
            await controller.waitForIdle();
            expect(controller.status()).toMatchObject({ armed: true, lastError: null });
            const epoch = (await store.load()).safety!.leaderExposureEpochs![0];
            expect(epoch).toMatchObject({ phase: 'open', lastLeaderNet: net });
            expect(epoch.id).not.toBe('previous-trade');
            if (id) expect(epoch.id).toBe(id);
            id = epoch.id;
            expect(epoch.followers).toHaveLength(count);
            // Position equality alone must not manufacture copier ownership.
            expect(epoch.followers.every(f => f.eligibleAtOpen && f.copyLineage === 'unproven')).toBe(true);
          }
          position(100, 0);
          for (const f of group.followers) position(f.accountId, 0);
          await controller.waitForIdle();
          expect(controller.status()).toMatchObject({ armed: true, lastError: null });
          expect((await store.load()).safety!.leaderExposureEpochs![0]).toMatchObject({ id, phase: 'grace', lastLeaderNet: -6 });
          expect(broker.placedRequests()).toEqual([]);
          expect(broker.liquidateRequests()).toEqual([]);
        } finally { controller.stop(); }
      });
    }
  }

  it('does not infer a zero baseline without a snapshot, after a failed read or after disconnect', async () => {
    for (const mode of ['no-snapshot', 'failed-read', 'disconnect'] as const) {
      const { broker, store, controller, position } = await setup();
      try {
        if (mode !== 'no-snapshot') {
          if (mode === 'failed-read') broker.listPositions = async () => { throw new Error('snapshot-unavailable'); };
          broker.setConnected(true); await controller.waitForIdle();
          if (mode === 'failed-read') {
            await expect(controller.reconcile()).rejects.toThrow('snapshot-unavailable');
          } else {
            await controller.reconcile(); broker.setConnected(false); await controller.waitForIdle();
          }
        }
        position(100, -1);
        await controller.waitForIdle();
        expect((await store.load()).safety!.leaderExposureEpochs![0], mode).toMatchObject({ id: 'previous-trade' });
        expect(controller.status().armed).toBe(false);
        expect(broker.placedRequests()).toEqual([]);
      } finally { controller.stop(); }
    }
  });

  for (const fillFirst of [true, false]) it(`keeps actual copied brackets manageable with ${fillFirst ? 'Fill → Position' : 'Position → Fill'}`, async () => {
    const { broker, store, controller, group, position } = await setup(6);
    const order = (id: string, patch: Partial<BrokerOrder> = {}): BrokerOrder => ({
      tag: '', brokerOrderId: id, accountId: 100, symbol, side: 'Sell', orderType: 'Limit', quantity: 6,
      filledQuantity: 0, limitPrice: 28940, status: 'working', sourceVersion: '1', updatedAt: 100, ...patch,
    });
    try {
      broker.setConnected(true); await controller.waitForIdle(); await controller.reconcile(); controller.arm();
      broker.emitEvent({ type: 'order', order: order('entry') });
      broker.emitEvent({ type: 'order', order: order('stop', { parentOrderId: 'entry', side: 'Buy', orderType: 'Stop', limitPrice: undefined, stopPrice: 28959.5 }) });
      broker.emitEvent({ type: 'order', order: order('target', { parentOrderId: 'entry', side: 'Buy', limitPrice: 28881.25 }) });
      await controller.waitForIdle();
      expect(broker.placedOsoRequests()).toHaveLength(6);
      let net = 0;
      for (const [step, quantity] of [1, 4, 1].entries()) {
        net -= quantity;
        const fill = (accountId: number, brokerOrderId: string) => broker.emitEvent({ type: 'fill', fill: {
          fillId: `fill-${accountId}-${step}`, tag: '', brokerOrderId, accountId, symbol, side: 'Sell', quantity,
          price: 28940, filledAt: 1000 + step,
        } });
        if (fillFirst) fill(100, 'entry');
        position(100, net);
        if (!fillFirst) fill(100, 'entry');
        for (const f of group.followers) {
          const entry = broker.orders().find(o => o.accountId === f.accountId && o.side === 'Sell')!;
          entry.filledQuantity = -net; entry.status = net === -6 ? 'filled' : 'working';
          if (fillFirst) fill(f.accountId, entry.brokerOrderId);
          position(f.accountId, net);
          if (!fillFirst) fill(f.accountId, entry.brokerOrderId);
        }
        await controller.waitForIdle();
        expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      }
      expect((await store.load()).safety!.leaderExposureEpochs![0].followers).toEqual(
        expect.arrayContaining(group.followers.map(f => expect.objectContaining({ accountId: f.accountId,
          eligibleAtOpen: true, copyLineage: 'confirmed', confirmedNetQuantity: -6 }))));
      for (const [step, price] of [28939.25, 28938.25, 28937.25, 28936.5].entries()) {
        broker.emitEvent({ type: 'order', order: order('stop', { parentOrderId: 'entry', side: 'Buy',
          orderType: 'Stop', limitPrice: undefined, stopPrice: price, sourceVersion: String(step + 2) }) });
        await controller.waitForIdle();
        expect(controller.status()).toMatchObject({ armed: true, lastError: null });
        expect(broker.orders().filter(o => o.orderType === 'Stop').map(o => o.stopPrice)).toEqual(Array(6).fill(price));
      }
      expect(broker.modifyRequests()).toHaveLength(24);
      position(100, 0);
      for (const f of group.followers) position(f.accountId, 0);
      await controller.waitForIdle();
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      expect((await store.load()).safety!.leaderExposureEpochs![0]).toMatchObject({ phase: 'grace', lastLeaderNet: -6 });
      expect(broker.placedOsoRequests()).toHaveLength(6);
    } finally { controller.stop(); }
  });
});
