import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createLeaderAwareMockBroker } from './leaderAwareMock';

// V4 (kontrola 12. 10. 2026): samostatný SL leadera, který bracket korelátor
// drží do 1,5 s po vstupu, jde přes flushStandaloneBracketStop pro celou
// skupinu. Když čtení čekajícího followera skončí neověřené, ověření
// followeři SL dostat musí; kopírka se vypne až potom.

const SYM = 'MNQZ6';
const group: CopyGroupConfig = {
  id: 'g-v4', name: 'V4', enabled: true, leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    { accountId: 300, mode: 'on-submit', multiplier: 1 },
  ],
};
const leaderOrder = (partial: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-entry', accountId: 100, symbol: SYM, side: 'Buy',
  orderType: 'Limit', quantity: 5, filledQuantity: 0, limitPrice: 30_000,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1, ...partial,
});
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('samostatný SL leadera vedle čekajícího followera (V4)', () => {
  it('neověřený čekající follower nezdrží SL ověřenému followerovi', async () => {
    // Kopie vstupu se followerovi 300 vyplní hned, followerovi 200 zůstane v knize.
    const broker = createLeaderAwareMockBroker({
      behavior: request => request.accountId === 300 && request.side === 'Buy'
        ? { kind: 'fill', price: 30_000 }
        : { kind: 'working' },
    });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock: Date.now,
      followerTransitionCorrelationWindowMs: 20,
    });
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();

      const entry = leaderOrder();
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      await pause(50);
      await controller.waitForIdle();
      expect(broker.placedRequests().map(request => request.accountId).sort()).toEqual([200, 300]);

      broker.emitEvent({ type: 'order', order: { ...entry, status: 'filled', filledQuantity: 5, sourceVersion: '2:Filled' } });
      broker.emitEvent({ type: 'fill', fill: {
        fillId: 'leader-fill', tag: '', brokerOrderId: entry.brokerOrderId, accountId: 100, symbol: SYM,
        side: 'Buy', quantity: 5, price: 30_000, filledAt: Date.now(),
      } });
      broker.setPosition(100, SYM, 5);
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 5 } });
      await controller.waitForIdle();
      await pause(50);
      await controller.waitForIdle();
      expect(controller.status()).toMatchObject({ armed: true, lastError: null });

      // Čtení čekající kopie followera 200 od teď selhává → S1b neověřeno.
      const findOrderById = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId: number, brokerOrderId: string) => {
        if (accountId === 200) throw new Error('REST timeout');
        return findOrderById(accountId, brokerOrderId);
      };
      // SL nad vstupem followera 200 (30000): mohl by se vyplnit dřív než jeho vstup.
      broker.emitEvent({ type: 'order', order: leaderOrder({
        brokerOrderId: 'leader-stop', side: 'Sell', orderType: 'Stop', limitPrice: undefined, stopPrice: 30_010,
      }) });
      await controller.waitForIdle();
      // Bracket okno 1,5 s; flush pak čeká na neověřené S1b čtení.
      await pause(1_850);
      broker.emitEvent({ type: 'heartbeat', at: Date.now() });
      await controller.waitForIdle();

      expect(broker.placedRequests()).toContainEqual(expect.objectContaining({
        accountId: 300, side: 'Sell', orderType: 'Stop', stopPrice: 30_010, quantity: 5,
      }));
      expect(broker.placedRequests().some(request => request.accountId === 200 && request.side === 'Sell')).toBe(false);
      // Příčina vypnutí zůstává v záznamu DISARM (lastError může přepsat následný auto-close).
      expect(controller.status()).toMatchObject({
        armed: false,
        lastDisarm: expect.objectContaining({
          detail: expect.stringContaining('Samostatný SL: neověřená follower expozice (účty 200)'),
        }),
      });
    } finally {
      controller.stop();
    }
  }, 30_000);
});
