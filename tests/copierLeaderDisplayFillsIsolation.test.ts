import { describe, expect, it, vi } from 'vitest';

// Rozbitá zobrazovací vrstva šipek nesmí změnit kopírování (INV-WORKER-04).
const calls = vi.hoisted(() => ({ markGap: 0, reset: 0 }));
vi.mock('../services/copierLeaderDisplayFills', () => ({
  createLeaderDisplayFills: () => ({
    observe: () => { throw new Error('rozbité šipky'); },
    setEpisodeId: () => { throw new Error('rozbité šipky'); },
    markGap: () => { calls.markGap += 1; throw new Error('rozbité šipky'); },
    reset: () => { calls.reset += 1; throw new Error('rozbité šipky'); },
    snapshot: () => { throw new Error('rozbité šipky'); },
  }),
}));

const { bootstrapCopierRuntime } = await import('../services/copierRuntimeController');
const { createMemoryCopierStore } = await import('../services/copierStore');
const { createMockBroker } = await import('../services/mockBroker');
const { cloneDayRuleActions, DEFAULT_COPY_GROUP_SAFETY } = await import('../services/liveCopyTrading');

describe('výjimka ve šipkách plnění', () => {
  it('fill leadera se dál kopíruje, status má leaderFills null, chyba jde do onError (nejvýš 3×)', async () => {
    let now = Date.parse('2026-09-08T16:00:00.000Z');
    const clock = () => now;
    const onError = vi.fn();
    const broker = createMockBroker({ clock, behavior: () => ({ kind: 'fill', price: 20_000 }) });
    const group = {
      id: 'fills-iso', name: 'Iso', enabled: true, leaderAccountId: 100,
      followers: [{ accountId: 200, mode: 'on-fill' as const, multiplier: 1 }],
      safety: { ...DEFAULT_COPY_GROUP_SAFETY, dailyLossLimitUsd: 0, dailyMaxLosingTrades: 0, dailyMaxTrades: 0, entryCooldownMinutes: 0,
        tradingWindow: { enabled: false, from: '15:30', to: '22:00', timeZone: 'Europe/Prague' },
        dayRuleActions: cloneDayRuleActions(DEFAULT_COPY_GROUP_SAFETY.dayRuleActions) },
    };
    const runtime = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), clock, onError, wait: async () => undefined, group, leaderFlatGraceMs: 5,
    });
    broker.setConnected(true);
    await runtime.waitForIdle();
    await runtime.reconcile();
    runtime.arm();
    await runtime.waitForIdle();
    try {
      for (let i = 1; i <= 4; i += 1) {
        now += 1_000;
        broker.emitEvent({ type: 'fill', fill: { fillId: `iso${i}`, tag: '', brokerOrderId: `lo${i}`, accountId: 100, symbol: 'MNQU6', side: i % 2 ? 'Buy' : 'Sell', quantity: 1, price: 20_000, filledAt: now } });
        broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: 'MNQU6', netQuantity: i % 2 } });
        await runtime.waitForIdle();
      }
      expect(broker.placedRequests().filter(request => request.accountId === 200)).toHaveLength(4);
      const status = runtime.status();
      expect(status.armed).toBe(true);
      expect(status.leaderFills).toBeNull();
      const displayErrors = onError.mock.calls.filter(([error]) => String((error as Error).message).startsWith('Šipky plnění (jen zobrazení)'));
      expect(displayErrors.length).toBeGreaterThan(0);
      expect(displayErrors.length).toBeLessThanOrEqual(3);

      // Odpojení (markGap) ani přelom risk seance a změna skupiny (reset) kvůli šipkám nespadnou.
      broker.setConnected(false);
      await runtime.waitForIdle();
      // Cesta se opravdu prošla (strop onError je už vyčerpaný z observe).
      expect(calls.markGap).toBeGreaterThan(0);
      broker.setConnected(true);
      await runtime.waitForIdle();
      const resetsBefore = calls.reset;
      now += 26 * 3_600_000;
      broker.emitEvent({ type: 'heartbeat', at: now });
      await runtime.waitForIdle();
      expect(runtime.status().lastError ?? '').not.toMatch(/Šipky/);
      expect(calls.reset).toBeGreaterThan(resetsBefore);
      const resetsBeforeGroup = calls.reset;
      broker.setPosition(100, 'MNQU6', 0);
      broker.setPosition(200, 'MNQU6', 0);
      // Pojistka po flat leadera (skutečný časovač) musí doběhnout, jinak změnu skupiny správně blokuje.
      await new Promise(resolve => setTimeout(resolve, 50));
      await runtime.waitForIdle();
      await expect(runtime.reconfigureGroup(group)).resolves.toBeUndefined();
      expect(calls.reset).toBeGreaterThan(resetsBeforeGroup);
      expect(runtime.status().lastError ?? '').not.toMatch(/Šipky/);
      expect(onError.mock.calls.filter(([error]) => String((error as Error).message).startsWith('Šipky plnění')).length).toBeLessThanOrEqual(3);
    } finally {
      runtime.stop();
    }
  });
});
