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
  it('pauza bez epochy časem nevyprší a Kontrola pozic ji s ruční pozicí na účtu neuvolní', async () => {
    const { emptySnapshot } = await import('../services/copierStore');
    let now = 10 * 24 * 60 * 60_000;
    const snapshot = emptySnapshot();
    snapshot.safety = {
      ...snapshot.safety!,
      accountSyncPauses: [{ accountId: 200, symbol: SYM, leaderEntryOrderId: 'e0', epochId: null,
        reasonCode: 'entry-rejected', reason: 'starý', pausedAt: 1 }],
    };
    const leader = createLeaderMockBroker({ behavior: () => ({ kind: 'working' }) });
    const follower = createMockBroker({ clock: () => now, behavior: () => ({ kind: 'working' }) });
    follower.setPosition(200, SYM, 1);
    const router = createBrokerRouter([
      { broker: leader, accountIds: [100], critical: true },
      { broker: follower, accountIds: [200, 300], critical: false },
    ], { reconnectGraceMs: 10_000 });
    const controller = await bootstrapCopierRuntime({ broker: router, store: createMemoryCopierStore(snapshot), group, clock: () => ++now });
    try {
      leader.setConnected(true); follower.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile().catch(() => undefined);
      expect(controller.status().accountSyncPauses).toEqual([expect.objectContaining({ accountId: 200 })]);
      // Účet se vyčistí → čistá Kontrola pozic pauzu uvolní.
      follower.setPosition(200, SYM, 0);
      follower.emitEvent({ type: 'position', position: { accountId: 200, symbol: SYM, netQuantity: 0 } });
      await controller.waitForIdle();
      await controller.reconcile();
      expect(controller.status().accountSyncPauses ?? []).toEqual([]);
    } finally {
      controller.stop();
    }
  });
});

describe('etapa 2 (kolo 4) — pauza přežije flat leadera', () => {
  const boot = async (graceMs = 60_000) => {
    let now = 1_000_000;
    const leader = createLeaderMockBroker({ clock: () => now, behavior: r => r.orderType === 'Market' ? { kind: 'fill', price: 30_500 } : { kind: 'working' } });
    let rejectEntries200 = true;
    const follower = createMockBroker({ clock: () => now, nativeLiquidate: true, behavior: request => {
      if (rejectEntries200 && request.accountId === 200 && request.side === 'Buy') return { kind: 'reject', reason: 'Exceeds max position size' };
      return request.orderType === 'Market' ? { kind: 'fill', price: 30_500 } : { kind: 'working' };
    } } as never);
    const router = createBrokerRouter([
      { broker: leader, accountIds: [100], critical: true },
      { broker: follower, accountIds: [200, 300], critical: false },
    ], { reconnectGraceMs: 10_000 });
    const store = createMemoryCopierStore();
    const controller = await bootstrapCopierRuntime({
      broker: router, store, group, clock: () => now,
      leaderFlatGraceMs: graceMs, leaderFlatExitSettlementGraceMs: 0, leaderFlatInflightRetryMs: 10,
      flattenConfirmationAttempts: 2, flattenConfirmationPollMs: 0, wait: async () => undefined,
    } as never);
    leader.setConnected(true); follower.setConnected(true);
    await controller.waitForIdle(); await controller.reconcile();
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
    const manualPosition200 = async (net: number) => {
      follower.setPosition(200, SYM, net);
      follower.emitEvent({ type: 'position', position: { accountId: 200, symbol: SYM, netQuantity: net } });
      await controller.waitForIdle();
    };
    return {
      controller, follower, leaderTrade, manualPosition200, store,
      heartbeat: () => leader.emitEvent({ type: 'heartbeat', at: now } as never),
      leaderEmit: (o: BrokerOrder) => leader.emitEvent({ type: 'order', order: o }),
      advance: (ms: number) => { now += ms; },
      allowEntries: () => { rejectEntries200 = false; },
      requestsFor: (accountId: number) => follower.placedRequests().filter(r => r.accountId === accountId),
    };
  };

  it('nový vstup leadera po jeho flatu nezvětší ruční pozici pozastaveného účtu', async () => {
    const { controller, leaderTrade, manualPosition200, requestsFor, allowEntries, follower } = await boot();
    try {
      controller.arm();
      await leaderTrade('e1', 'Buy', 1);
      await manualPosition200(1);
      await leaderTrade('x1', 'Sell', 0);
      allowEntries();
      const before = requestsFor(200).length;
      await leaderTrade('e2', 'Buy', 1);
      expect(requestsFor(200).length).toBe(before);
      expect((await follower.listPositions(200)).find(p => p.symbol === SYM)?.netQuantity).toBe(1);
      expect(controller.status().accountSyncPauses).toEqual([expect.objectContaining({ accountId: 200 })]);
      expect(controller.status().armed).toBe(true);
    } finally {
      controller.stop();
    }
  });

  it('vypršení zapnutí po flatu leadera ruční pozici pozastaveného účtu nezavře', async () => {
    const { controller, leaderTrade, manualPosition200, follower, advance, heartbeat } = await boot();
    try {
      controller.arm({ ttlMs: 60_000 });
      await leaderTrade('e1', 'Buy', 1);
      await manualPosition200(1);
      await leaderTrade('x1', 'Sell', 0);
      advance(120_000);
      heartbeat();
      await controller.waitForIdle(); await sleep(50); await controller.waitForIdle();
      expect(controller.status().armed).toBe(false);
      expect(follower.liquidateRequests().some(request => request.accountId === 200)).toBe(false);
      expect(follower.placedRequests().filter(r => r.accountId === 200 && r.side === 'Sell')).toEqual([]);
      expect((await follower.listPositions(200)).find(p => p.symbol === SYM)?.netQuantity).toBe(1);
    } finally {
      controller.stop();
    }
  });

  it('leader-flat guard kvůli ruční pozici pozastaveného účtu skupinu nevypne a pauzu ponechá', async () => {
    const { controller, leaderTrade, manualPosition200, follower, store, advance } = await boot(10);
    try {
      controller.arm();
      await leaderTrade('e1', 'Buy', 1);
      await manualPosition200(1);
      await leaderTrade('x1', 'Sell', 0);
      for (let i = 0; i < 5; i += 1) { advance(2_000); await sleep(30); await controller.waitForIdle(); }
      await sleep(100); await controller.waitForIdle();
      // Guard skutečně doběhl (epocha vyřešená) a skupina jede dál.
      expect((await store.load()).safety?.leaderExposureEpochs?.some(epoch => epoch.phase === 'open' || epoch.phase === 'grace' || epoch.phase === 'waiting-inflight')).toBe(false);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
      expect(controller.status().accountSyncPauses).toEqual([expect.objectContaining({ accountId: 200 })]);
      expect(follower.liquidateRequests().some(request => request.accountId === 200)).toBe(false);
    } finally {
      controller.stop();
    }
  });

  it('čekající limitní vstup leadera uvolnění pauzy zablokuje (kolo 5)', async () => {
    const { controller, leaderTrade, requestsFor, allowEntries, advance, leaderEmit } = await boot(10);
    try {
      controller.arm();
      await leaderTrade('e1', 'Buy', 1);
      allowEntries();
      await leaderTrade('x1', 'Sell', 0);
      // Leader hned zadá limitní vstup, který zatím čeká — nový obchod začal.
      leaderEmit(order({ brokerOrderId: 'l2', orderType: 'Limit', limitPrice: 30_400 }));
      await controller.waitForIdle();
      const before = requestsFor(200).length;
      for (let i = 0; i < 5; i += 1) { advance(2_000); await sleep(30); await controller.waitForIdle(); }
      await sleep(100); await controller.waitForIdle();
      expect(controller.status().accountSyncPauses).toEqual([expect.objectContaining({ accountId: 200 })]);
      expect(requestsFor(200).length).toBe(before);
    } finally {
      controller.stop();
    }
  });

  it('vstup leadera přijatý během durable zápisu uvolnění: pauza se obnoví a vstup účet mine (kolo 6)', async () => {
    const { controller, leaderTrade, requestsFor, allowEntries, advance, leaderEmit, store } = await boot(10);
    try {
      controller.arm();
      await leaderTrade('e1', 'Buy', 1);
      allowEntries();
      await leaderTrade('x1', 'Sell', 0);
      // Přesně ve chvíli, kdy se zapisuje odstranění pauzy, leader zadá vstup.
      const realCommit = store.commit.bind(store);
      let injected = false;
      store.commit = async (snapshot, expectedRevision) => {
        const releasing = (snapshot.safety?.accountSyncPauses ?? []).length === 0
          && ((await store.load()).safety?.accountSyncPauses ?? []).length > 0;
        if (releasing && !injected) {
          injected = true;
          leaderEmit(order({ brokerOrderId: 'race-entry', orderType: 'Limit', limitPrice: 30_400 }));
        }
        return realCommit(snapshot, expectedRevision);
      };
      const before = requestsFor(200).length;
      for (let i = 0; i < 5; i += 1) { advance(2_000); await sleep(30); await controller.waitForIdle(); }
      await sleep(100); await controller.waitForIdle();
      expect(injected).toBe(true);
      expect(controller.status().accountSyncPauses).toEqual([expect.objectContaining({ accountId: 200 })]);
      expect(requestsFor(200).length).toBe(before);
      expect(controller.status().armed).toBe(true);
    } finally {
      controller.stop();
    }
  });

  it('leader-flat guard uvolní pauzu čistého účtu a další vstup se mu zkopíruje', async () => {
    const { controller, leaderTrade, requestsFor, allowEntries, advance } = await boot(10);
    try {
      controller.arm();
      await leaderTrade('e1', 'Buy', 1);
      expect(controller.status().accountSyncPauses).toEqual([expect.objectContaining({ accountId: 200 })]);
      await leaderTrade('x1', 'Sell', 0);
      for (let i = 0; i < 5; i += 1) { advance(2_000); await sleep(30); await controller.waitForIdle(); }
      await sleep(100); await controller.waitForIdle(); await sleep(50); await controller.waitForIdle();
      expect(controller.status().accountSyncPauses ?? []).toEqual([]);
      allowEntries();
      const before = requestsFor(200).filter(r => r.side === 'Buy').length;
      await leaderTrade('e2', 'Buy', 1);
      expect(requestsFor(200).filter(r => r.side === 'Buy').length).toBe(before + 1);
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });
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
