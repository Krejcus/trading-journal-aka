import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from './_laMock';

// 5. 10. 2026: Filip měl na dvou followerech vypnuté skupiny ruční obchody
// a novou skupinu s jinými účty nešlo zapnout. Odcházející účet bez kopie
// kopírky přepnutí neblokuje; účty nové skupiny a účty s kopií ano.

const SYM = 'MNQZ6';
const oldGroup: CopyGroupConfig = {
  id: 'hlavni', name: 'Hlavní', enabled: true, leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    { accountId: 300, mode: 'on-submit', multiplier: 1 },
  ],
};
const newGroup: CopyGroupConfig = {
  id: 'fundednext', name: 'FundedNext', enabled: true, leaderAccountId: 400,
  followers: [{ accountId: 500, mode: 'on-submit', multiplier: 1 }],
};
const order = (patch: Partial<BrokerOrder>): BrokerOrder => ({
  tag: '', brokerOrderId: 'x', accountId: 100, symbol: SYM, side: 'Buy', orderType: 'Market',
  quantity: 1, filledQuantity: 0, status: 'working', sourceVersion: '1', updatedAt: 1, ...patch,
});

async function boot(
  behavior?: Parameters<typeof createMockBroker>[0],
  existing?: { broker: ReturnType<typeof createMockBroker>; store: ReturnType<typeof createMemoryCopierStore> },
) {
  let now = 1_000_000;
  const broker = existing?.broker ?? createMockBroker(behavior);
  const store = existing?.store ?? createMemoryCopierStore();
  const controller = await bootstrapCopierRuntime({
    broker, store, group: oldGroup, clock: () => ++now,
    followerTransitionCorrelationWindowMs: 10,
    copierSettlementQuietMs: 5,
    copierSettlementMinAgeMs: 0,
    copierSettlementTerminalAgeMs: 0,
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  return { broker, controller, store };
}

const flatAt = (broker: ReturnType<typeof createMockBroker>, accountId: number, netQuantity: number) => {
  broker.setPosition(accountId, SYM, netQuantity);
  broker.emitEvent({ type: 'position', position: { accountId, symbol: SYM, netQuantity } });
};

describe('přepnutí skupiny a ruční pozice na odcházejících účtech', () => {
  it('ruční pozice na followerovi vypnuté skupiny přepnutí neblokuje a nová skupina jde zapnout', async () => {
    const { broker, controller } = await boot();
    try {
      // Ruční obchod mimo kopírku (DISARMED) na dvou followerech staré skupiny.
      broker.setPosition(200, SYM, 1);
      broker.setPosition(300, SYM, -2);
      broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: SYM, netQuantity: 1 } });
      broker.emitEvent({ type: 'position', position: { accountId: 300, symbol: SYM, netQuantity: -2 } });
      await controller.waitForIdle();
      await new Promise(resolve => setTimeout(resolve, 50));
      await controller.waitForIdle();
      expect(controller.status().reconciliationRequired).toBe(true);
      await controller.activateGroup(newGroup);
      await controller.reconcile();
      controller.arm();
      expect(controller.status().armed).toBe(true);
      // Ruční pozice zůstaly netknuté.
      expect((await broker.listPositions(200))[0]?.netQuantity).toBe(1);
      expect((await broker.listPositions(300))[0]?.netQuantity).toBe(-2);
    } finally {
      controller.stop();
    }
  });

  it('ruční pozice na účtu nové skupiny přepnutí dál blokuje', async () => {
    const { broker, controller } = await boot();
    try {
      broker.setPosition(500, SYM, 1);
      await expect(controller.activateGroup(newGroup)).rejects.toThrow('nonFlat=500');
    } finally {
      controller.stop();
    }
  });

  it('otevřená kopie kopírky na odcházejícím followerovi přepnutí blokuje', async () => {
    const { broker, controller } = await boot({ behavior: () => ({ kind: 'fill', price: 30_000 }) });
    try {
      controller.arm();
      const entry = order({ brokerOrderId: 'entry' });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      broker.setPosition(100, SYM, 1);
      broker.emitEvent({ type: 'order', order: { ...entry, status: 'filled', filledQuantity: 1, sourceVersion: '2' } });
      broker.emitEvent({ type: 'fill', fill: {
        fillId: 'f1', tag: '', brokerOrderId: 'entry', accountId: 100, symbol: SYM, side: 'Buy', quantity: 1, price: 30_000, filledAt: 1,
      } });
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 1 } });
      await controller.waitForIdle();
      expect((await broker.listPositions(200))[0]?.netQuantity).toBe(1);
      controller.disarm();
      await expect(controller.activateGroup(newGroup)).rejects.toThrow(/nonFlat=.*200/);
    } finally {
      controller.stop();
    }
  });

  it('pracovní příkaz kopírky na odcházejícím followerovi přepnutí blokuje', async () => {
    const { broker, controller } = await boot({ behavior: () => ({ kind: 'working' }) });
    try {
      controller.arm();
      broker.emitEvent({ type: 'order', order: order({ brokerOrderId: 'limit', orderType: 'Limit', limitPrice: 29_000 }) });
      await controller.waitForIdle();
      expect(broker.orders().some(item => item.accountId === 200 && item.status === 'working')).toBe(true);
      controller.disarm();
      await expect(controller.activateGroup(newGroup)).rejects.toThrow(/200/);
    } finally {
      controller.stop();
    }
  });

  // Codex review 5. 10.: kopie limitu se vyplní dřív než leader, leader nikdy
  // neměl expozici (žádná epocha) a ruční DISARM smaže liveCopyOpenSince.
  // Pozice followera je pořád kopie a nesmí se vydávat za ruční obchod.
  it('kopie vyplněná dřív než leader blokuje přepnutí i po ručním DISARM', async () => {
    const { broker, controller } = await boot({ behavior: () => ({ kind: 'fill', price: 29_000 }) });
    try {
      controller.arm();
      broker.emitEvent({ type: 'order', order: order({ brokerOrderId: 'limit', orderType: 'Limit', limitPrice: 29_000 }) });
      await controller.waitForIdle();
      expect((await broker.listPositions(200))[0]?.netQuantity).toBe(1);
      controller.disarm();
      await controller.waitForIdle();
      await expect(controller.activateGroup(newGroup)).rejects.toThrow(/nonFlat=.*200.*neověřenou kopii/);
    } finally {
      controller.stop();
    }
  });

  it('stopa kopie přežije restart workeru', async () => {
    const first = await boot({ behavior: () => ({ kind: 'fill', price: 29_000 }) });
    first.controller.arm();
    first.broker.emitEvent({ type: 'order', order: order({ brokerOrderId: 'limit', orderType: 'Limit', limitPrice: 29_000 }) });
    await first.controller.waitForIdle();
    first.controller.disarm();
    await first.controller.waitForIdle();
    first.controller.stop();
    const second = await boot(undefined, { broker: first.broker, store: first.store });
    try {
      await expect(second.controller.activateGroup(newGroup)).rejects.toThrow(/nonFlat=.*200/);
    } finally {
      second.controller.stop();
    }
  });

  it('po zavření kopie je nová ruční pozice zase věc uživatele', async () => {
    const { broker, controller } = await boot({ behavior: () => ({ kind: 'fill', price: 29_000 }) });
    try {
      controller.arm();
      broker.emitEvent({ type: 'order', order: order({ brokerOrderId: 'limit', orderType: 'Limit', limitPrice: 29_000 }) });
      await controller.waitForIdle();
      controller.disarm();
      await controller.waitForIdle();
      // Uživatel kopie ručně zavře a později otevře vlastní obchod.
      flatAt(broker, 200, 0);
      flatAt(broker, 300, 0);
      await controller.waitForIdle();
      await new Promise(resolve => setTimeout(resolve, 80));
      flatAt(broker, 200, 2);
      await controller.waitForIdle();
      await new Promise(resolve => setTimeout(resolve, 50));
      await controller.waitForIdle();
      await controller.activateGroup(newGroup);
      expect((await broker.listPositions(200))[0]?.netQuantity).toBe(2);
    } finally {
      controller.stop();
    }
  });

  // Codex review 5. 10. (2. a 3. kolo): Order=Filled s nulovým filledQuantity,
  // zastaralá Position=0 a teprve pak skutečná pozice; Fill nikde. Vlastnictví
  // plyne z odeslání a usadit ho smí jen autoritativní broker flat.
  it('kopie vlastní pozici i při pořadí Order(Filled, 0) → Position 0 → Position 1 bez Fill', async () => {
    const { broker, controller } = await boot({ behavior: () => ({ kind: 'working' }) });
    try {
      controller.arm();
      broker.emitEvent({ type: 'order', order: order({ brokerOrderId: 'limit', orderType: 'Limit', limitPrice: 29_000 }) });
      await controller.waitForIdle();
      const copy = broker.orders().find(item => item.accountId === 200 && item.status === 'working');
      const other = broker.orders().find(item => item.accountId === 300 && item.status === 'working');
      expect(copy && other).toBeTruthy();
      // Druhý follower: kopie se zruší, aby přepnutí blokoval jen účet 200.
      await broker.cancelOrder(300, other!.brokerOrderId);
      // U brokera už kopie nepracuje; stream hlásí Filled bez množství.
      await broker.cancelOrder(200, copy!.brokerOrderId);
      broker.emitEvent({ type: 'order', order: { ...copy!, status: 'filled', filledQuantity: 0, updatedAt: 99 } });
      broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: SYM, netQuantity: 0 } });
      flatAt(broker, 200, 1);
      await controller.waitForIdle();
      controller.disarm();
      await controller.waitForIdle();
      await new Promise(resolve => setTimeout(resolve, 80));
      await controller.waitForIdle();
      await expect(controller.activateGroup(newGroup)).rejects.toThrow(/nonFlat=.*200.*neověřenou kopii/);
    } finally {
      controller.stop();
    }
  });

  it('definitivně odmítnutá kopie pozdější ruční pozici neblokuje', async () => {
    const { broker, controller } = await boot({ behavior: () => ({ kind: 'reject', reason: 'risk' }) });
    try {
      controller.arm();
      broker.emitEvent({ type: 'order', order: order({ brokerOrderId: 'limit', orderType: 'Limit', limitPrice: 29_000 }) });
      await controller.waitForIdle();
      controller.disarm();
      await controller.waitForIdle();
      await new Promise(resolve => setTimeout(resolve, 80));
      await controller.waitForIdle();
      flatAt(broker, 200, 2);
      await controller.waitForIdle();
      await new Promise(resolve => setTimeout(resolve, 50));
      await controller.waitForIdle();
      await controller.activateGroup(newGroup);
      expect((await broker.listPositions(200))[0]?.netQuantity).toBe(2);
    } finally {
      controller.stop();
    }
  });

  it('ruční pozice hned po zavření kopie počká, než kopírka ověří její konec', async () => {
    let now = 1_000_000;
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 29_000 }) });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: oldGroup, clock: () => ++now,
      followerTransitionCorrelationWindowMs: 10,
      copierSettlementQuietMs: 5,
      copierSettlementMinAgeMs: 0,
      // Reálný čas tu měří vlastní clock testu; 10⁹ tiků se nedosáhne.
      copierSettlementTerminalAgeMs: 1_000_000_000,
    });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      broker.emitEvent({ type: 'order', order: order({ brokerOrderId: 'limit', orderType: 'Limit', limitPrice: 29_000 }) });
      await controller.waitForIdle();
      controller.disarm();
      flatAt(broker, 200, 0);
      flatAt(broker, 300, 0);
      await controller.waitForIdle();
      await new Promise(resolve => setTimeout(resolve, 80));
      flatAt(broker, 200, 2);
      await controller.waitForIdle();
      await new Promise(resolve => setTimeout(resolve, 50));
      await controller.waitForIdle();
      await expect(controller.activateGroup(newGroup)).rejects.toThrow(/neověřenou kopii/);
    } finally {
      controller.stop();
    }
  });

  it('obchodní událost během zápisu usazení usazení vrátí', async () => {
    let now = 1_000_000;
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 29_000 }) });
    const inner = createMemoryCopierStore();
    let injected = false;
    let afterInjected: number | null = null;
    const store = {
      load: () => inner.load(),
      async commit(snapshot: Parameters<typeof inner.commit>[0], revision: number) {
        if (injected && afterInjected == null) afterInjected = snapshot.safety?.settledCopierEntries?.length ?? 0;
        if (!injected && (snapshot.safety?.settledCopierEntries?.length ?? 0) > 0) {
          injected = true;
          // Opožděná projekce dorazí přesně během durable zápisu.
          broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: SYM, netQuantity: 0 } });
        }
        return inner.commit(snapshot, revision);
      },
    };
    const controller = await bootstrapCopierRuntime({
      broker, store, group: oldGroup, clock: () => ++now,
      followerTransitionCorrelationWindowMs: 10,
      copierSettlementQuietMs: 5,
      copierSettlementMinAgeMs: 0,
      copierSettlementTerminalAgeMs: 0,
    });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      broker.emitEvent({ type: 'order', order: order({ brokerOrderId: 'limit', orderType: 'Limit', limitPrice: 29_000 }) });
      await controller.waitForIdle();
      controller.disarm();
      flatAt(broker, 200, 0);
      await controller.waitForIdle();
      await new Promise(resolve => setTimeout(resolve, 120));
      await controller.waitForIdle();
      expect(injected).toBe(true);
      // Hned následující zápis usazení vrátil (pozdější nové ověření smí znovu usadit).
      expect(afterInjected).toBe(0);
    } finally {
      controller.stop();
    }
  });

  it('obchodní změna odcházejícího účtu během zápisu přepnutí nezapadne', async () => {
    let now = 1_000_000;
    const broker = createMockBroker();
    const inner = createMemoryCopierStore();
    let switching = false;
    const store = {
      load: () => inner.load(),
      async commit(snapshot: Parameters<typeof inner.commit>[0], revision: number) {
        if (switching) {
          switching = false;
          broker.emitEvent({ type: 'position', position: { accountId: 200, symbol: SYM, netQuantity: 1 } });
        }
        return inner.commit(snapshot, revision);
      },
    };
    const audits: string[] = [];
    const controller = await bootstrapCopierRuntime({
      broker, store, group: oldGroup, clock: () => ++now, followerTransitionCorrelationWindowMs: 10,
      onAudit: entries => { for (const entry of entries) audits.push(entry.reason ?? ''); },
    });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      await controller.waitForIdle();
      await new Promise(resolve => setTimeout(resolve, 50));
      await controller.waitForIdle();
      switching = true;
      await controller.activateGroup(newGroup);
      await controller.waitForIdle();
      expect(controller.status().reconciliationRequired).toBe(true);
      expect(audits.some(reason => /odcházejících účtech 200/.test(reason))).toBe(true);
      expect(controller.status().lastError).toMatch(/odcházejících účtech 200/);
    } finally {
      controller.stop();
    }
  });
});
