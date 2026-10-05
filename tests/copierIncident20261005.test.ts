import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';

// Incident 5. 10. 2026 15:04 UTC: leader OSO Buy 18, vyplněno 1 a pak 5.
// Lucid followeři (stejné připojení jako leader) dostali Fill+Position
// přírůstku dřív než leader; jejich lineage zůstala potvrzená jen na 1.

const symbol = 'MNQZ6';

async function setup(count = 2, marketFills = false) {
  let time = 100;
  const group: CopyGroupConfig = {
    id: 'incident-20261005', name: 'Hlavní', enabled: true, leaderAccountId: 100,
    followers: Array.from({ length: count }, (_, i) => ({ accountId: 200 + i, mode: 'on-submit', multiplier: 1 })),
  };
  const store = createMemoryCopierStore();
  const broker = createMockBroker({
    behavior: request => (marketFills && request.orderType === 'Market'
      ? { kind: 'fill', price: 31_243.5 }
      : { kind: 'working' }),
  });
  const controller = await bootstrapCopierRuntime({
    broker, store, group, clock: () => ++time,
    leaderFlatGraceMs: 60000, followerTransitionCorrelationWindowMs: 60000, osoCorrelationWindowMs: 5,
  });
  const position = (accountId: number, netQuantity: number) => {
    broker.setPosition(accountId, symbol, netQuantity);
    broker.emitEvent({ type: 'position', position: { accountId, symbol, netQuantity } });
  };
  const order = (id: string, patch: Partial<BrokerOrder> = {}): BrokerOrder => ({
    tag: '', brokerOrderId: id, accountId: 100, symbol, side: 'Buy', orderType: 'Limit', quantity: 18,
    filledQuantity: 0, limitPrice: 31241.5, status: 'working', sourceVersion: '1', updatedAt: 100, ...patch,
  });
  return { broker, store, controller, group, position, order };
}

describe('incident 5. 10. 2026 — částečně vyplněný OSO vstup', () => {
  it('lineage followera se potvrdí i když jeho Fill+Position dorazí před leaderovým', async () => {
    const { broker, store, controller, group, position, order } = await setup(2);
    try {
      broker.setConnected(true); await controller.waitForIdle(); await controller.reconcile(); controller.arm();
      broker.emitEvent({ type: 'order', order: order('entry') });
      broker.emitEvent({ type: 'order', order: order('stop', {
        parentOrderId: 'entry', side: 'Sell', orderType: 'Stop', limitPrice: undefined, stopPrice: 31230.5,
      }) });
      broker.emitEvent({ type: 'order', order: order('target', { parentOrderId: 'entry', side: 'Sell', limitPrice: 31282 }) });
      await controller.waitForIdle();
      expect(broker.placedOsoRequests()).toHaveLength(2);
      let net = 0;
      for (const [step, quantity] of [1, 5].entries()) {
        net += quantity;
        const fill = (accountId: number, brokerOrderId: string) => broker.emitEvent({ type: 'fill', fill: {
          fillId: `fill-${accountId}-${step}`, tag: '', brokerOrderId, accountId, symbol, side: 'Buy', quantity,
          price: 31241.5, filledAt: 1000 + step,
        } });
        // Pořadí z incidentu: nejdřív followeři, teprve potom leader.
        for (const f of group.followers) {
          const entry = broker.orders().find(o => o.accountId === f.accountId && o.side === 'Buy')!;
          entry.filledQuantity = net;
          fill(f.accountId, entry.brokerOrderId);
          position(f.accountId, net);
        }
        fill(100, 'entry');
        position(100, net);
        await controller.waitForIdle();
        expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      }
      expect((await store.load()).safety!.leaderExposureEpochs![0].followers).toEqual(
        expect.arrayContaining(group.followers.map(f => expect.objectContaining({
          accountId: f.accountId, eligibleAtOpen: true, copyLineage: 'confirmed', confirmedNetQuantity: 6,
        }))),
      );
    } finally {
      controller.stop();
    }
  });

  it.each([false, true])('leader zruší zbytek vstupu po vyplnění 6 z 18: zbytek se zruší i followerům a exit 6 se zkopíruje (exit ve frontě dřív než potvrzení zrušení: %s)', async exitRace => {
    const { broker, store, controller, group, position, order } = await setup(2, true);
    try {
      broker.setConnected(true); await controller.waitForIdle(); await controller.reconcile(); controller.arm();
      broker.emitEvent({ type: 'order', order: order('entry') });
      broker.emitEvent({ type: 'order', order: order('stop', {
        parentOrderId: 'entry', side: 'Sell', orderType: 'Stop', limitPrice: undefined, stopPrice: 31230.5,
      }) });
      broker.emitEvent({ type: 'order', order: order('target', { parentOrderId: 'entry', side: 'Sell', limitPrice: 31282 }) });
      await controller.waitForIdle();
      expect(broker.placedOsoRequests()).toHaveLength(2);
      const followerEntries = group.followers.map(f => broker.orders()
        .find(o => o.accountId === f.accountId && o.side === 'Buy' && o.orderType === 'Limit')!);
      let net = 0;
      for (const [step, quantity] of [1, 5].entries()) {
        net += quantity;
        const fill = (accountId: number, brokerOrderId: string) => broker.emitEvent({ type: 'fill', fill: {
          fillId: `fill-${accountId}-${step}`, tag: '', brokerOrderId, accountId, symbol, side: 'Buy', quantity,
          price: 31241.5, filledAt: 1000 + step,
        } });
        for (const [index, f] of group.followers.entries()) {
          followerEntries[index].filledQuantity = net;
          fill(f.accountId, followerEntries[index].brokerOrderId);
          position(f.accountId, net);
        }
        fill(100, 'entry');
        position(100, net);
        await controller.waitForIdle();
      }
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });

      // Tradovate Exit: zruší stop, zbytek vstupu (6/18 vyplněno) a target.
      broker.emitEvent({ type: 'order', order: order('stop', {
        parentOrderId: 'entry', side: 'Sell', orderType: 'Stop', limitPrice: undefined, stopPrice: 31230.5,
        status: 'canceled', sourceVersion: '2', quantity: 6,
      }) });
      broker.emitEvent({ type: 'order', order: order('entry', {
        status: 'canceled', filledQuantity: 6, sourceVersion: '2:Filled:partial-cancel',
      }) });
      broker.emitEvent({ type: 'order', order: order('target', {
        parentOrderId: 'entry', side: 'Sell', limitPrice: 31282, status: 'canceled', sourceVersion: '2', quantity: 6,
      }) });
      const exit = order('exit', { side: 'Sell', orderType: 'Market', quantity: 6, limitPrice: undefined, status: 'working' });
      // Incident: leader Market dorazil 230 ms po zrušení, dřív než potvrzení
      // zrušení u followerů (ta se zařadí do fronty až za něj).
      if (exitRace) broker.emitEvent({ type: 'order', order: exit });
      await controller.waitForIdle();
      for (const entry of followerEntries) {
        expect(broker.cancelRequestCount(entry.brokerOrderId)).toBe(1);
        expect(broker.orders().find(o => o.brokerOrderId === entry.brokerOrderId)?.status).toBe('canceled');
      }
      if (!exitRace) broker.emitEvent({ type: 'order', order: exit });
      await controller.waitForIdle();
      broker.emitEvent({ type: 'fill', fill: {
        fillId: 'leader-exit', tag: '', brokerOrderId: 'exit', accountId: 100, symbol, side: 'Sell', quantity: 6,
        price: 31243.75, filledAt: 2000,
      } });
      position(100, 0);
      await controller.waitForIdle();
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      const exits = broker.placedRequests().filter(request => request.side === 'Sell' && request.orderType === 'Market');
      expect(exits.map(request => [request.accountId, request.quantity]).sort())
        .toEqual(group.followers.map(f => [f.accountId, 6]).sort());
      for (const f of group.followers) expect((await broker.listPositions(f.accountId)).every(p => p.netQuantity === 0)).toBe(true);
      expect((await store.load()).safety!.leaderExposureEpochs?.every(epoch => epoch.phase !== 'blocked') ?? true).toBe(true);
    } finally {
      controller.stop();
    }
  });
});
