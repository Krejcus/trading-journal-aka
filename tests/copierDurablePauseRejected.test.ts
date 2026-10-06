// Etapa 2 (6. 10. 2026): vyřazení followera po odmítnutém vstupu je durable.
import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { createBrokerRouter } from '../services/brokerRouter';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';
import { createMockBroker as createLeaderMockBroker } from './_laMock';

const SYM = 'MNQZ6';
const group: CopyGroupConfig = {
  id: 'g', name: 'G', enabled: true, leaderAccountId: 100,
  followers: [200, 300].map(accountId => ({ accountId, mode: 'on-submit' as const, multiplier: 1 })),
};
const order = (x: Partial<BrokerOrder>): BrokerOrder => ({
  tag: '', brokerOrderId: 'x', accountId: 100, symbol: SYM, side: 'Buy', orderType: 'Market',
  quantity: 1, filledQuantity: 0, status: 'working', sourceVersion: '1', updatedAt: 1, ...x,
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('etapa 2 — odmítnutý vstup followera', () => {
  it('vyřazení z epizody se zapíše jako durable pauza a ukáže se ve stavu', async () => {
    let now = 1_000_000;
    const leader = createLeaderMockBroker({ behavior: r => r.orderType === 'Market' ? { kind: 'fill', price: 30_500 } : { kind: 'working' } });
    const follower = createMockBroker({ clock: () => now, behavior: request => {
      if (request.accountId === 200 && request.side === 'Buy') return { kind: 'reject', reason: 'Exceeds max position size' };
      return request.orderType === 'Market' ? { kind: 'fill', price: 30_500 } : { kind: 'working' };
    } });
    const router = createBrokerRouter([
      { broker: leader, accountIds: [100], critical: true },
      { broker: follower, accountIds: [200, 300], critical: false },
    ], { reconnectGraceMs: 10_000 });
    const store = createMemoryCopierStore();
    const controller = await bootstrapCopierRuntime({ broker: router, store, group, clock: () => ++now });
    try {
      leader.setConnected(true); follower.setConnected(true);
      await controller.waitForIdle(); await controller.reconcile(); controller.arm();
      const entry = order({ brokerOrderId: 'e1' });
      leader.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      leader.emitEvent({ type: 'order', order: { ...entry, status: 'filled', filledQuantity: 1, sourceVersion: 'f' } });
      leader.emitEvent({ type: 'fill', fill: { fillId: 'e1f', tag: '', brokerOrderId: 'e1', accountId: 100, symbol: SYM, side: 'Buy', quantity: 1, price: 30_500, filledAt: 1 } });
      leader.setPosition(100, SYM, 1);
      leader.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 1 } });
      await controller.waitForIdle(); await sleep(50); await controller.waitForIdle();
      expect(controller.status().armed).toBe(true);
      expect((await store.load()).safety?.accountSyncPauses).toEqual([
        expect.objectContaining({ accountId: 200, symbol: SYM, reasonCode: 'entry-rejected', leaderEntryOrderId: 'e1' }),
      ]);
      expect(controller.status().accountSyncPauses).toEqual([
        expect.objectContaining({ accountId: 200, symbol: SYM, reasonCode: 'entry-rejected' }),
      ]);
    } finally {
      controller.stop();
    }
  });

  const bootRejected = async () => {
    let now = 1_000_000;
    const leader = createLeaderMockBroker({ behavior: r => r.orderType === 'Market' ? { kind: 'fill', price: 30_500 } : { kind: 'working' } });
    let rejectEntries200 = true;
    const follower = createMockBroker({ clock: () => now, behavior: request => {
      if (rejectEntries200 && request.accountId === 200 && request.side === 'Buy') return { kind: 'reject', reason: 'Exceeds max position size' };
      return request.orderType === 'Market' ? { kind: 'fill', price: 30_500 } : { kind: 'working' };
    } });
    const router = createBrokerRouter([
      { broker: leader, accountIds: [100], critical: true },
      { broker: follower, accountIds: [200, 300], critical: false },
    ], { reconnectGraceMs: 10_000 });
    const store = createMemoryCopierStore();
    const controller = await bootstrapCopierRuntime({ broker: router, store, group, clock: () => ++now });
    leader.setConnected(true); follower.setConnected(true);
    await controller.waitForIdle(); await controller.reconcile(); controller.arm();
    const leaderTrade = async (id: string, side: 'Buy' | 'Sell', net: number) => {
      const o = order({ brokerOrderId: id, side });
      leader.emitEvent({ type: 'order', order: o });
      await controller.waitForIdle();
      leader.emitEvent({ type: 'order', order: { ...o, status: 'filled', filledQuantity: 1, sourceVersion: 'f' } });
      leader.emitEvent({ type: 'fill', fill: { fillId: `${id}f`, tag: '', brokerOrderId: id, accountId: 100, symbol: SYM, side, quantity: 1, price: 30_500, filledAt: 1 } });
      leader.setPosition(100, SYM, net);
      leader.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: net } });
      await controller.waitForIdle(); await sleep(50); await controller.waitForIdle();
    };
    const requestsFor = (accountId: number) => follower.placedRequests().filter(r => r.accountId === accountId);
    return { controller, follower, leaderTrade, requestsFor, store, allowEntries: () => { rejectEntries200 = false; } };
  };

  it('scale-in ve stejné epizodě pozastavenému účtu nic nepošle', async () => {
    const { controller, leaderTrade, requestsFor, allowEntries } = await bootRejected();
    try {
      await leaderTrade('e1', 'Buy', 1);
      expect(controller.status().accountSyncPauses).toEqual([expect.objectContaining({ accountId: 200 })]);
      const before = requestsFor(200).length;
      allowEntries();
      await leaderTrade('e2', 'Buy', 2);
      expect(requestsFor(200).length).toBe(before);
      expect(requestsFor(300).filter(r => r.side === 'Buy').length).toBe(2);
      expect(controller.status().armed).toBe(true);
    } finally {
      controller.stop();
    }
  });

  it('ruční pozice na pozastaveném účtu: leader exit na ni nic nepošle', async () => {
    const { controller, follower, leaderTrade, requestsFor } = await bootRejected();
    try {
      await leaderTrade('e1', 'Buy', 1);
      // Uživatel ručně otevře na pozastaveném účtu pozici shodnou s leaderem.
      follower.setPosition(200, SYM, 1);
      follower.emitEvent({ type: 'fill', fill: { fillId: 'manual-200', tag: '', brokerOrderId: 'MANUAL', accountId: 200, symbol: SYM, side: 'Buy', quantity: 1, price: 30_510, filledAt: 2 } });
      follower.emitEvent({ type: 'position', position: { accountId: 200, symbol: SYM, netQuantity: 1 } });
      await controller.waitForIdle(); await sleep(50); await controller.waitForIdle();
      await leaderTrade('x1', 'Sell', 0);
      expect(requestsFor(200).filter(r => r.side === 'Sell')).toEqual([]);
      expect((await follower.listPositions(200)).find(p => p.symbol === SYM)?.netQuantity).toBe(1);
    } finally {
      controller.stop();
    }
  });
});

describe('etapa 2 — stará nevázaná pauza', () => {
  it('pauza bez epochy starší než 24 h se neaktivuje', async () => {
    const { emptySnapshot } = await import('../services/copierStore');
    const { createLeaderFlatEpoch } = await import('../services/copierLeaderFlatGuard');
    let now = 10 * 24 * 60 * 60_000;
    const snapshot = emptySnapshot();
    snapshot.safety = {
      ...snapshot.safety!,
      leaderExposureEpochs: [createLeaderFlatEpoch({ id: 'new-epoch', groupId: group.id, leaderAccountId: 100, symbol: SYM,
        openedAt: now - 1_000, leaderNet: 1, followers: [] , leaderEntryOrderIds: ['e1'] } as never)],
      accountSyncPauses: [{ accountId: 200, symbol: SYM, leaderEntryOrderId: 'e1', epochId: null,
        reasonCode: 'entry-rejected', reason: 'starý', pausedAt: 1 }],
    };
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
    const controller = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(snapshot), group, clock: () => ++now });
    try {
      expect(controller.status().accountSyncPauses ?? []).toEqual([]);
    } finally {
      controller.stop();
    }
  });
});

describe('etapa 2 — auto-close a pozastavený účet', () => {
  it('zavření po vypršení zapnutí se ruční pozice na pozastaveném účtu nedotkne', async () => {
    let now = 1_000_000;
    const leader = createLeaderMockBroker({ clock: () => now, behavior: r => r.orderType === 'Market' ? { kind: 'fill', price: 30_500 } : { kind: 'working' } });
    const follower = createMockBroker({ clock: () => now, nativeLiquidate: true, behavior: request => {
      if (request.accountId === 200 && request.side === 'Buy') return { kind: 'reject', reason: 'Exceeds max position size' };
      return request.orderType === 'Market' ? { kind: 'fill', price: 30_500 } : { kind: 'working' };
    } } as never);
    const router = createBrokerRouter([
      { broker: leader, accountIds: [100], critical: true },
      { broker: follower, accountIds: [200, 300], critical: false },
    ], { reconnectGraceMs: 10_000 });
    const controller = await bootstrapCopierRuntime({
      broker: router, store: createMemoryCopierStore(), group, clock: () => now,
      flattenConfirmationAttempts: 2, flattenConfirmationPollMs: 0, wait: async () => undefined,
    } as never);
    try {
      leader.setConnected(true); follower.setConnected(true);
      await controller.waitForIdle(); await controller.reconcile();
      controller.arm({ ttlMs: 60_000 });
      const entry = order({ brokerOrderId: 'e1' });
      leader.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      leader.emitEvent({ type: 'order', order: { ...entry, status: 'filled', filledQuantity: 1, sourceVersion: 'f' } });
      leader.emitEvent({ type: 'fill', fill: { fillId: 'e1f', tag: '', brokerOrderId: 'e1', accountId: 100, symbol: SYM, side: 'Buy', quantity: 1, price: 30_500, filledAt: 1 } });
      leader.setPosition(100, SYM, 1);
      leader.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 1 } });
      await controller.waitForIdle(); await sleep(50); await controller.waitForIdle();
      expect(controller.status().accountSyncPauses).toEqual([expect.objectContaining({ accountId: 200 })]);
      // Ruční pozice na pozastaveném účtu.
      follower.setPosition(200, SYM, 1);
      follower.emitEvent({ type: 'position', position: { accountId: 200, symbol: SYM, netQuantity: 1 } });
      await controller.waitForIdle();
      // Vypršení zapnutí → auto-close followerů.
      now += 120_000;
      leader.emitEvent({ type: 'heartbeat', at: now } as never);
      await controller.waitForIdle(); await sleep(50); await controller.waitForIdle();
      expect(controller.status().armed).toBe(false);
      const liquidations = follower.liquidateRequests();
      expect(liquidations.some(request => request.accountId === 200)).toBe(false);
      expect(follower.placedRequests().filter(request => request.accountId === 200 && request.side === 'Sell')).toEqual([]);
      expect((await follower.listPositions(200)).find(p => p.symbol === SYM)?.netQuantity).toBe(1);
    } finally {
      controller.stop();
    }
  });
});

