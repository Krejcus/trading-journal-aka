import { describe, expect, it, vi } from 'vitest';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMockBroker } from '../services/mockBroker';
import { createMemoryCopierStore, emptySnapshot } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

/**
 * 3. 9. 2026 09:00: „Změnu leadera blokuje otevřená durable pozice leadera“,
 * přestože broker hlásil všechny účty flat. V denní statistice visel zbytkový
 * lot z předchozí session (18:44 předchozího dne) a brána změny skupiny četla
 * uložené `openLots` bez ohledu na hranici session (17:00 CT).
 */

const group: CopyGroupConfig = {
  id: 'g-lots', name: 'Lots', enabled: true, leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    { accountId: 201, mode: 'on-submit', multiplier: 1 },
  ],
};
const nextGroup: CopyGroupConfig = {
  ...group,
  followers: group.followers.filter(follower => follower.accountId !== 201),
};

const harness = async (sessionEndAt: number, now: number) => {
  const initial = emptySnapshot();
  initial.safety = {
    entryCooldownUntil: 0,
    dayLockUntil: 0,
    dailyStats: {
      sessionEndAt,
      realizedPnlUsd: -507,
      losingTrades: 1,
      tradesToday: 1,
      openLots: [{
        episodeId: 'stale', symbol: 'MNQU6', netQuantity: -3, avgPrice: 29_141.5,
        tradePnlUsd: 0, tradePnlPoints: 0, openedAt: now - 60_000, side: 'Short',
      }],
      recentClosedTrades: [],
      unpricedSymbols: [],
    },
  };
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }), nativeLiquidate: true });
  const store = createMemoryCopierStore(initial);
  const controller = await bootstrapCopierRuntime({
    broker, store, group, clock: () => now,
    wait: async () => undefined,
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  return { controller, broker, store };
};

describe('brána změny skupiny a durable openLots', () => {
  it('lot z už skončené session změnu skupiny neblokuje', async () => {
    const now = Date.UTC(2026, 8, 3, 7, 0, 0);
    const { controller } = await harness(now - 3_600_000, now);
    await expect(controller.reconfigureGroup(nextGroup)).resolves.toBeUndefined();
    controller.stop();
  });

  it('flat snapshot archivuje současný lot bez vymyšleného P&L a zůstane DISARMED', async () => {
    const now = Date.UTC(2026, 8, 3, 7, 0, 0);
    const { controller, broker, store } = await harness(now + 3_600_000, now);
    const place = vi.spyOn(broker, 'placeOrder');
    const cancel = vi.spyOn(broker, 'cancelOrder');
    try {
      await expect(controller.reconfigureGroup(nextGroup)).resolves.toBeUndefined();
      const stats = (await store.load()).safety.dailyStats!;
      expect(stats.openLots).toEqual([]);
      expect(stats.unconfirmedFlatLots).toEqual([expect.objectContaining({
        episodeId: 'stale', netQuantity: -3, confirmedFlatAt: now, leaderAccountId: 100,
      })]);
      expect(stats.realizedPnlUsd).toBe(-507);
      expect(stats.losingTrades).toBe(1);
      expect(stats.tradesToday).toBe(1);
      expect(stats.recentClosedTrades).toEqual([]);
      expect(controller.status().armed).toBe(false);
      await controller.reconcile();
      expect(() => controller.arm({ shadowMode: false })).toThrow('nepotvrzený výsledek uzavření');
      expect(place).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(broker.liquidateRequests()).toEqual([]);
    } finally { controller.stop(); }
  });

  it.each([100, 200, 201])('skutečná pozice účtu %s stále blokuje obnovu', async accountId => {
    const now = Date.UTC(2026, 8, 3, 7);
    const { controller, broker, store } = await harness(now + 3_600_000, now);
    broker.setPosition(accountId, 'MNQU6', -3);
    try {
      await expect(controller.reconfigureGroup(nextGroup)).rejects.toThrow('flat a bez příkazů');
      expect((await store.load()).safety.dailyStats!.openLots).toHaveLength(1);
      expect(controller.status().armed).toBe(false);
    } finally { controller.stop(); }
  });

  it('neúspěšné čtení nesmí vypadat jako flat', async () => {
    const now = Date.UTC(2026, 8, 3, 7);
    const { controller, broker, store } = await harness(now + 3_600_000, now);
    vi.spyOn(broker, 'listPositions').mockRejectedValue(new Error('read unavailable'));
    try {
      await expect(controller.reconfigureGroup(nextGroup)).rejects.toThrow('read unavailable');
      expect((await store.load()).safety.dailyStats!.openLots).toHaveLength(1);
    } finally { controller.stop(); }
  });

  it('broker event během preflightu zneplatní obnovu', async () => {
    const now = Date.UTC(2026, 8, 3, 7);
    const { controller, broker, store } = await harness(now + 3_600_000, now);
    vi.spyOn(broker, 'listPositions').mockImplementationOnce(async () => {
      broker.emitEvent({ type: 'connection', connected: false, at: now });
      return [];
    });
    try {
      await expect(controller.reconfigureGroup(nextGroup)).rejects.toThrow('během kontroly');
      expect((await store.load()).safety.dailyStats!.openLots).toHaveLength(1);
    } finally { controller.stop(); }
  });

  it('working příkaz blokuje obnovu i při nulové pozici', async () => {
    const now = Date.UTC(2026, 8, 3, 7);
    const { controller, broker, store } = await harness(now + 3_600_000, now);
    vi.spyOn(broker, 'listOrders').mockResolvedValue([{
      brokerOrderId: 'pending', accountId: 200, symbol: 'MNQU6', side: 'Buy',
      orderType: 'Limit', quantity: 1, filledQuantity: 0, status: 'working',
      updatedAt: now, tag: '',
    }]);
    try {
      await expect(controller.reconfigureGroup(nextGroup)).rejects.toThrow('working=');
      expect((await store.load()).safety.dailyStats!.openLots).toHaveLength(1);
      expect(broker.liquidateRequests()).toEqual([]);
    } finally { controller.stop(); }
  });

  it('chybějící capability není důkaz flat', async () => {
    const now = Date.UTC(2026, 8, 3, 7);
    const { controller, broker, store } = await harness(now + 3_600_000, now);
    vi.spyOn(broker, 'listAccountCapabilities').mockResolvedValue([]);
    try {
      await expect(controller.reconfigureGroup(nextGroup)).rejects.toThrow('neaktivní/read-only');
      expect((await store.load()).safety.dailyStats!.openLots).toHaveLength(1);
    } finally { controller.stop(); }
  });

  it('selhání durable zápisu zachová původní loty', async () => {
    const now = Date.UTC(2026, 8, 3, 7);
    const { controller, store } = await harness(now + 3_600_000, now);
    vi.spyOn(store, 'commit').mockRejectedValueOnce(new Error('disk unavailable'));
    try {
      await expect(controller.reconfigureGroup(nextGroup)).rejects.toThrow('disk unavailable');
      expect((await store.load()).safety.dailyStats!.openLots).toHaveLength(1);
      expect((await store.load()).safety.dailyStats!.unconfirmedFlatLots).toBeUndefined();
      expect(controller.status().armed).toBe(false);
    } finally { controller.stop(); }
  });

  it('restart zachová archiv a ochranu před ARM v téže session', async () => {
    const now = Date.UTC(2026, 8, 3, 7);
    const { controller, broker, store } = await harness(now + 3_600_000, now);
    await controller.reconfigureGroup(nextGroup);
    controller.stop();
    const restarted = await bootstrapCopierRuntime({ broker, store, group: nextGroup, clock: () => now, wait: async () => undefined });
    try {
      broker.setConnected(true);
      await restarted.waitForIdle();
      await restarted.reconcile();
      expect((await store.load()).safety.dailyStats!.unconfirmedFlatLots).toHaveLength(1);
      expect(() => restarted.arm({ shadowMode: false })).toThrow('nepotvrzený výsledek uzavření');
      expect(broker.liquidateRequests()).toEqual([]);
    } finally { restarted.stop(); }
  });
});
