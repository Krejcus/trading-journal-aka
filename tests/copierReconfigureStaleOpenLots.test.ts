import { describe, expect, it } from 'vitest';
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
      realizedPnlUsd: 0,
      losingTrades: 0,
      openLots: [{
        episodeId: 'stale', symbol: 'MNQU6', netQuantity: -3, avgPrice: 29_141.5,
        tradePnlUsd: 0, tradePnlPoints: 0, openedAt: now - 60_000, side: 'Short',
      }],
      recentClosedTrades: [],
      unpricedSymbols: [],
    },
  };
  const broker = createMockBroker({ behavior: () => ({ kind: 'working' }) });
  const controller = await bootstrapCopierRuntime({
    broker, store: createMemoryCopierStore(initial), group, clock: () => now,
    wait: async () => undefined,
  });
  broker.setConnected(true);
  await controller.waitForIdle();
  await controller.reconcile();
  return controller;
};

describe('brána změny skupiny a durable openLots', () => {
  it('lot z už skončené session změnu skupiny neblokuje', async () => {
    const now = Date.UTC(2026, 8, 3, 7, 0, 0);
    const controller = await harness(now - 3_600_000, now);
    await expect(controller.reconfigureGroup(nextGroup)).resolves.toBeUndefined();
    controller.stop();
  });

  it('lot z běžící session změnu skupiny dál blokuje', async () => {
    const now = Date.UTC(2026, 8, 3, 7, 0, 0);
    const controller = await harness(now + 3_600_000, now);
    await expect(controller.reconfigureGroup(nextGroup))
      .rejects.toThrow('otevřená durable pozice leadera');
    controller.stop();
  });
});
