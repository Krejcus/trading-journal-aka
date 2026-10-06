import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker, type MockBroker } from '../services/mockBroker';

// Incident 6. 10. 2026 07:31 UTC: leader posunul stop, stop followerů se
// mezitím vyplnil na původní ceně (~90 ms před potvrzením modify). Copier
// vypnul celou skupinu, i když follower byl risk-redukčně flat.

const symbol = 'MNQZ6';

type FillDuringModify = (broker: MockBroker, order: BrokerOrder) => void;

async function setup(onFollowerStopModify: FillDuringModify | null, count = 2) {
  let time = 100;
  const audits: string[] = [];
  const group: CopyGroupConfig = {
    id: 'incident-20261006', name: 'Hlavní', enabled: true, leaderAccountId: 100,
    followers: Array.from({ length: count }, (_, i) => ({ accountId: 200 + i, mode: 'on-submit', multiplier: 1 })),
  };
  let broker!: MockBroker;
  broker = createMockBroker({
    behavior: request => (request.orderType === 'Market' ? { kind: 'fill', price: 31_356 } : { kind: 'working' }),
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
    tag: '', brokerOrderId: id, accountId: 100, symbol, side: 'Buy', orderType: 'Limit', quantity: 19,
    filledQuantity: 0, limitPrice: 31_376, status: 'working', sourceVersion: '1', updatedAt: 100, ...patch,
  });
  return { broker, store, controller, group, position, order, audits };
}

async function openTrade(ctx: Awaited<ReturnType<typeof setup>>) {
  const { broker, controller, group, position, order } = ctx;
  broker.setConnected(true); await controller.waitForIdle(); await controller.reconcile(); controller.arm();
  broker.emitEvent({ type: 'order', order: order('entry') });
  broker.emitEvent({ type: 'order', order: order('stop', {
    parentOrderId: 'entry', side: 'Sell', orderType: 'Stop', limitPrice: undefined, stopPrice: 31_360,
  }) });
  broker.emitEvent({ type: 'order', order: order('target', { parentOrderId: 'entry', side: 'Sell', limitPrice: 31_417.75 }) });
  await controller.waitForIdle();
  expect(broker.placedOsoRequests()).toHaveLength(group.followers.length);
  broker.emitEvent({ type: 'fill', fill: { fillId: 'lead-entry', tag: '', brokerOrderId: 'entry', accountId: 100,
    symbol, side: 'Buy', quantity: 19, price: 31_376, filledAt: 1 } });
  position(100, 19);
  for (const f of group.followers) {
    const entry = broker.orders().find(o => o.accountId === f.accountId && o.side === 'Buy')!;
    entry.filledQuantity = 19; entry.status = 'filled';
    broker.emitEvent({ type: 'order', order: { ...entry } });
    broker.emitEvent({ type: 'fill', fill: { fillId: `entry-${f.accountId}`, tag: '', brokerOrderId: entry.brokerOrderId,
      accountId: f.accountId, symbol, side: 'Buy', quantity: 19, price: 31_376, filledAt: 2 } });
    position(f.accountId, 19);
  }
  await controller.waitForIdle();
  expect(controller.status()).toMatchObject({ armed: true, lastError: null });
}

/** Stop followera 200 se vyplní na původní ceně a OCO zruší jeho target. */
const fillStopBeforeModify: FillDuringModify = (broker, stop) => {
  if (stop.accountId !== 200 || stop.orderType !== 'Stop') return;
  fillProtectiveLeg(broker, stop, stop.quantity);
};

const fillProtectiveLeg = (broker: MockBroker, leg: BrokerOrder, quantity: number, flatten = true) => {
  const stop = leg;
  stop.status = 'filled';
  stop.filledQuantity = quantity;
  const sibling = broker.orders().find(o => o.accountId === stop.accountId && o.side === 'Sell'
    && o.brokerOrderId !== stop.brokerOrderId && o.status === 'working');
  const target = sibling;
  if (target) target.status = 'canceled';
  if (flatten) broker.setPosition(stop.accountId, symbol, 0);
  broker.emitEvent({ type: 'fill', fill: { fillId: `stop-${stop.accountId}`, tag: '', brokerOrderId: stop.brokerOrderId,
    accountId: stop.accountId, symbol, side: 'Sell', quantity, price: 31_359, filledAt: 3 } });
  broker.emitEvent({ type: 'order', order: { ...stop } });
  if (target) broker.emitEvent({ type: 'order', order: { ...target } });
  if (flatten) broker.emitEvent({ type: 'position', position: { accountId: stop.accountId, symbol, netQuantity: 0 } });
};

describe('incident 6. 10. 2026 — ochranná noha followera vyplní během posunu', () => {
  it('follower se vyřadí z epizody, skupina zůstane zapnutá a exit dostanou jen ostatní', async () => {
    const ctx = await setup(fillStopBeforeModify);
    const { broker, controller, position, order, audits } = ctx;
    try {
      await openTrade(ctx);
      broker.emitEvent({ type: 'order', order: order('stop', {
        parentOrderId: 'entry', side: 'Sell', orderType: 'Stop', limitPrice: undefined, stopPrice: 31_357, sourceVersion: '2',
      }) });
      await controller.waitForIdle();
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(audits.some(reason => reason.includes('follower 200 vyřazen z této epizody'))).toBe(true);
      expect(controller.status().stuckOperations ?? []).toEqual([]);

      // Leader vystoupí Marketem: exit dostane jen follower 201, ne vyřazený 200.
      broker.emitEvent({ type: 'order', order: order('exit', { side: 'Sell', orderType: 'Market', limitPrice: undefined, quantity: 19 }) });
      await controller.waitForIdle();
      broker.emitEvent({ type: 'fill', fill: { fillId: 'lead-exit', tag: '', brokerOrderId: 'exit', accountId: 100,
        symbol, side: 'Sell', quantity: 19, price: 31_356, filledAt: 4 } });
      position(100, 0);
      await controller.waitForIdle();
      const exits = broker.placedRequests().filter(request => request.side === 'Sell' && request.orderType === 'Market');
      expect(exits.map(request => [request.accountId, request.quantity])).toEqual([[201, 19]]);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      for (const accountId of [200, 201]) {
        expect((await broker.listPositions(accountId)).every(p => p.netQuantity === 0)).toBe(true);
      }
    } finally {
      controller.stop();
    }
  });

  it('bez flat důkazu (follower drží pozici) zůstává globální fail-closed', async () => {
    // Stop "vyplněn", ale pozice followera nezmizí — nevysvětlený stav.
    const ctx = await setup((broker, stop) => {
      stop.status = 'filled';
      stop.filledQuantity = stop.quantity;
      broker.emitEvent({ type: 'order', order: { ...stop } });
    });
    const { broker, controller, order } = ctx;
    try {
      await openTrade(ctx);
      broker.emitEvent({ type: 'order', order: order('stop', {
        parentOrderId: 'entry', side: 'Sell', orderType: 'Stop', limitPrice: undefined, stopPrice: 31_357, sourceVersion: '2',
      }) });
      await controller.waitForIdle();
      // Beze změny proti dosavadnímu chování: skupina se vypne.
      expect(controller.status().armed).toBe(false);
      expect(controller.status().lastError).toBeTruthy();
    } finally {
      controller.stop();
    }
  });

  it('totéž pro TP: posun targetu, target followera se vyplní dřív', async () => {
    const ctx = await setup((broker, leg) => {
      if (leg.accountId === 200 && leg.orderType === 'Limit') fillProtectiveLeg(broker, leg, leg.quantity);
    });
    const { broker, controller, order, audits } = ctx;
    try {
      await openTrade(ctx);
      broker.emitEvent({ type: 'order', order: order('target', {
        parentOrderId: 'entry', side: 'Sell', limitPrice: 31_420, sourceVersion: '2',
      }) });
      await controller.waitForIdle();
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(audits.some(reason => reason.includes('follower 200 vyřazen z této epizody'))).toBe(true);
    } finally {
      controller.stop();
    }
  });

  it('vyplněné množství nesedí s potvrzenou kopií → původní fail-closed', async () => {
    // Stop vyplnil jen 10 z 19, follower je přesto flat (jiný zásah) — nevysvětlené.
    const ctx = await setup((broker, leg) => {
      if (leg.accountId === 200 && leg.orderType === 'Stop') fillProtectiveLeg(broker, leg, 10);
    });
    const { broker, controller, order, audits } = ctx;
    try {
      await openTrade(ctx);
      broker.emitEvent({ type: 'order', order: order('stop', {
        parentOrderId: 'entry', side: 'Sell', orderType: 'Stop', limitPrice: undefined, stopPrice: 31_357, sourceVersion: '2',
      }) });
      await controller.waitForIdle();
      expect(controller.status().armed).toBe(false);
      expect(audits.some(reason => reason.includes('přesně nevysvětluje potvrzenou kopii'))).toBe(true);
      expect(audits.some(reason => reason.includes('vyřazen z této epizody'))).toBe(false);
    } finally {
      controller.stop();
    }
  });

  it('smíšená dávka: jeden follower flat, druhý ne → nic se neprominou, původní fail-closed', async () => {
    const ctx = await setup((broker, leg) => {
      if (leg.orderType !== 'Stop') return;
      if (leg.accountId === 200) fillProtectiveLeg(broker, leg, leg.quantity);
      // 201: stop "filled", ale pozice zůstala — nevysvětlený stav.
      if (leg.accountId === 201) fillProtectiveLeg(broker, leg, leg.quantity, false);
    });
    const { broker, controller, order, audits } = ctx;
    try {
      await openTrade(ctx);
      broker.emitEvent({ type: 'order', order: order('stop', {
        parentOrderId: 'entry', side: 'Sell', orderType: 'Stop', limitPrice: undefined, stopPrice: 31_357, sourceVersion: '2',
      }) });
      await controller.waitForIdle();
      expect(controller.status().armed).toBe(false);
      expect(audits.some(reason => reason.includes('vyřazen z této epizody'))).toBe(false);
      // Cancel outbox zůstal neprominutý (žádná položka waived kvůli izolaci).
      const stuck = controller.status().stuckOperations ?? [];
      expect(stuck.some(item => item.accountId === 200 && item.status === 'abandoned')).toBe(true);
    } finally {
      controller.stop();
    }
  });
});
