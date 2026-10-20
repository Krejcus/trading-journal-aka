import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker, type MockBroker } from '../services/mockBroker';

// Incident 19. 10. 2026 14:26 UTC: leader vstoupil a až potom samostatně
// přidal Stop. Při druhém posunu stopu se stopy followerů vyplnily na
// předchozí ceně dřív, než modify dorazil. Výjimka 6. 10. platila jen pro
// OSO/bracket nohy, takže se vypnula celá skupina, i když followeři byli
// risk-redukčně flat.

const symbol = 'MNQZ6';

type FillDuringModify = (broker: MockBroker, order: BrokerOrder) => void;

async function setup(onFollowerStopModify: FillDuringModify | null) {
  let time = 100;
  const audits: string[] = [];
  const group: CopyGroupConfig = {
    id: 'incident-20261019', name: 'Origoš', enabled: true, leaderAccountId: 100,
    followers: [200, 201].map(accountId => ({ accountId, mode: 'on-submit' as const, multiplier: 1 })),
  };
  let broker!: MockBroker;
  broker = createMockBroker({
    behavior: () => ({ kind: 'working' }),
    modifyBehavior: order => {
      if (order && order.accountId !== 100 && onFollowerStopModify) onFollowerStopModify(broker, order);
      return 'success';
    },
  });
  const store = createMemoryCopierStore();
  const controller = await bootstrapCopierRuntime({
    broker, store, group, clock: () => ++time,
    leaderFlatGraceMs: 60000, followerTransitionCorrelationWindowMs: 60000, osoCorrelationWindowMs: 5,
    onAudit: entries => { for (const entry of entries) audits.push(entry.reason ?? entry.kind); },
  });
  const position = (accountId: number, netQuantity: number) => {
    broker.setPosition(accountId, symbol, netQuantity);
    broker.emitEvent({ type: 'position', position: { accountId, symbol, netQuantity } });
  };
  const order = (id: string, patch: Partial<BrokerOrder> = {}): BrokerOrder => ({
    tag: '', brokerOrderId: id, accountId: 100, symbol, side: 'Sell', orderType: 'Limit', quantity: 10,
    filledQuantity: 0, limitPrice: 29_840, status: 'working', sourceVersion: '1', updatedAt: 100, ...patch,
  });
  const advance = (ms: number) => { time += ms; broker.emitEvent({ type: 'heartbeat', at: time }); };
  return { broker, store, controller, group, position, order, audits, advance };
}

/** Short 10 přes Limit vstup, potom samostatný Buy Stop (bez parentOrderId). */
async function openTradeWithStandaloneStop(ctx: Awaited<ReturnType<typeof setup>>) {
  const { broker, controller, group, position, order } = ctx;
  broker.setConnected(true); await controller.waitForIdle(); await controller.reconcile(); controller.arm();
  broker.emitEvent({ type: 'order', order: order('entry') });
  await new Promise(resolve => setTimeout(resolve, 20));
  await controller.waitForIdle();
  const leaderEntry = { ...order('entry'), status: 'filled' as const, filledQuantity: 10 };
  broker.emitEvent({ type: 'order', order: leaderEntry });
  broker.emitEvent({ type: 'fill', fill: { fillId: 'lead-entry', tag: '', brokerOrderId: 'entry', accountId: 100,
    symbol, side: 'Sell', quantity: 10, price: 29_840, filledAt: 1 } });
  position(100, -10);
  for (const f of group.followers) {
    const entry = broker.orders().find(o => o.accountId === f.accountId && o.side === 'Sell')!;
    entry.filledQuantity = 10; entry.status = 'filled';
    broker.emitEvent({ type: 'order', order: { ...entry } });
    broker.emitEvent({ type: 'fill', fill: { fillId: `entry-${f.accountId}`, tag: '', brokerOrderId: entry.brokerOrderId,
      accountId: f.accountId, symbol, side: 'Sell', quantity: 10, price: 29_840, filledAt: 2 } });
    position(f.accountId, -10);
  }
  await controller.waitForIdle();
  expect(controller.status()).toMatchObject({ armed: true, lastError: null });

  // Stop přišel ~40 s po vstupu (mimo bracket inference okno) = samostatný.
  ctx.advance(40_000);
  await controller.waitForIdle();
  broker.emitEvent({ type: 'order', order: order('stop', {
    side: 'Buy', orderType: 'Stop', limitPrice: undefined, stopPrice: 29_851.5,
  }) });
  await new Promise(resolve => setTimeout(resolve, 20));
  await controller.waitForIdle();
  const stops = broker.orders().filter(o => o.accountId !== 100 && o.orderType === 'Stop' && o.status === 'working');
  expect(stops.map(o => o.accountId).sort()).toEqual([200, 201]);
  expect(controller.status()).toMatchObject({ armed: true, lastError: null });
}

const fillStop = (broker: MockBroker, stop: BrokerOrder, quantity: number, flatten = true) => {
  stop.status = 'filled';
  stop.filledQuantity = quantity;
  if (flatten) broker.setPosition(stop.accountId, symbol, 0);
  broker.emitEvent({ type: 'fill', fill: { fillId: `stop-${stop.accountId}`, tag: '', brokerOrderId: stop.brokerOrderId,
    accountId: stop.accountId, symbol, side: 'Buy', quantity, price: 29_854.75, filledAt: 3 } });
  broker.emitEvent({ type: 'order', order: { ...stop } });
  if (flatten) broker.emitEvent({ type: 'position', position: { accountId: stop.accountId, symbol, netQuantity: 0 } });
};

const moveLeaderStop = async (ctx: Awaited<ReturnType<typeof setup>>, stopPrice: number, version: string) => {
  ctx.broker.emitEvent({ type: 'order', order: ctx.order('stop', {
    side: 'Buy', orderType: 'Stop', limitPrice: undefined, stopPrice, sourceVersion: version,
  }) });
  await ctx.controller.waitForIdle();
};

describe('incident 19. 10. 2026 — samostatný stop followerů vyplní během posunu', { timeout: 60_000 }, () => {
  it('oba followeři se vyřadí z epizody, skupina zůstane zapnutá', async () => {
    const ctx = await setup((broker, stop) => {
      if (stop.orderType === 'Stop') fillStop(broker, stop, stop.quantity);
    });
    const { broker, controller, store, position, order, audits } = ctx;
    try {
      await openTradeWithStandaloneStop(ctx);
      const stored = await store.load();
      const standalone = stored.outbox.filter(entry => entry.protectiveRole === 'standalone-stop');
      expect(standalone).toHaveLength(2);
      expect(standalone.every(entry => typeof entry.protectiveEpochId === 'string' && entry.protectiveEpochId)).toBe(true);

      await moveLeaderStop(ctx, 29_859.25, '2');
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(audits.some(reason => reason.includes('follower 200 vyřazen z této epizody'))).toBe(true);
      expect(audits.some(reason => reason.includes('follower 201 vyřazen z této epizody'))).toBe(true);
      expect(controller.status().stuckOperations ?? []).toEqual([]);

      // Leader vystoupí: vyřazení followeři nic nedostanou, nic se nedokupuje.
      const placedBefore = broker.placedRequests().length;
      broker.emitEvent({ type: 'order', order: order('exit', { side: 'Buy', orderType: 'Market', limitPrice: undefined }) });
      await controller.waitForIdle();
      broker.emitEvent({ type: 'fill', fill: { fillId: 'lead-exit', tag: '', brokerOrderId: 'exit', accountId: 100,
        symbol, side: 'Buy', quantity: 10, price: 29_850.75, filledAt: 4 } });
      position(100, 0);
      await controller.waitForIdle();
      expect(broker.placedRequests().slice(placedBefore)).toEqual([]);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
    } finally {
      controller.stop();
    }
  });

  it('přesně jako 19. 10.: stop se vyplní ještě před odesláním modify (neverSent)', async () => {
    const ctx = await setup(null);
    const { broker, controller, audits } = ctx;
    try {
      await openTradeWithStandaloneStop(ctx);
      // Burza stopy vyplnila, stream to ale ještě nedoručil.
      const stops = broker.orders().filter(o => o.accountId !== 100 && o.orderType === 'Stop' && o.status === 'working');
      for (const stop of stops) {
        stop.status = 'filled';
        stop.filledQuantity = stop.quantity;
        broker.setPosition(stop.accountId, symbol, 0);
      }
      await moveLeaderStop(ctx, 29_859.25, '3');
      for (const stop of stops) {
        broker.emitEvent({ type: 'fill', fill: { fillId: `late-${stop.accountId}`, tag: '', brokerOrderId: stop.brokerOrderId,
          accountId: stop.accountId, symbol, side: 'Buy', quantity: stop.quantity, price: 29_854.75, filledAt: 3 } });
        broker.emitEvent({ type: 'order', order: { ...stop } });
        broker.emitEvent({ type: 'position', position: { accountId: stop.accountId, symbol, netQuantity: 0 } });
      }
      await controller.waitForIdle();
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(audits.some(reason => reason.includes('follower 200 vyřazen z této epizody'))).toBe(true);
      expect(audits.some(reason => reason.includes('follower 201 vyřazen z této epizody'))).toBe(true);
    } finally {
      controller.stop();
    }
  });

  it('opačné pořadí: fill a flat followerů dorazí dřív než posun leadera', async () => {
    const ctx = await setup(null);
    const { broker, controller, audits } = ctx;
    try {
      await openTradeWithStandaloneStop(ctx);
      const stops = broker.orders().filter(o => o.accountId !== 100 && o.orderType === 'Stop' && o.status === 'working');
      for (const stop of stops) fillStop(broker, stop, stop.quantity);
      await controller.waitForIdle();
      await moveLeaderStop(ctx, 29_859.25, '2');
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(audits.some(reason => reason.includes('follower 200 vyřazen z této epizody'))).toBe(true);
      expect(audits.some(reason => reason.includes('follower 201 vyřazen z této epizody'))).toBe(true);
    } finally {
      controller.stop();
    }
  });

  it('follower má vedle stopu ještě pracující příkaz → žádné vyřazení, fail-closed', async () => {
    const ctx = await setup((broker, stop) => {
      if (stop.orderType === 'Stop' && stop.accountId === 200) fillStop(broker, stop, stop.quantity);
    });
    const { broker, controller, audits } = ctx;
    try {
      await openTradeWithStandaloneStop(ctx);
      await broker.placeOrder({ tag: 'manual-tp', accountId: 200, symbol, side: 'Buy', quantity: 10, orderType: 'Limit', limitPrice: 29_800 });
      await moveLeaderStop(ctx, 29_859.25, '2');
      expect(controller.status().armed).toBe(false);
      expect(audits.some(reason => reason.includes('vyřazen z této epizody'))).toBe(false);
    } finally {
      controller.stop();
    }
  });

  it('stop vyplněný jen částečně (follower flat jiným zásahem) → fail-closed', async () => {
    const ctx = await setup((broker, stop) => {
      if (stop.orderType === 'Stop' && stop.accountId === 200) fillStop(broker, stop, 4);
    });
    const { controller, audits } = ctx;
    try {
      await openTradeWithStandaloneStop(ctx);
      await moveLeaderStop(ctx, 29_859.25, '2');
      expect(controller.status().armed).toBe(false);
      expect(audits.some(reason => reason.includes('vyřazen z této epizody'))).toBe(false);
    } finally {
      controller.stop();
    }
  });

  it('stop vyplněný, ale follower dál drží pozici → fail-closed', async () => {
    const ctx = await setup((broker, stop) => {
      if (stop.orderType === 'Stop' && stop.accountId === 200) fillStop(broker, stop, stop.quantity, false);
    });
    const { controller, audits } = ctx;
    try {
      await openTradeWithStandaloneStop(ctx);
      await moveLeaderStop(ctx, 29_859.25, '2');
      expect(controller.status().armed).toBe(false);
      expect(audits.some(reason => reason.includes('vyřazen z této epizody'))).toBe(false);
    } finally {
      controller.stop();
    }
  });
});
