import { describe, expect, it } from 'vitest';
import type { BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import type { CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from './_laMock';

const SYM = 'MNQU6';
const group: CopyGroupConfig = {
  id: 'probe-a3', name: 'probe A3', enabled: true, leaderAccountId: 100,
  followers: [
    { accountId: 200, mode: 'on-submit', multiplier: 1 },
    { accountId: 300, mode: 'on-fill', multiplier: 1 },
  ],
};
const order = (patch: Partial<BrokerOrder> = {}): BrokerOrder => ({
  tag: '', brokerOrderId: 'leader-order', accountId: 100, symbol: SYM, side: 'Buy',
  orderType: 'Market', quantity: 2, filledQuantity: 0,
  status: 'working', sourceVersion: '1:Working', updatedAt: 1, ...patch,
});

// Ověřovací review 30. 9.: odložený fail-closed zpožděného limitního reversalu
// (kvůli on-fill followerovi) nechal kopírku ARMED a změna ceny leadera by
// přepočítala exit-only kopii on-submit followera na celý reversal (Sell 4).
// Replace takového orderu teď vypne kopírku ještě před dispatchem.
describe('A3: zpožděný limitní reversal ve smíšené skupině a změna ceny', () => {
  it.each(['replace', 'none'] as const)('%s', async variant => {
    let now = 1_000_000;
    const clock = () => ++now;
    const broker: any = createMockBroker({ behavior: r => r.orderType === 'Market' ? { kind: 'fill', price: 30_500 } : { kind: 'working' } });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group, clock,
    });
    const pos = async (a: number) => (await broker.listPositions(a)).find((p: any) => p.symbol === SYM)?.netQuantity ?? 0;
    const tick = async () => { now += 5_000; broker.emitEvent({ type: 'heartbeat', at: now }); await controller.waitForIdle(); await new Promise(r => setTimeout(r, 20)); };
    try {
      broker.setConnected(true);
      await controller.waitForIdle();
      await controller.reconcile();
      controller.arm();
      const entry = order({ brokerOrderId: 'entry' });
      broker.emitEvent({ type: 'order', order: entry });
      await controller.waitForIdle();
      broker.emitEvent({ type: 'order', order: { ...entry, status: 'filled', filledQuantity: 2, sourceVersion: 'f' } });
      broker.emitEvent({ type: 'fill', fill: { fillId: 'ef', tag: '', brokerOrderId: 'entry', accountId: 100, symbol: SYM, side: 'Buy', quantity: 2, price: 30_500, filledAt: 1 } });
      broker.setPosition(100, SYM, 2);
      broker.emitEvent({ type: 'position', position: { accountId: 100, symbol: SYM, netQuantity: 2 } });
      await controller.waitForIdle();
      await tick();
      expect(await pos(200)).toBe(2);
      expect(await pos(300)).toBe(2);
      const rev = order({ brokerOrderId: 'rev', side: 'Sell', quantity: 4, orderType: 'Limit', limitPrice: 30_600 });
      broker.emitEvent({ type: 'order', order: rev, receivedAt: now - 6_000 } as any);
      await controller.waitForIdle();
      await tick();
      const w200 = () => broker.orders().filter((o: BrokerOrder) => o.accountId === 200 && o.status === 'working').map((o: BrokerOrder) => `${o.side}${o.quantity}@${o.limitPrice}`);
      expect(w200()).toEqual(['Sell2@30600']);
      if (variant === 'replace') {
        broker.emitEvent({ type: 'order', order: { ...rev, limitPrice: 30_650, sourceVersion: '2:Working', updatedAt: 2 } });
        await controller.waitForIdle();
        await tick();
      }
      for (let i = 0; i < 3; i += 1) await tick();
      // Exit-only kopie on-submit followera se nikdy nepřepočítá na vstup.
      expect(w200().every((s: string) => s.startsWith('Sell2'))).toBe(true);
      expect(broker.modifyRequests()).toEqual([]);
      // Bez změny ceny kopírka čeká na fill kvůli exitu on-fill followera.
      expect(controller.status().armed).toBe(variant === 'none');
    } finally {
      controller.stop();
    }
  });
});
